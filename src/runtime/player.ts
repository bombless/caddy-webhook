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

export class GamePlayerRuntime {
  readonly iframe: HTMLIFrameElement
  readonly instanceId: string
  state: PlayerState = 'loading'
  private options: PlayerOptions
  private timer?: number
  private packageUrl?: URL
  private messageListener: (event: MessageEvent) => void
  private disposed = false
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number }>()

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
      this.packageUrl = packageUrl
      const allowed = new Set(this.options.allowedCapabilities ?? ['input.keyboard', 'input.pointer', 'audio', 'storage', 'score'])
      const capabilities = manifest.runtime.capabilities.filter((cap) => allowed.has(cap))
      const entry = new URL(manifest.entry, packageUrl)
      if (entry.origin !== packageUrl.origin || !entry.pathname.startsWith(packageUrl.pathname)) throw new Error('Plugin entry escapes package')
      const gameOrigin = this.options.gameOrigin ? new URL(this.options.gameOrigin).origin : undefined
      const sameOrigin = entry.origin === window.location.origin
      if (gameOrigin && (gameOrigin !== entry.origin || gameOrigin === window.location.origin)) {
        throw new Error('gameOrigin must match the plugin origin and differ from the host origin')
      }
      // Without a dedicated game origin, use an opaque-origin sandbox. With a distinct origin,
      // allow-same-origin preserves a stable origin while remaining cross-origin to the host.
      this.iframe.setAttribute('sandbox', gameOrigin ? 'allow-scripts allow-same-origin' : 'allow-scripts')
      this.iframe.referrerPolicy = 'no-referrer'
      this.iframe.title = manifest.name
      this.iframe.src = entry.href
      const timeout = this.options.timeoutMs ?? 15_000
      this.timer = window.setTimeout(() => this.fail(new Error('Game loading timed out')), timeout)
      this.iframe.addEventListener('load', () => {
        if (this.disposed) return
        const targetOrigin = gameOrigin ?? (sameOrigin ? window.location.origin : '*')
        this.iframe.contentWindow?.postMessage(envelope(this.instanceId, 'HOST_INIT', {
          apiVersion: '1', packageUrl: packageUrl.href, capabilities,
          viewport: { width: this.iframe.clientWidth, height: this.iframe.clientHeight },
        }), targetOrigin)
      }, { once: true })
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
        if (typeof message.payload.soundId === 'string' && message.payload.soundId.length <= 64) {
          // Audio is deliberately host-mediated; wire a host audio provider before granting this capability.
        }
        break
      case 'STORAGE_GET':
      case 'STORAGE_SET':
        // Persistence provider is intentionally not enabled until a host quota/backend is configured.
        if (message.requestId) this.reply(message.requestId, false, undefined, 'storage_unavailable')
        break
    }
  }

  private reply(id: string, ok: boolean, value?: unknown, error?: string) {
    this.iframe.contentWindow?.postMessage(envelope(this.instanceId, 'HOST_RESPONSE', { ok, value, error }, id), this.options.gameOrigin ?? '*')
  }

  resize() {
    if (this.state === 'disposed' || this.state === 'error') return
    this.send('VIEWPORT_RESIZE', { width: this.iframe.clientWidth, height: this.iframe.clientHeight })
  }

  pause() { this.send('HOST_PAUSE', {}); this.setState('paused') }
  resume() { this.send('HOST_RESUME', {}); this.setState('running') }

  private send(type: string, payload: Record<string, unknown>) {
    this.iframe.contentWindow?.postMessage(envelope(this.instanceId, type, payload), this.options.gameOrigin ?? '*')
  }

  private fail(error: Error) {
    if (this.disposed) return
    if (this.timer) clearTimeout(this.timer)
    this.setState('error')
    this.options.onError?.(error)
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    window.removeEventListener('message', this.messageListener)
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('Game disposed')) }
    this.pending.clear()
    this.send('HOST_DISPOSE', {})
    this.iframe.src = 'about:blank'
    this.setState('disposed')
  }
}
