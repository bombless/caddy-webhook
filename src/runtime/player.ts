import { envelope, isEnvelope, type Envelope } from './protocol'
import { loadManifest } from './manifest'

export type PlayerState = 'loading' | 'ready' | 'running' | 'paused' | 'ended' | 'disposed' | 'error'
export interface PlayerOptions {
  timeoutMs?: number
  allowedCapabilities?: string[]
  gameOrigin?: string
  onScore?: (score: number) => void
  onState?: (state: PlayerState) => void
  onError?: (error: Error) => void
}

const MAX_MESSAGE_BYTES = 16_384
const MAX_SCORE = 1_000_000_000
const STORAGE_KEY = /^[a-zA-Z0-9_.:-]{1,64}$/
const STORAGE_VALUE_BYTES = 8 * 1024
const STORAGE_NAMESPACE_BYTES = 64 * 1024

export class GamePlayerRuntime {
  readonly iframe: HTMLIFrameElement
  readonly instanceId: string
  state: PlayerState = 'loading'
  private options: PlayerOptions
  private timer?: number
  private targetOrigin = '*'
  private storagePrefix = ''
  private messageListener: (event: MessageEvent) => void
  private disposed = false

  constructor(iframe: HTMLIFrameElement, options: PlayerOptions = {}) {
    this.iframe = iframe
    this.options = options
    this.instanceId = crypto.randomUUID() + crypto.randomUUID()
    this.messageListener = (event) => this.receive(event)
    window.addEventListener('message', this.messageListener)
  }

  private setState(state: PlayerState) {
    this.state = state
    this.options.onState?.(state)
  }

  async load(url: string) {
    try {
      const { manifest, packageUrl } = await loadManifest(url)
      const allowed = new Set(this.options.allowedCapabilities ?? ['input.keyboard', 'input.pointer', 'score', 'storage'])
      const capabilities = manifest.runtime.capabilities.filter((cap) => allowed.has(cap))
      this.storagePrefix = `bombless-game:${manifest.id}:`
      const entry = new URL(manifest.entry, packageUrl)
      if (entry.origin !== packageUrl.origin || !entry.pathname.startsWith(packageUrl.pathname)) throw new Error('Plugin entry escapes package')
      const gameOrigin = this.options.gameOrigin ? new URL(this.options.gameOrigin).origin : undefined
      if (gameOrigin && (gameOrigin !== entry.origin || gameOrigin === window.location.origin)) {
        throw new Error('gameOrigin must match the plugin origin and differ from the host origin')
      }
      this.targetOrigin = gameOrigin ?? '*'
      this.iframe.setAttribute('sandbox', gameOrigin ? 'allow-scripts allow-same-origin' : 'allow-scripts')
      this.iframe.referrerPolicy = 'no-referrer'
      this.iframe.title = manifest.name
      this.iframe.addEventListener('load', () => {
        if (this.disposed) return
        this.iframe.contentWindow?.postMessage(envelope(this.instanceId, 'HOST_INIT', {
          apiVersion: '1', packageUrl: packageUrl.href, capabilities,
          viewport: { width: this.iframe.clientWidth, height: this.iframe.clientHeight },
        }), this.targetOrigin)
      }, { once: true })
      this.iframe.src = entry.href
      this.timer = window.setTimeout(() => this.fail(new Error('Game loading timed out')), this.options.timeoutMs ?? 15_000)
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))) }
  }

  private receive(event: MessageEvent) {
    if (this.disposed || event.source !== this.iframe.contentWindow || !isEnvelope(event.data)) return
    const message = event.data as Envelope
    if (message.instanceId !== this.instanceId) return
    if (this.options.gameOrigin && event.origin !== new URL(this.options.gameOrigin).origin) return
    if (JSON.stringify(message).length > MAX_MESSAGE_BYTES) return
    switch (message.type) {
      case 'GAME_READY':
        if (this.timer) clearTimeout(this.timer)
        this.setState('ready')
        break
      case 'GAME_ERROR':
        this.fail(new Error(typeof message.payload.message === 'string' ? message.payload.message.slice(0, 500) : 'Game component contract failed'))
        break
      case 'SCORE_UPDATE': {
        const score = message.payload.score
        if (typeof score === 'number' && Number.isSafeInteger(score) && score >= 0 && score <= MAX_SCORE) this.options.onScore?.(score)
        break
      }
      case 'GAME_PAUSE': this.setState('paused'); break
      case 'GAME_RESUME': this.setState('running'); break
      case 'GAME_OVER': this.setState('ended'); break
      case 'AUDIO_PLAY':
        if (message.requestId) this.reply(message.requestId, false, undefined, 'audio_unavailable')
        break
      case 'STORAGE_GET':
      case 'STORAGE_SET':
        if (message.requestId) void this.handleStorage(message)
        break
    }
  }

  private async handleStorage(message: Envelope) {
    const id = message.requestId!
    const key = message.payload.key
    if (typeof key !== 'string' || !STORAGE_KEY.test(key)) {
      this.reply(id, false, undefined, 'invalid_storage_key')
      return
    }
    const fullKey = this.storagePrefix + key
    try {
      if (message.type === 'STORAGE_GET') {
        const raw = localStorage.getItem(fullKey)
        this.reply(id, true, raw === null ? undefined : JSON.parse(raw))
        return
      }
      const serialized = JSON.stringify(message.payload.value)
      if (serialized === undefined) throw new Error('value_not_serializable')
      const bytes = new TextEncoder().encode(serialized).byteLength
      if (bytes > STORAGE_VALUE_BYTES) throw new Error('value_too_large')
      let used = 0
      for (let i = 0; i < localStorage.length; i++) {
        const existingKey = localStorage.key(i)
        if (existingKey?.startsWith(this.storagePrefix)) {
          const existingValue = localStorage.getItem(existingKey) ?? ''
          used += new TextEncoder().encode(existingKey + existingValue).byteLength
        }
      }
      const old = localStorage.getItem(fullKey)
      const oldBytes = old === null ? 0 : new TextEncoder().encode(fullKey + old).byteLength
      const newBytes = new TextEncoder().encode(fullKey + serialized).byteLength
      if (used - oldBytes + newBytes > STORAGE_NAMESPACE_BYTES) throw new Error('storage_quota_exceeded')
      localStorage.setItem(fullKey, serialized)
      this.reply(id, true, true)
    } catch (error) {
      this.reply(id, false, undefined, error instanceof Error ? error.message : 'storage_unavailable')
    }
  }

  private reply(id: string, ok: boolean, value?: unknown, error?: string) {
    this.iframe.contentWindow?.postMessage(envelope(this.instanceId, 'HOST_RESPONSE', { ok, value, error }, id), this.targetOrigin)
  }
  resize() {
    if (this.state !== 'disposed' && this.state !== 'error') this.send('VIEWPORT_RESIZE', { width: this.iframe.clientWidth, height: this.iframe.clientHeight })
  }
  start() {
    if (this.state !== 'ready' && this.state !== 'paused') return
    this.send('HOST_START', {})
    this.setState('running')
  }
  pause() {
    if (this.state !== 'running') return
    this.send('HOST_PAUSE', {})
    this.setState('paused')
  }
  resume() {
    if (this.state !== 'paused') return
    this.send('HOST_RESUME', {})
    this.setState('running')
  }
  end(result?: unknown) {
    if (this.state !== 'running' && this.state !== 'paused') return
    this.send('HOST_END', { result })
    this.setState('ended')
  }
  private send(type: string, payload: Record<string, unknown>) {
    this.iframe.contentWindow?.postMessage(envelope(this.instanceId, type, payload), this.targetOrigin)
  }
  private fail(error: Error) {
    if (this.disposed) return
    if (this.timer) clearTimeout(this.timer)
    this.setState('error')
    this.options.onError?.(error)
  }
  dispose() {
    if (this.disposed) return
    this.send('HOST_DISPOSE', {})
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    window.removeEventListener('message', this.messageListener)
    this.iframe.src = 'about:blank'
    this.setState('disposed')
  }
}
