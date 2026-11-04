import type { InjectionKey } from 'vue'

export interface GameRuntime {
  assets: { url(path: string): string }
  audio: { play(soundId: string, options?: { volume?: number }): Promise<void> }
  storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> }
  game: { setScore(score: number): void; pause(): void; resume(): void; end(result?: unknown): void }
  input: { subscribe(listener: (event: Record<string, unknown>) => void): () => void }
  viewport: { width: number; height: number; subscribe(listener: (size: { width: number; height: number }) => void): () => void }
}
export const GAME_RUNTIME_KEY: InjectionKey<GameRuntime> = Symbol('BomblessGameRuntime')
