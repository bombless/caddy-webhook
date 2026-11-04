import { envelope, isEnvelope, PROTOCOL_VERSION } from '../runtime/protocol'
import type { GameRuntime } from './vue'

type Listener = (value: any) => void
export function createGameBridge() {
  let instanceId = ''
  let hostOrigin = ''
  let packageBase = new URL('./', window.location.href)
  let capabilities = new Set<string>()
  const listeners = new Map<string, Set<Listener>>()
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number }>()
  const notify = (type: string, payload: Record<string, unknown>) => {
    for (const fn of listeners.get(type) ?? []) fn(payload)
  }
  const emit = (type: string, payload: Record<string, unknown> = {}, requestId?: string) => {
    if (!instanceId) return
    window.parent.postMessage(envelope(instanceId, type, payload, requestId), hostOrigin || '*')
  }
  const on = (type: string, fn: Listener) => {
    if (!listeners.has(type)) listeners.set(type, new Set())
    listeners.get(type)!.add(fn)
    return () => listeners.get(type)?.delete(fn)
  }
  const request = (type: string, payload: Record<string, unknown>) => new Promise<unknown>((resolve, reject) => {
    const id = crypto.randomUUID()
    const timer = window.setTimeout(() => { pending.delete(id); reject(new Error(type + ' timed out')) }, 5000)
    pending.set(id, { resolve, reject, timer })
    emit(type, payload, id)
  })
  const receive = (event: MessageEvent) => {
    if (event.source !== window.parent || !isEnvelope(event.data)) return
    const m = event.data
    if (m.type === 'HOST_INIT' && !instanceId) {
      instanceId = m.instanceId
      hostOrigin = event.origin === 'null' ? '*' : event.origin
      if (m.payload.apiVersion !== String(PROTOCOL_VERSION)) return
      packageBase = new URL(String(m.payload.packageUrl), window.location.href)
      capabilities = new Set(Array.isArray(m.payload.capabilities) ? m.payload.capabilities.filter((x): x is string => typeof x === 'string') : [])
      emit('GAME_READY', {})
      return
    }
    if (!instanceId || m.instanceId !== instanceId) return
    if (m.type === 'HOST_RESPONSE' && m.requestId) {
      const p = pending.get(m.requestId)
      if (p) { clearTimeout(p.timer); pending.delete(m.requestId); m.payload.ok ? p.resolve(m.payload.value) : p.reject(new Error(String(m.payload.error ?? 'Host request failed'))) }
      return
    }
    if (m.type === 'HOST_PAUSE') { notify('LIFECYCLE_PAUSE', {}); return }
    if (m.type === 'HOST_RESUME') { notify('LIFECYCLE_RESUME', {}); return }
    if (m.type === 'HOST_DISPOSE') { notify('LIFECYCLE_DISPOSE', {}); dispose(); return }
    if (m.type === 'VIEWPORT_RESIZE') notify('VIEWPORT_RESIZE', m.payload)
    if (m.type === 'INPUT_EVENT') notify('INPUT_EVENT', m.payload)
  }
  const localInput = (event: KeyboardEvent | PointerEvent) => {
    if (!instanceId) return
    if (event instanceof KeyboardEvent) {
      if (!capabilities.has('input.keyboard')) return
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Enter', 'Escape', 'KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(event.code)) return
      notify('INPUT_EVENT', { type: event.type === 'keydown' ? 'KEY_DOWN' : 'KEY_UP', code: event.code, repeat: event.repeat, timestamp: Math.round(performance.now() * 1000) })
    } else {
      if (!capabilities.has('input.pointer')) return
      const rect = document.documentElement.getBoundingClientRect()
      notify('INPUT_EVENT', { type: event.type.toUpperCase(), x: event.clientX - rect.left, y: event.clientY - rect.top, buttons: event.buttons, timestamp: Math.round(performance.now() * 1000) })
    }
  }
  const keyDown = (e: KeyboardEvent) => localInput(e)
  const pointer = (e: PointerEvent) => localInput(e)
  window.addEventListener('message', receive)
  window.addEventListener('keydown', keyDown)
  window.addEventListener('keyup', keyDown)
  window.addEventListener('pointerdown', pointer)
  window.addEventListener('pointerup', pointer)
  window.addEventListener('pointermove', pointer)
  const runtime: GameRuntime = {
    assets: { url: (path) => {
      if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\') || path.split('/').some(x => x === '..' || x === '.')) throw new Error('Asset path must be package-relative')
      return new URL(path, packageBase).href
    } },
    audio: { play: async (soundId, options) => {
      if (!capabilities.has('audio')) return
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(soundId)) throw new Error('Invalid sound id')
      await request('AUDIO_PLAY', { soundId, volume: Math.max(0, Math.min(1, options?.volume ?? 1)) })
    } },
    storage: {
      get: async (key) => capabilities.has('storage') ? request('STORAGE_GET', { key }) : undefined,
      set: async (key, value) => { if (capabilities.has('storage')) await request('STORAGE_SET', { key, value }) },
    },
    game: {
      setScore: (score) => { if (capabilities.has('score') && Number.isSafeInteger(score) && score >= 0 && score <= 1_000_000_000) emit('SCORE_UPDATE', { score }) },
      pause: () => emit('GAME_PAUSE'), resume: () => emit('GAME_RESUME'), end: (result) => emit('GAME_OVER', { result }),
    },
    input: { subscribe: (fn) => on('INPUT_EVENT', fn) },
    viewport: {
      width: window.innerWidth, height: window.innerHeight,
      subscribe: (fn) => { const off = on('VIEWPORT_RESIZE', fn); fn({ width: window.innerWidth, height: window.innerHeight }); return off },
    },
  }
  function dispose() {
    window.removeEventListener('message', receive)
    window.removeEventListener('keydown', keyDown)
    window.removeEventListener('keyup', keyDown)
    window.removeEventListener('pointerdown', pointer)
    window.removeEventListener('pointerup', pointer)
    window.removeEventListener('pointermove', pointer)
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Bridge disposed')) }
    pending.clear(); listeners.clear()
  }
  return { runtime, dispose }
}
