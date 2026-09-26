import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  COPY_DIR,
  DESIGN_ENV,
  FIX_COMMAND,
  REQUIRED_FILES,
  decide,
  isCi,
  locateDesign,
  missingFiles
} from './design.mjs'

/*
 * The locator runs in the ordinary suite on all three OSes, with no design repository and no
 * browser: every filesystem question goes through a hand-written fake, and every path is built
 * with the host's own `path`, so the same assertions hold on Windows and POSIX alike.
 */

const CHECKOUT = path.resolve('/work/app')
const WORKTREE = path.resolve('/work/app-worktrees/634')
const DESIGN = path.resolve('/work/design')

function fakeFs({ files = [], dirs = [], links = {} } = {}) {
  const fileSet = new Set(files)
  const dirSet = new Set(dirs)
  return {
    isFile: (p) => fileSet.has(p),
    isDirectory: (p) => dirSet.has(p) || p in links,
    realpath: (p) => {
      if (p in links) return links[p]
      throw new Error('ENOENT ' + p)
    }
  }
}

const designFiles = (root) => REQUIRED_FILES.map((rel) => path.join(root, ...rel.split('/')))
const mainGit = path.join(CHECKOUT, '.git')
const junction = path.join(CHECKOUT, 'docs', 'dwarfai-miners-design')

describe('missingFiles', () => {
  it('lists every required file the root lacks, as repository-relative paths', () => {
    const fs = fakeFs({ files: designFiles(DESIGN).slice(1) })
    expect(missingFiles(DESIGN, fs)).toEqual([REQUIRED_FILES[0]])
  })

  it('requires the references, the capture description, the capture tools and the stage CSS', () => {
    expect(REQUIRED_FILES).toEqual(
      expect.arrayContaining([
        'docs/reference/manifest.json',
        'docs/reference/capture.json',
        'tools/lib/cdp.js',
        'tools/lib/capture.js',
        'tools/compare-ref.js',
        'tools/snap-runtime.js',
        'prototype/kit.css',
        'prototype/foundations/tokens.css'
      ])
    )
  })
})

describe('locateDesign', () => {
  it('takes the environment variable first, over a copy and a junction', () => {
    const copy = path.join(CHECKOUT, COPY_DIR)
    const fs = fakeFs({
      files: [...designFiles(DESIGN), ...designFiles(copy)],
      dirs: [mainGit, copy],
      links: { [junction]: path.join(path.resolve('/elsewhere'), 'docs') }
    })
    expect(locateDesign({ checkout: CHECKOUT, env: { [DESIGN_ENV]: DESIGN }, fs })).toEqual({
      kind: 'found',
      root: DESIGN,
      source: 'env'
    })
  })

  it('treats a blank environment variable as unset, the way the config layers do', () => {
    const fs = fakeFs()
    expect(locateDesign({ checkout: WORKTREE, env: { [DESIGN_ENV]: '  ' }, fs }).kind).toBe(
      'absent'
    )
  })

  it('fails a configured path with the wrong shape rather than falling through', () => {
    const copy = path.join(CHECKOUT, COPY_DIR)
    const fs = fakeFs({ files: designFiles(copy), dirs: [copy] })
    const found = locateDesign({ checkout: CHECKOUT, env: { [DESIGN_ENV]: DESIGN }, fs })
    expect(found).toEqual({
      kind: 'invalid',
      root: DESIGN,
      source: 'env',
      missing: REQUIRED_FILES
    })
  })

  it('finds the gitignored copy inside a worktree', () => {
    const copy = path.join(WORKTREE, COPY_DIR)
    const fs = fakeFs({ files: designFiles(copy), dirs: [copy] })
    expect(locateDesign({ checkout: WORKTREE, env: {}, fs })).toEqual({
      kind: 'found',
      root: copy,
      source: 'copy'
    })
  })

  it('fails a copy that is incomplete instead of looking past it', () => {
    const copy = path.join(WORKTREE, COPY_DIR)
    const fs = fakeFs({ files: designFiles(copy).slice(2), dirs: [copy] })
    const found = locateDesign({ checkout: WORKTREE, env: {}, fs })
    expect(found.kind).toBe('invalid')
    expect(found.source).toBe('copy')
    expect(found.missing).toEqual(REQUIRED_FILES.slice(0, 2))
  })

  it("uses the parent of the main checkout's docs junction target", () => {
    const fs = fakeFs({
      files: designFiles(DESIGN),
      dirs: [mainGit],
      links: { [junction]: path.join(DESIGN, 'docs') }
    })
    expect(locateDesign({ checkout: CHECKOUT, env: {}, fs })).toEqual({
      kind: 'found',
      root: DESIGN,
      source: 'junction'
    })
  })

  it('never follows a junction in a worktree, whose .git is a file', () => {
    const worktreeJunction = path.join(WORKTREE, 'docs', 'dwarfai-miners-design')
    const fs = fakeFs({
      files: [...designFiles(DESIGN), path.join(WORKTREE, '.git')],
      links: { [worktreeJunction]: path.join(DESIGN, 'docs') }
    })
    expect(locateDesign({ checkout: WORKTREE, env: {}, fs }).kind).toBe('absent')
  })

  it('reports absent when nothing is configured and nothing is found', () => {
    expect(locateDesign({ checkout: CHECKOUT, env: {}, fs: fakeFs({ dirs: [mainGit] }) })).toEqual({
      kind: 'absent'
    })
  })
})

describe('isCi', () => {
  it('reads CI as set unless it is blank, false or 0', () => {
    expect(isCi({ CI: 'true' })).toBe(true)
    expect(isCi({ CI: '1' })).toBe(true)
    expect(isCi({})).toBe(false)
    expect(isCi({ CI: '' })).toBe(false)
    expect(isCi({ CI: 'false' })).toBe(false)
    expect(isCi({ CI: '0' })).toBe(false)
  })
})

describe('decide', () => {
  it('runs when the design is found', () => {
    expect(decide({ kind: 'found', root: DESIGN, source: 'env' }, {}).action).toBe('run')
  })

  it('fails locally when the design is absent, naming the command that fixes it', () => {
    const d = decide({ kind: 'absent' }, {})
    expect(d.action).toBe('fail')
    expect(d.message).toContain(FIX_COMMAND)
    expect(d.message).toContain(DESIGN_ENV)
  })

  it('skips on CI with a single line when the design is absent', () => {
    const d = decide({ kind: 'absent' }, { CI: 'true' })
    expect(d.action).toBe('skip')
    expect(d.message.split('\n')).toHaveLength(1)
  })

  it('fails a wrong shape even on CI, naming what is missing', () => {
    const d = decide(
      { kind: 'invalid', root: DESIGN, source: 'env', missing: ['tools/lib/cdp.js'] },
      { CI: 'true' }
    )
    expect(d.action).toBe('fail')
    expect(d.message).toContain(DESIGN_ENV)
    expect(d.message).toContain('tools/lib/cdp.js')
  })

  it('tells an incomplete copy to refresh with the copy command', () => {
    const d = decide(
      { kind: 'invalid', root: path.join(WORKTREE, COPY_DIR), source: 'copy', missing: ['x'] },
      {}
    )
    expect(d.action).toBe('fail')
    expect(d.message).toContain(FIX_COMMAND)
  })
})
