export interface PluginManifest {
  manifestVersion: 1
  id: string
  name: string
  version: string
  pluginType: 'vue3'
  entry: string
  runtime: {
    apiVersion: '1'
    display: { aspectRatio?: string; orientation?: 'landscape' | 'portrait' | 'any'; resize?: 'contain' | 'cover' }
    capabilities: string[]
  }
}

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/

export function validateManifest(value: unknown): PluginManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Manifest must be an object')
  const m = value as Record<string, any>
  if (m.manifestVersion !== 1) throw new Error('Unsupported manifestVersion')
  if (typeof m.id !== 'string' || !ID.test(m.id)) throw new Error('Invalid plugin id')
  if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 120) throw new Error('Invalid plugin name')
  if (typeof m.version !== 'string' || !VERSION.test(m.version)) throw new Error('Invalid plugin version')
  if (m.pluginType !== 'vue3') throw new Error('pluginType must be vue3')
  if (typeof m.entry !== 'string' || !m.entry || m.entry.startsWith('/') || m.entry.includes('\\') ||
      /^[a-z][a-z0-9+.-]*:/i.test(m.entry) ||
      m.entry.split('/').some((part: string) => !part || part === '.' || part === '..')) {
    throw new Error('entry must be a safe package-relative path')
  }
  const runtime = m.runtime
  if (!runtime || runtime.apiVersion !== '1' || !runtime.display || typeof runtime.display !== 'object' ||
      !Array.isArray(runtime.capabilities) ||
      !runtime.capabilities.every((x: unknown) => typeof x === 'string' && x.length > 0 && x.length <= 64) ||
      new Set(runtime.capabilities).size !== runtime.capabilities.length) {
    throw new Error('Invalid runtime declaration')
  }
  if (runtime.display.orientation !== undefined && !['landscape', 'portrait', 'any'].includes(runtime.display.orientation)) throw new Error('Invalid display orientation')
  if (runtime.display.resize !== undefined && !['contain', 'cover'].includes(runtime.display.resize)) throw new Error('Invalid display resize mode')
  if (runtime.display.aspectRatio !== undefined &&
      (typeof runtime.display.aspectRatio !== 'string' || !/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(runtime.display.aspectRatio))) {
    throw new Error('Invalid display aspect ratio')
  }
  return m as PluginManifest
}

export async function loadManifest(packageUrl: string): Promise<{ manifest: PluginManifest; packageUrl: URL }> {
  const base = new URL(packageUrl, window.location.href)
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('Unsupported package URL')
  if (!base.pathname.endsWith('/')) base.pathname += '/'
  const response = await fetch(new URL('manifest.json', base), { credentials: 'omit', redirect: 'error', cache: 'no-store' })
  if (!response.ok) throw new Error(`Manifest request failed (${response.status})`)
  const manifest = validateManifest(await response.json())
  return { manifest, packageUrl: base }
}
