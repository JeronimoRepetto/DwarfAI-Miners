import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { COPY_DIR, DESIGN_ENV, REQUIRED_FILES } from './design.mjs'
import {
  COPY_INCLUDE,
  SCOPE_MANIFEST,
  checkTarget,
  findCopySource,
  isExcluded,
  mainWorktree,
  planCopy
} from './design-copy.mjs'

/*
 * `pnpm golden:design` gives a worktree its own real copy of the design repository. Only the pure
 * half is pinned here, through hand-written fakes: where the source is found, what is copied, and
 * the two refusals that keep the copy from ever becoming a link.
 */

const MAIN = path.resolve('/work/app')
const WORKTREE = path.resolve('/work/app-worktrees/634')
const DESIGN = path.resolve('/work/design')

const PORCELAIN = [
  'worktree ' + MAIN.split(path.sep).join('/'),
  'HEAD e4d480e',
  'branch refs/heads/main',
  '',
  'worktree ' + WORKTREE.split(path.sep).join('/'),
  'HEAD c9880bf',
  'branch refs/heads/test/634-golden-harness',
  ''
].join('\n')

function fakeFs({ files = [], links = {} } = {}) {
  const fileSet = new Set(files)
  return {
    isFile: (p) => fileSet.has(p),
    isDirectory: (p) => p in links,
    realpath: (p) => {
      if (p in links) return links[p]
      throw new Error('ENOENT ' + p)
    }
  }
}
const designFiles = (root) => REQUIRED_FILES.map((rel) => path.join(root, ...rel.split('/')))
const junction = path.join(MAIN, 'docs', 'dwarfai-miners-design')

describe('mainWorktree', () => {
  it('is the first worktree git lists', () => {
    expect(mainWorktree(PORCELAIN)).toBe(MAIN)
  })

  it('is null when git lists none', () => {
    expect(mainWorktree('')).toBeNull()
  })
})

describe('findCopySource', () => {
  it('takes the environment variable first', () => {
    const fs = fakeFs({ files: designFiles(DESIGN) })
    expect(findCopySource({ env: { [DESIGN_ENV]: DESIGN }, porcelain: PORCELAIN, fs })).toEqual({
      kind: 'found',
      root: DESIGN,
      source: 'env'
    })
  })

  it("falls back to the main worktree's docs junction", () => {
    const fs = fakeFs({
      files: designFiles(DESIGN),
      links: { [junction]: path.join(DESIGN, 'docs') }
    })
    expect(findCopySource({ env: {}, porcelain: PORCELAIN, fs })).toEqual({
      kind: 'found',
      root: DESIGN,
      source: 'junction'
    })
  })

  it('fails an environment variable with the wrong shape instead of trying the junction', () => {
    const fs = fakeFs({
      files: designFiles(DESIGN),
      links: { [junction]: path.join(DESIGN, 'docs') }
    })
    const other = path.resolve('/nowhere')
    const found = findCopySource({ env: { [DESIGN_ENV]: other }, porcelain: PORCELAIN, fs })
    expect(found.kind).toBe('invalid')
    expect(found.root).toBe(other)
  })

  it('reports absent when neither is there', () => {
    expect(findCopySource({ env: {}, porcelain: PORCELAIN, fs: fakeFs() })).toEqual({
      kind: 'absent'
    })
  })
})

describe('what is copied', () => {
  it('copies the docs, the tools and the prototype data and stage CSS, nothing broader', () => {
    expect(COPY_INCLUDE).toEqual([
      'docs',
      'tools',
      'prototype/kit.css',
      'prototype/foundations/tokens.css',
      'prototype/data'
    ])
  })

  it('covers every file a golden run requires', () => {
    for (const rel of REQUIRED_FILES) {
      expect(COPY_INCLUDE.some((inc) => rel === inc || rel.startsWith(inc + '/'))).toBe(true)
    }
  })

  it('never copies node_modules or .git at any depth', () => {
    expect(isExcluded('tools/node_modules/x.js')).toBe(true)
    expect(isExcluded('docs/.git/HEAD')).toBe(true)
    expect(isExcluded('docs/reference/manifest.json')).toBe(false)
  })
})

describe('the copy as a package scope', () => {
  it("is CommonJS like its source, not this checkout's ES module scope", () => {
    // The design tools are CommonJS .js files under a root with no package.json; inside this
    // checkout Node would read them through its "type": "module" and refuse `require`.
    expect(SCOPE_MANIFEST.type).toBe('commonjs')
    expect(SCOPE_MANIFEST.private).toBe(true)
  })
})

describe('planCopy', () => {
  // A tree as { rel: 'file' | 'dir' | 'link' }, read through the same two questions the runner asks.
  function treeFs(tree) {
    const kinds = Object.fromEntries(
      Object.entries(tree).map(([rel, kind]) => [path.join(DESIGN, ...rel.split('/')), kind])
    )
    return {
      kind: (p) => kinds[p] ?? 'missing',
      list: (p) =>
        Object.keys(kinds)
          .filter((k) => path.dirname(k) === p)
          .map((k) => path.basename(k))
    }
  }

  it('lists files under each included entry and skips links rather than copying them', () => {
    const plan = planCopy(
      DESIGN,
      treeFs({
        docs: 'dir',
        'docs/README.md': 'file',
        'docs/reference': 'dir',
        'docs/reference/manifest.json': 'file',
        'docs/shortcut': 'link',
        tools: 'dir',
        'tools/node_modules': 'dir',
        'tools/node_modules/dep.js': 'file',
        'tools/compare-ref.js': 'file',
        prototype: 'dir',
        'prototype/kit.css': 'file',
        'prototype/assets': 'dir',
        'prototype/assets/art.png': 'file',
        art: 'dir',
        'art/source.aseprite': 'file'
      })
    )
    expect(plan.files.sort()).toEqual(
      [
        'docs/README.md',
        'docs/reference/manifest.json',
        'prototype/kit.css',
        'tools/compare-ref.js'
      ].sort()
    )
    expect(plan.skippedLinks).toEqual(['docs/shortcut'])
  })

  it('names an included entry the design repository lacks', () => {
    const plan = planCopy(DESIGN, treeFs({ docs: 'dir' }))
    expect(plan.missing).toEqual(COPY_INCLUDE.slice(1))
  })
})

describe('checkTarget', () => {
  const target = path.join(WORKTREE, COPY_DIR)

  it('accepts a missing target or a real directory', () => {
    expect(checkTarget({ source: DESIGN, target, targetKind: 'missing' })).toBeNull()
    expect(checkTarget({ source: DESIGN, target, targetKind: 'dir' })).toBeNull()
  })

  it('refuses a target that is a link, which a forced worktree removal would follow', () => {
    expect(checkTarget({ source: DESIGN, target, targetKind: 'link' })).toMatch(/link/)
  })

  it('refuses a source that is the target itself or inside it', () => {
    expect(checkTarget({ source: target, target, targetKind: 'dir' })).toMatch(/itself/)
    expect(checkTarget({ source: path.join(target, 'x'), target, targetKind: 'dir' })).toMatch(
      /itself/
    )
  })

  it('refuses a target inside the source', () => {
    expect(checkTarget({ source: WORKTREE, target, targetKind: 'missing' })).toMatch(/inside/)
  })
})
