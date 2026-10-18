// layer: L7
import { readdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/*
 * 05 §5.1 R13 (ADR-033 item 2; ISSUE-179): the composables are the renderer's only IPC layer, so `window.api` appears
 * only in `composables/**`, `App.vue` and `main.ts`. Scanned as code: comments may name it, and the tests, the test
 * doubles and the golden stage (which installs its own fake bridge before the app mounts, golden/README) are not the
 * app's production code.
 */
const RENDERER = resolve(import.meta.dirname)

/** Every production source of the renderer, as a path relative to `src/renderer/src`. */
function sources(folder = RENDERER): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(folder, entry.name)
    if (entry.isDirectory()) {
      return ['testing', 'golden', 'fakes'].includes(entry.name) ? [] : sources(path)
    }
    return /\.(ts|vue)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)
      ? [relative(RENDERER, path).split('\\').join('/')]
      : []
  })
}

/** A file's code with its comments removed. */
function codeOf(path: string): string {
  return readFileSync(resolve(RENDERER, path), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const ALLOWED = (path: string): boolean =>
  path.startsWith('composables/') || path === 'App.vue' || path === 'main.ts'

describe('where the renderer reaches the bridge', () => {
  it('[R13] window.api appears only in composables, App.vue and main.ts', () => {
    const scanned = sources()
    expect(scanned.some((path) => path.startsWith('composables/'))).toBe(true)
    expect(scanned.some((path) => path.startsWith('components/'))).toBe(true)
    const outside = scanned.filter((path) => !ALLOWED(path) && /\bwindow\.api\b/.test(codeOf(path)))
    expect(outside).toEqual([])
  })
})
