import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const validator = new URL('../scripts/validate-plugin.mjs', import.meta.url).pathname
function fixture(entry = 'index.html') {
  const dir = mkdtempSync(join(tmpdir(), 'game-plugin-'))
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    manifestVersion: 1, id: 'test-game', name: 'Test Game', version: '1.0.0',
    pluginType: 'vue3', entry,
    runtime: { apiVersion: '1', display: { aspectRatio: '16:9', orientation: 'landscape', resize: 'contain' }, capabilities: ['score'] },
  }))
  if (entry === 'index.html') writeFileSync(join(dir, entry), '<!doctype html>')
  return dir
}

test('accepts a valid package with an existing relative entry', () => {
  const dir = fixture()
  try {
    const result = spawnSync(process.execPath, [validator, dir], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('rejects traversal entries', () => {
  const dir = fixture('../outside.html')
  try {
    const result = spawnSync(process.execPath, [validator, dir], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /package-relative/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
