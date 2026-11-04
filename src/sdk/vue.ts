import { inject, onBeforeUnmount, provide, type InjectionKey } from 'vue'

export interface GameRuntime {
  assets: { url(path: string): string }
  audio: { play(soundId: string, options?: { volume?: number }): Promise<void> }
  storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> }
  game: { setScore(score: number): void; pause(): void; resume(): void; end(result?: unknown): void }
  input: { subscribe(listener: (event: Record<string, unknown>) => void): () => void }
  viewport: { width: number; height: number; subscribe(listener: (size: { width: number; height: number }) => void): () => void }
}

const key: InjectionKey<GameRuntime> = Symbol('BomblessGameRuntime')
export function provideGameRuntime(runtime: GameRuntime) { provide(key, runtime) }
export function useGameRuntime(): GameRuntime {
  const runtime = inject(key)
  if (!runtime) throw new Error('Game runtime is unavailable. Mount the game bootstrap before using useGameRuntime().')
  return runtime
}
