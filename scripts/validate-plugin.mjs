import { readFile, access } from 'node:fs/promises'
import { resolve, relative, isAbsolute, sep } from 'node:path'

const root = resolve(process.argv[2] ?? '.')
const manifestPath = resolve(root, 'manifest.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const fail = (message) => { console.error('Plugin validation failed: ' + message); process.exit(1) }
const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/
if (manifest.manifestVersion !== 1) fail('manifestVersion must be 1')
if (!idPattern.test(manifest.id ?? '')) fail('invalid id')
if (manifest.pluginType !== 'vue3') fail('pluginType must be vue3')
if (!/^\d+\.\d+\.\d+/.test(manifest.version ?? '')) fail('invalid version')
if (manifest.runtime?.apiVersion !== '1') fail('runtime.apiVersion must be 1')
if (!Array.isArray(manifest.runtime?.capabilities)) fail('runtime.capabilities must be an array')
const entry = manifest.entry
if (typeof entry !== 'string' || !entry || isAbsolute(entry) || entry.includes('\\') ||
    /^[a-z][a-z0-9+.-]*:/i.test(entry) || entry.split('/').some(p => !p || p === '.' || p === '..')) fail('entry must be package-relative')
const entryPath = resolve(root, entry)
const rel = relative(root, entryPath)
if (rel.startsWith('..' + sep) || rel === '..') fail('entry escapes package')
await access(entryPath).catch(() => fail('entry file does not exist: ' + entry))
console.log(`Validated ${manifest.id}@${manifest.version} (${entry})`)
