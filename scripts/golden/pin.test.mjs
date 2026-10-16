import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { COPY_DIR, FIX_COMMAND } from './design.mjs'
import { STAMP_FILE } from './design-copy.mjs'
import { checkPin, designCommit, readPin } from './run.mjs'

/*
 * The golden lane grades the Panel against one design commit (21 §6 "Golden tooling"; ADR-034),
 * read from design-pin.json, and refuses a design at any other commit. Pinned here without a
 * design repository: the commit of a repository root comes through an injected `git`, the commit
 * of a `.design/` copy through an injected file read of the stamp `pnpm golden:design` writes.
 *
 * Package gap: the package pins 293bc1d (21 §2 P-1); the owner's design checkout has since moved
 * to its descendant d12d3fc, which is the pin (foreman decision, 2026-10-16).
 */

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PIN_FILE = path.join(rootDir, 'scripts', 'golden', 'design-pin.json')

const PINNED = 'd12d3fc700e995fae6c2d81b99b981cb15432225'
const PACKAGE_PIN = '293bc1d8860f99ea8de640a0ffdb16b282428ab4'
const DESIGN = path.resolve('/work/design')
const CHECKOUT = path.resolve('/work/app-worktrees/250')
const COPY = path.join(CHECKOUT, COPY_DIR)

const gitAt = (commits) => (root) => {
  if (root in commits) return commits[root]
  throw new Error('fatal: not a git repository: ' + root)
}
const filesOf = (files) => (p) => {
  if (p in files) return files[p]
  throw new Error('ENOENT ' + p)
}

describe('the design pin (ADR-034)', () => {
  it('[ADR-034] the golden lane is pinned to the design commit d12d3fc and refuses another pin', () => {
    const pin = readPin(readFileSync(PIN_FILE, 'utf8'))
    expect(pin).toBe('d12d3fc')
    expect(checkPin({ pin, commit: PINNED, root: DESIGN })).toBeNull()
    const refusal = checkPin({ pin, commit: PACKAGE_PIN, root: DESIGN })
    expect(refusal).toContain('d12d3fc')
    expect(refusal).toContain(PACKAGE_PIN)
    expect(refusal).toContain(DESIGN)
  })

  it('[ADR-034] refuses a design whose commit is unknown, naming the command that stamps a copy', () => {
    const refusal = checkPin({ pin: 'd12d3fc', commit: null, root: COPY })
    expect(refusal).toContain('d12d3fc')
    expect(refusal).toContain(FIX_COMMAND)
  })

  it('[ADR-034] reads a pin only as one abbreviated or full commit id', () => {
    expect(readPin('{ "design": "D12D3FC" }')).toBe('d12d3fc')
    expect(readPin(JSON.stringify({ design: PINNED }))).toBe(PINNED)
    expect(() => readPin('{ "design": "d12d" }')).toThrow(/design-pin\.json/)
    expect(() => readPin('{ "design": "main" }')).toThrow(/design-pin\.json/)
    expect(() => readPin('{}')).toThrow(/design-pin\.json/)
    expect(() => readPin('not json')).toThrow(/design-pin\.json/)
  })
})

describe('the commit of the design a run would read', () => {
  it("[ADR-034] asks git for a repository root's HEAD", () => {
    const location = { kind: 'found', root: DESIGN, source: 'env' }
    expect(
      designCommit(location, { git: gitAt({ [DESIGN]: PINNED + '\n' }), readFile: filesOf({}) })
    ).toBe(PINNED)
    const junction = { kind: 'found', root: DESIGN, source: 'junction' }
    expect(
      designCommit(junction, { git: gitAt({ [DESIGN]: PACKAGE_PIN }), readFile: filesOf({}) })
    ).toBe(PACKAGE_PIN)
  })

  it("[ADR-034] reads a copy's commit from its stamp, never from git", () => {
    const location = { kind: 'found', root: COPY, source: 'copy' }
    const stamp = { [path.join(COPY, STAMP_FILE)]: JSON.stringify({ commit: PINNED }) }
    expect(
      designCommit(location, { git: gitAt({ [COPY]: PACKAGE_PIN }), readFile: filesOf(stamp) })
    ).toBe(PINNED)
  })

  it('[ADR-034] knows no commit for an unstamped copy or a root git cannot read', () => {
    const copy = { kind: 'found', root: COPY, source: 'copy' }
    expect(designCommit(copy, { git: gitAt({}), readFile: filesOf({}) })).toBeNull()
    const garbled = { [path.join(COPY, STAMP_FILE)]: '{ "commit": "nope" }' }
    expect(designCommit(copy, { git: gitAt({}), readFile: filesOf(garbled) })).toBeNull()
    const root = { kind: 'found', root: DESIGN, source: 'env' }
    expect(designCommit(root, { git: gitAt({}), readFile: filesOf({}) })).toBeNull()
  })
})
