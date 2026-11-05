export const PROTOCOL = 'bombless-game' as const
export const PROTOCOL_VERSION = 1 as const

export type HostMessageType = 'HOST_INIT' | 'HOST_START' | 'HOST_PAUSE' | 'HOST_RESUME' | 'HOST_END' | 'HOST_DISPOSE' | 'VIEWPORT_RESIZE' | 'INPUT_EVENT'
export type GameMessageType =
  | 'GAME_READY' | 'GAME_ERROR' | 'AUDIO_PLAY' | 'STORAGE_GET' | 'STORAGE_SET'
  | 'SCORE_UPDATE' | 'GAME_PAUSE' | 'GAME_RESUME' | 'GAME_OVER'

export interface Envelope<T extends string = string> {
  protocol: typeof PROTOCOL
  protocolVersion: typeof PROTOCOL_VERSION
  instanceId: string
  type: T
  requestId?: string
  payload: Record<string, unknown>
}

export function isEnvelope(value: unknown): value is Envelope {
  if (!value || typeof value !== 'object') return false
  const m = value as Record<string, unknown>
  return m.protocol === PROTOCOL &&
    m.protocolVersion === PROTOCOL_VERSION &&
    typeof m.instanceId === 'string' && m.instanceId.length >= 16 &&
    typeof m.type === 'string' &&
    !!m.payload && typeof m.payload === 'object' && !Array.isArray(m.payload)
}

export function envelope<T extends string>(
  instanceId: string, type: T, payload: Record<string, unknown> = {}, requestId?: string,
): Envelope<T> {
  return { protocol: PROTOCOL, protocolVersion: PROTOCOL_VERSION, instanceId, type, payload, ...(requestId ? { requestId } : {}) }
}
