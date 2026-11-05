export interface WasmGamePlayerOptions {
  grantedCapabilities?: string[]
  maxModuleBytes?: number
  maxMemoryPages?: number
  maxOutputBytes?: number
  watchdogMs?: number
  maxQueue?: number
  renderHz?: number
  onError?: (error: Error) => void
}
export class WasmGamePlayer {
  constructor(canvas: HTMLCanvasElement, options?: WasmGamePlayerOptions)
  load(packageUrl: string | URL, config?: Record<string, unknown>): Promise<void>
  pause(): void
  resume(): void
  dispose(): void
}
