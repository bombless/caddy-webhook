import { envelope, isEnvelope, type Envelope } from './protocol.ts'
import { loadManifest, type PluginManifest } from './manifest.ts'

export type PlayerState = 'loading' | 'ready' | 'running' | 'paused' | 'ended' | 'disposed' | 'error'
export interface PlayerOptions {
  timeoutMs?: number
  allowedCapabilities?: string[]
  gameOrigin?: string
  runnerUrl?: string
  onScore?: (score: number) => void
  onState?: (state: PlayerState) => void
  onError?: (error: Error) => void
}

const MAX_MESSAGE_BYTES = 16_384
const MAX_SCORE = 1_000_000_000

export class GamePlayerRuntime {
  readonly iframe: HTMLIFrameElement
  readonly instanceId: string
  state: PlayerState = 'loading'
  private options: PlayerOptions
  private timer?: number
  private targetOrigin = '*'
  private messageListener: (event: MessageEvent) => void
  private disposed = false
  private manifest?: PluginManifest
  private inMemoryStorage = new Map<string, string>()

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
      this.manifest = manifest
      const allowed = new Set(this.options.allowedCapabilities ?? ['input.keyboard', 'input.pointer', 'score', 'storage'])
      const capabilities = manifest.runtime.capabilities.filter((cap) => allowed.has(cap))
      const entry = new URL(manifest.entry, packageUrl)
      if (entry.origin !== packageUrl.origin || !entry.pathname.startsWith(packageUrl.pathname)) {
        throw new Error('Plugin entry escapes package')
      }
      const runnerUrl = new URL(this.options.runnerUrl ?? 'runner.html', window.location.href)
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
          apiVersion: '1',
          packageUrl: packageUrl.href,
          entry: manifest.entry,
          capabilities,
          manifest,
          viewport: { width: this.iframe.clientWidth, height: this.iframe.clientHeight },
        }), this.targetOrigin)
      }, { once: true })
      this.iframe.src = runnerUrl.href
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
        this.setState('running')
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
      case 'STORAGE_GET': {
        const key = message.payload.key
        if (typeof key !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(key)) {
          if (message.requestId) this.reply(message.requestId, false, undefined, 'invalid_key')
          break
        }
        const gameId = this.manifest?.id ?? 'game'
        const storageKey = `bombless_game_storage:${gameId}:${key}`
        let val: unknown = null
        try {
          const raw = typeof window !== 'undefined' && window.localStorage ? window.localStorage.getItem(storageKey) : this.inMemoryStorage.get(storageKey)
          val = raw !== null && raw !== undefined ? JSON.parse(raw) : null
        } catch {
          val = this.inMemoryStorage.get(storageKey) ?? null
        }
        if (message.requestId) this.reply(message.requestId, true, val)
        break
      }
      case 'STORAGE_SET': {
        const { key, value } = message.payload
        if (typeof key !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(key)) {
          if (message.requestId) this.reply(message.requestId, false, undefined, 'invalid_key')
          break
        }
        const gameId = this.manifest?.id ?? 'game'
        const storageKey = `bombless_game_storage:${gameId}:${key}`
        try {
          const serialized = JSON.stringify(value)
          if (serialized.length > 256 * 1024) {
            if (message.requestId) this.reply(message.requestId, false, undefined, 'quota_exceeded')
            break
          }
          if (typeof window !== 'undefined' && window.localStorage) {
            window.localStorage.setItem(storageKey, serialized)
          }
          this.inMemoryStorage.set(storageKey, serialized)
          if (message.requestId) this.reply(message.requestId, true)
        } catch {
          this.inMemoryStorage.set(storageKey, JSON.stringify(value))
          if (message.requestId) this.reply(message.requestId, true)
        }
        break
      }
      case 'STORAGE_DELETE': {
        const key = message.payload.key
        const gameId = this.manifest?.id ?? 'game'
        const storageKey = `bombless_game_storage:${gameId}:${key}`
        try {
          if (typeof window !== 'undefined' && window.localStorage) {
            window.localStorage.removeItem(storageKey)
          }
        } catch {}
        this.inMemoryStorage.delete(storageKey)
        if (message.requestId) this.reply(message.requestId, true)
        break
      }
      case 'STORAGE_CLEAR': {
        const gameId = this.manifest?.id ?? 'game'
        const prefix = `bombless_game_storage:${gameId}:`
        try {
          if (typeof window !== 'undefined' && window.localStorage) {
            const toRemove: string[] = []
            for (let i = 0; i < window.localStorage.length; i++) {
              const k = window.localStorage.key(i)
              if (k?.startsWith(prefix)) toRemove.push(k)
            }
            for (const k of toRemove) window.localStorage.removeItem(k)
          }
        } catch {}
        for (const k of Array.from(this.inMemoryStorage.keys())) {
          if (k.startsWith(prefix)) this.inMemoryStorage.delete(k)
        }
        if (message.requestId) this.reply(message.requestId, true)
        break
      }
    }
  }

  private reply(id: string, ok: boolean, value?: unknown, error?: string) {
    this.iframe.contentWindow?.postMessage(envelope(this.instanceId, 'HOST_RESPONSE', { ok, value, error }, id), this.targetOrigin)
  }
  resize() {
    if (this.state !== 'disposed' && this.state !== 'error') this.send('VIEWPORT_RESIZE', { width: this.iframe.clientWidth, height: this.iframe.clientHeight })
  }
  pause() { this.send('HOST_PAUSE', {}); this.setState('paused') }
  resume() { this.send('HOST_RESUME', {}); this.setState('running') }
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
