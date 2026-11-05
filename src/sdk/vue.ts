import { inject, provide, type InjectionKey } from 'vue'

export interface GameStorage {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  clear(): Promise<void>
}

export interface GameRuntime {
  assets: { url(path: string): string }
  audio: { play(soundId: string, options?: { volume?: number }): Promise<void> }
  storage: GameStorage
  game: { setScore(score: number): void; pause(): void; resume(): void; end(result?: unknown): void }
  input: { subscribe(listener: (event: Record<string, unknown>) => void): () => void }
  viewport: { width: number; height: number; subscribe(listener: (size: { width: number; height: number }) => void): () => void }
}
export const GAME_RUNTIME_KEY: InjectionKey<GameRuntime> = Symbol('BomblessGameRuntime')

export function provideGameRuntime(runtime: GameRuntime) {
  provide(GAME_RUNTIME_KEY, runtime)
}

export function useGameRuntime(): GameRuntime {
  const runtime = inject(GAME_RUNTIME_KEY)
  if (!runtime) throw new Error('Game runtime is unavailable. Mount the game bridge before using useGameRuntime().')
  return runtime
}
