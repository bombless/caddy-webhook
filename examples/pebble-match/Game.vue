<template>
  <main class="board">
    <header class="hud">
      <p>Cleared <strong>{{ cleared }}</strong></p>
      <p>Best <strong>{{ best }}</strong></p>
      <p>Left <strong>{{ leftCount }}</strong></p>
    </header>
    <h1>Pebble Match</h1>
    <p class="status">{{ status }}</p>
    <div class="grid">
      <button
        v-for="(color, position) in cells"
        :key="position"
        type="button"
        :class="['cell', color, { marked: marked.includes(position), 'is-empty': !color }]"
        :aria-label="color ? `${color} pebble` : 'Empty space'"
        :disabled="!color"
        @click="play(position)"
      />
    </div>
    <button id="restart" type="button" @click="restart">New board</button>
  </main>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useGameRuntime } from '@bombless/game-sdk/vue'

const COLORS = ['sand', 'moss', 'river', 'clay']
const COLUMNS = 8
const ROWS = 8

const runtime = useGameRuntime()

const cells = ref([])
const cleared = ref(0)
const best = ref(0)
const marked = ref([])
const status = ref('Tap two or more touching pebbles of the same color.')
const isStarted = ref(false)

const leftCount = computed(() => cells.value.filter(Boolean).length)

function index(column, row) {
  return row * COLUMNS + column
}

function neighbors(position) {
  const column = position % COLUMNS
  const row = Math.floor(position / COLUMNS)
  const result = []
  if (column > 0) result.push(position - 1)
  if (column < COLUMNS - 1) result.push(position + 1)
  if (row > 0) result.push(position - COLUMNS)
  if (row < ROWS - 1) result.push(position + COLUMNS)
  return result
}

function groupAt(position) {
  const color = cells.value[position]
  if (!color) return []
  const found = []
  const pending = [position]
  const seen = new Set(pending)
  while (pending.length > 0) {
    const current = pending.pop()
    found.push(current)
    neighbors(current).forEach((next) => {
      if (!seen.has(next) && cells.value[next] === color) {
        seen.add(next)
        pending.push(next)
      }
    })
  }
  return found
}

function hasMove() {
  return cells.value.some((color, position) => color && groupAt(position).length >= 2)
}

function collapse() {
  const newCells = [...cells.value]
  for (let column = 0; column < COLUMNS; column += 1) {
    const pebbles = []
    for (let row = ROWS - 1; row >= 0; row -= 1) {
      const color = newCells[index(column, row)]
      if (color) pebbles.push(color)
    }
    for (let row = ROWS - 1; row >= 0; row -= 1) {
      newCells[index(column, row)] = pebbles[ROWS - 1 - row] ?? null
    }
  }
  cells.value = newCells
}

async function finish(message) {
  best.value = Math.max(best.value, cleared.value)
  try {
    await runtime?.storage?.set('bestScore', best.value)
  } catch {
    // Fail-open
  }
  status.value = message
}

function play(position) {
  const group = groupAt(position)
  if (group.length < 2) {
    status.value = 'That pebble needs a matching neighbor.'
    marked.value = [position]
    return
  }
  marked.value = []
  const newCells = [...cells.value]
  group.forEach((item) => {
    newCells[item] = null
  })
  cells.value = newCells
  cleared.value += group.length
  try {
    runtime?.game?.setScore(cleared.value)
  } catch {
    // Fail-open
  }
  collapse()
  if (cells.value.every((color) => color === null)) {
    finish(`Board cleared. ${cleared.value} pebbles removed.`)
    return
  }
  if (!hasMove()) {
    finish(`No matches left. ${cleared.value} pebbles removed.`)
    return
  }
  status.value = `Removed ${group.length}. The pebbles above drop down.`
}

function restart() {
  cells.value = Array.from({ length: COLUMNS * ROWS }, () =>
    COLORS[Math.floor(Math.random() * COLORS.length)]
  )
  cleared.value = 0
  marked.value = []
  status.value = 'Tap two or more touching pebbles of the same color.'
  try {
    runtime?.game?.setScore(0)
  } catch {
    // Fail-open
  }
}

// Lifecycle and exposed methods
async function startGame() {
  isStarted.value = true
  if (cells.value.length === 0 || !cells.value.some(Boolean)) {
    restart()
  }
  try {
    const savedBest = await runtime?.storage?.get('bestScore')
    if (typeof savedBest === 'number' && savedBest > best.value) {
      best.value = savedBest
    }
  } catch {
    // Fail-open
  }
}

function getSaveData() {
  return {
    cells: Array.from(cells.value),
    cleared: cleared.value,
    best: best.value,
    status: status.value,
  }
}

function loadSaveData(data) {
  if (data && typeof data === 'object') {
    if (Array.isArray(data.cells) && data.cells.length === COLUMNS * ROWS && data.cells.some(Boolean)) {
      cells.value = data.cells
    } else {
      restart()
    }
    if (typeof data.cleared === 'number') cleared.value = data.cleared
    if (typeof data.best === 'number') best.value = data.best
    if (typeof data.status === 'string') status.value = data.status
  }
}

// Initialize board immediately so pebbles exist on mount
restart()

defineExpose({
  startGame,
  getSaveData,
  loadSaveData,
})
</script>

<style scoped>
:host, .board {
  color: #f4efe4;
  background: #243126;
  font-family: "Segoe UI", sans-serif;
  box-sizing: border-box;
}

.board {
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 24px 16px;
  text-align: center;
  background:
    radial-gradient(circle at 50% 0%, rgba(244, 196, 112, 0.18), transparent 34%),
    linear-gradient(180deg, #314233, #1d2820);
}

h1 {
  margin: 0;
  font-size: clamp(32px, 7vw, 52px);
}

.hud, .status {
  margin: 0;
}

.hud {
  display: flex;
  gap: 22px;
  color: #d7cbb4;
}

.hud strong {
  display: block;
  color: white;
  font-size: 26px;
}

.status {
  min-height: 1.4em;
  color: #d7cbb4;
}

.grid {
  display: grid;
  grid-template-columns: repeat(8, clamp(34px, 9vw, 52px));
  gap: 6px;
}

.cell {
  width: clamp(34px, 9vw, 52px);
  height: clamp(34px, 9vw, 52px);
  border: 0;
  border-radius: 50%;
  padding: 0;
  cursor: pointer;
  box-shadow: inset 0 7px 0 rgba(255, 255, 255, 0.24);
  transition: transform 0.1s ease;
}

.cell.is-empty,
.cell:disabled {
  visibility: hidden;
  cursor: default;
  pointer-events: none;
}

.cell.sand { background: #e6c170; visibility: visible; }
.cell.moss { background: #6ea15d; visibility: visible; }
.cell.river { background: #6e93c4; visibility: visible; }
.cell.clay { background: #c47a5e; visibility: visible; }

.cell.marked {
  outline: 3px solid white;
  outline-offset: 2px;
}

.cell:focus-visible {
  outline: 3px solid #f4c470;
  outline-offset: 3px;
}

#restart {
  border: 0;
  border-radius: 999px;
  padding: 12px 22px;
  color: #243126;
  background: #f4c470;
  font: inherit;
  font-weight: 700;
  cursor: pointer;
}

#restart:focus-visible {
  outline: 3px solid white;
  outline-offset: 4px;
}
</style>
