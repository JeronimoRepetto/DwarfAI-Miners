// layer: L3
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { runSessionStoreContract } from '../testing/sessionStore.contract'
import { InMemorySessionStore } from './InMemorySessionStore'

describe('InMemorySessionStore', () => {
  runSessionStoreContract(() => ({
    store: new InMemorySessionStore(),
    nextRun: () => new InMemorySessionStore()
  }))

  it('[INV-113] the adapter reaches no file, network, Electron or Host module, so nothing it holds leaves memory', () => {
    const source = readFileSync(new URL('./InMemorySessionStore.ts', import.meta.url), 'utf8')
    const imported = [...source.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map(
      (match) => match[1]
    )
    expect(imported).toEqual(['@dwarfai/contracts', '../ports/sessionStore'])
    // Both are type-only: the adapter loads no module at run time.
    expect(source.match(/^import\s+(?!type\s)/gm)).toBeNull()
  })
})
