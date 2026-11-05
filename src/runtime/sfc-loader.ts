import * as sfc from '@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js'
import * as Vue from 'vue'
import * as SDK from '../sdk/index.ts'
import type { GameRuntime } from '../sdk/vue'

export type CleanUpFn = () => void

export interface LoadedComponent {
  component: any
  cleanup: CleanUpFn
}

export async function loadGameComponent(url: string, runtime: GameRuntime): Promise<LoadedComponent> {
  if (url.endsWith('.vue')) {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Failed to fetch Vue component from ${url} (${response.status})`)
    }
    const source = await response.text()
    return compileVueSFC(source, url, runtime)
  }

  // Handle .js or .mjs component entry
  try {
    const mod = await import(/* @vite-ignore */ url)
    return {
      component: mod.default || mod,
      cleanup: () => {},
    }
  } catch {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Failed to fetch module from ${url} (${response.status})`)
    }
    const source = await response.text()
    return {
      component: evaluateScriptContent(source),
      cleanup: () => {},
    }
  }
}

export function compileVueSFC(source: string, filename: string, _runtime?: GameRuntime): LoadedComponent {
  const { descriptor, errors } = sfc.parse(source, { filename })
  if (errors && errors.length > 0) {
    throw new Error(`SFC Parse Error: ${errors.map(e => e.message).join(', ')}`)
  }

  const id = 'v-' + Math.random().toString(36).slice(2, 8)
  const hasScoped = descriptor.styles.some(s => s.scoped)

  // 1. Process styles
  const styleNodes: HTMLStyleElement[] = []
  for (const style of descriptor.styles) {
    let css = style.content
    if (style.scoped) {
      const compiled = sfc.compileStyle({ id, source: css, scoped: true })
      if (compiled.errors && compiled.errors.length > 0) {
        console.warn('Style compile errors:', compiled.errors)
      }
      css = compiled.code
    }
    if (typeof document !== 'undefined') {
      const el = document.createElement('style')
      el.setAttribute('type', 'text/css')
      el.setAttribute('data-sfc-id', id)
      el.textContent = css
      document.head.appendChild(el)
      styleNodes.push(el)
    }
  }

  const cleanup: CleanUpFn = () => {
    for (const el of styleNodes) {
      el.remove()
    }
  }

  // 2. Process script and template
  let component: any

  if (descriptor.scriptSetup) {
    const script = sfc.compileScript(descriptor, {
      id,
      inlineTemplate: true,
      templateOptions: {
        scoped: hasScoped,
        id,
      },
    })
    component = evaluateScriptContent(script.content)
  } else if (descriptor.script) {
    component = evaluateScriptContent(descriptor.script.content)
    if (descriptor.template) {
      component.render = Vue.compile(descriptor.template.content)
    }
  } else if (descriptor.template) {
    component = {
      render: Vue.compile(descriptor.template.content),
    }
  } else {
    throw new Error('SFC must contain a <template> or <script>')
  }

  if (hasScoped) {
    component.__scopeId = 'data-v-' + id
  }

  return { component, cleanup }
}

function evaluateScriptContent(rawContent: string): any {
  let js = rawContent

  // Transform imports from 'vue'
  js = js.replace(/import\s*\{([^}]+)\}\s*from\s*['"]vue['"];?/g, (_m, imp) => {
    const dest = imp.split(',').map(s => {
      const parts = s.trim().split(/\s+as\s+/)
      return parts.length === 2 ? `${parts[0]}: ${parts[1]}` : parts[0]
    }).filter(Boolean).join(', ')
    return `const { ${dest} } = Vue;`
  })
  js = js.replace(/import\s+(\w+)\s+from\s*['"]vue['"];?/g, 'const $1 = Vue;')

  // Transform imports from SDK
  js = js.replace(/import\s*\{([^}]+)\}\s*from\s*['"][^'"]*sdk(?:\/vue)?['"];?/g, (_m, imp) => {
    const dest = imp.split(',').map(s => {
      const parts = s.trim().split(/\s+as\s+/)
      return parts.length === 2 ? `${parts[0]}: ${parts[1]}` : parts[0]
    }).filter(Boolean).join(', ')
    return `const { ${dest} } = SDK;`
  })

  // Transform export default
  js = js.replace(/export\s+default\s+/, 'return ')

  const factory = new Function('Vue', 'SDK', js)
  return factory(Vue, SDK)
}
