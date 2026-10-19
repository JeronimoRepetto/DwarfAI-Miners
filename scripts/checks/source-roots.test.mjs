import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * L7 static check of the rebuild's source roots (05 §2.1, ADR-004 items 1–3).
 *
 * Every file is read as text; nothing of the product is imported. The four new
 * roots (`src/contracts/`, `src/host/`, `src/ui-main/`, `src/legacy-bridge/`)
 * must be known to TypeScript, Vitest and the electron-vite build, and the
 * contracts package must be reachable as `@dwarfai/contracts` everywhere. The
 * renderer config must never compile the Host or UI-main trees (P5, R10).
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const CONTRACTS_FOLDERS = ['ipc', 'host-protocol', 'wire', 'config', 'text', 'catalog', 'logging']

const NEW_NODE_ROOTS = ['src/contracts', 'src/host', 'src/ui-main', 'src/legacy-bridge']
const UI_FORBIDDEN_ROOTS = ['src/host', 'src/ui-main', 'src/legacy-bridge']

const ALIAS = '@dwarfai/contracts'
const ALIAS_TARGET = './src/contracts/index.ts'

function readText(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

/** Removes `//` and block comments outside string literals (tsconfig is JSONC). */
function stripJsonComments(text) {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    const next = text[i + 1]
    if (inString) {
      out += char
      if (char === '\\') {
        out += next ?? ''
        i++
      } else if (char === '"') {
        inString = false
      }
    } else if (char === '"') {
      inString = true
      out += char
    } else if (char === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (char === '/' && next === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++
    } else {
      out += char
    }
  }
  return out
}

function readTsconfig(relativePath) {
  return JSON.parse(stripJsonComments(readText(relativePath)))
}

function includesRoot(include, root) {
  return include.some((pattern) => pattern.startsWith(`${root}/`))
}

describe('source roots (05 §2.1)', () => {
  it('[ADR-004] the contracts package has the seven folders of 05 §2.1 and one barrel that re-exports them', () => {
    for (const folder of CONTRACTS_FOLDERS) {
      const barrel = `src/contracts/${folder}/index.ts`
      expect(existsSync(path.join(repoRoot, barrel)), barrel).toBe(true)
    }

    const barrelPath = 'src/contracts/index.ts'
    expect(existsSync(path.join(repoRoot, barrelPath)), barrelPath).toBe(true)
    const statements = readText(barrelPath)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
    const reExported = statements.map((line) => {
      const match = /^export \* from '\.\/([a-z-]+)'$/.exec(line)
      expect(match, `not a folder re-export: ${line}`).not.toBeNull()
      return match[1]
    })
    expect(reExported.sort()).toEqual([...CONTRACTS_FOLDERS].sort())
  })

  it('[ADR-004] tsconfig.node.json compiles src/contracts, src/host, src/ui-main and src/legacy-bridge', () => {
    const { include } = readTsconfig('tsconfig.node.json')
    for (const root of NEW_NODE_ROOTS) {
      expect(includesRoot(include, root), `tsconfig.node.json include lacks ${root}/**`).toBe(true)
    }
  })

  it('[ADR-004] tsconfig.web.json compiles src/contracts but none of src/host, src/ui-main, src/legacy-bridge', () => {
    const { include } = readTsconfig('tsconfig.web.json')
    expect(
      includesRoot(include, 'src/contracts'),
      'tsconfig.web.json include lacks src/contracts/**'
    ).toBe(true)
    for (const root of UI_FORBIDDEN_ROOTS) {
      expect(includesRoot(include, root), `tsconfig.web.json must not include ${root}/**`).toBe(
        false
      )
    }
  })

  it('[ADR-004] @dwarfai/contracts resolves to src/contracts/index.ts in both tsconfigs, vitest and the build config', () => {
    for (const tsconfig of ['tsconfig.node.json', 'tsconfig.web.json']) {
      const paths = readTsconfig(tsconfig).compilerOptions?.paths ?? {}
      expect(paths[ALIAS], `${tsconfig} compilerOptions.paths["${ALIAS}"]`).toEqual([ALIAS_TARGET])
    }

    const vitestAlias = new RegExp(
      `'${ALIAS}':\\s*fileURLToPath\\(new URL\\('\\./src/contracts/index\\.ts', import\\.meta\\.url\\)\\)`
    )
    expect(readText('vitest.config.ts'), 'vitest.config.ts resolve.alias').toMatch(vitestAlias)

    // One alias entry per electron-vite build: main, preload and renderer.
    const buildAlias = new RegExp(
      `'${ALIAS}':\\s*resolve\\(__dirname, 'src/contracts/index\\.ts'\\)`,
      'g'
    )
    const buildMatches = readText('electron.vite.config.ts').match(buildAlias) ?? []
    expect(
      buildMatches.length,
      'electron.vite.config.ts alias entries (main, preload, renderer)'
    ).toBe(3)
  })
})
