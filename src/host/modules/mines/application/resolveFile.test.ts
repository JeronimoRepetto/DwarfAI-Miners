import { describe, expect, it } from 'vitest'
import type { MineId } from '../../../kernel/domain/values'
import { mineIdOf, mineNameOf, openMine, transition, type Mine } from '../domain/mine'
import { canonicalMinePath, type PathStyle } from '../domain/minePath'
import { InMemoryMineRepository } from '../testing/InMemoryMineRepository'
import { resolveFileInMine, type EntryKind, type MinePathProbe } from './resolveFile'

// L2 (17 §1.2): `MinesQueries.resolveFileInMine` (16 §4.1; 14 §1.10 `openMinePath`; ADR-019 item
// 9; 18 C-17, T-35) over the repository double and a path probe that follows links the way the OS
// realpath does: on POSIX one component at a time, so `link/..` is the parent of the link's
// TARGET; on Windows `..` is removed from the spelling first, as Win32 path normalization does
// before any link is opened. The real probe's own behaviour is proven in
// `adapters/pathValidation.test.ts` over a temporary folder.
//
// TC-066-03.
const T0 = 1_790_000_000_000

/** A file system of entries and links, answering as the OS realpath would. */
class FakePathProbe implements MinePathProbe {
  private readonly entries = new Map<string, EntryKind>()
  private readonly links = new Map<string, string>()
  /** Every path `realpath` was asked about, in order. */
  readonly asked: string[] = []

  constructor(private readonly style: PathStyle) {}

  add(path: string, kind: EntryKind): this {
    this.entries.set(path, kind)
    return this
  }

  link(path: string, target: string): this {
    this.links.set(path, target)
    return this
  }

  realpath(path: string): string | null {
    this.asked.push(path)
    const sep = this.style === 'win32' ? '\\' : '/'
    const spelled = this.style === 'win32' ? path.replace(/\//g, '\\') : path
    const parts = (this.style === 'win32' ? lexical(spelled, sep) : spelled)
      .split(sep)
      .filter((part, index) => index === 0 || part !== '')
    let real: string[] = [parts[0] ?? '']
    for (const part of parts.slice(1)) {
      if (part === '.') continue
      if (part === '..') {
        if (real.length > 1) real.pop()
        continue
      }
      real.push(part)
      for (let hops = 0; hops < 40; hops += 1) {
        const target = this.links.get(real.join(sep))
        if (target === undefined) break
        real = target.split(sep)
      }
      if (!this.entries.has(real.join(sep))) return null
    }
    return real.join(sep)
  }

  kindOf(realPath: string): EntryKind | null {
    return this.entries.get(realPath) ?? null
  }
}

/** `..` and `.` removed from a spelling (Windows normalizes a path before opening it). */
function lexical(path: string, sep: string): string {
  const out: string[] = []
  for (const part of path.split(sep)) {
    if (part === '.') continue
    if (part === '..') {
      if (out.length > 1) out.pop()
      continue
    }
    out.push(part)
  }
  return out.join(sep)
}

let sequence = 0
const nextId = (): MineId =>
  mineIdOf(`00000000-0000-7000-8000-${(++sequence).toString(16).padStart(12, '0')}`)

function world(style: PathStyle, folder: string) {
  let open = false
  const repository = new InMemoryMineRepository({
    scope: { isInTransaction: () => open },
    mapSites: [],
    random: () => 0
  })
  const save = (mine: Mine): Mine => {
    open = true
    try {
      repository.save(mine)
    } finally {
      open = false
    }
    return mine
  }
  const born = openMine(
    {
      cause: 'declared',
      birth: {
        id: nextId(),
        path: canonicalMinePath(folder, { style, caseFold: false }),
        name: mineNameOf('mine')
      }
    },
    T0
  ).mine
  if (born === null) throw new Error('fixture opening refused')
  const mine = save(born)
  const paths = new FakePathProbe(style)
  return { repository, paths, mine, save, deps: { repository, paths, style } }
}

describe('resolveFileInMine (16 §4.1, ADR-019 item 9, C-17)', () => {
  it('[ADR-019] a target with .. or a symlink out of the mine answers escapes-mine', () => {
    const { deps, paths, mine } = world('posix', '/work/mine')
    paths
      .add('/work', 'directory')
      .add('/work/mine', 'directory')
      .add('/work/mine/src', 'directory')
      .add('/work/mine/src/a.ts', 'file')
      .add('/work/mineEvil', 'directory')
      .add('/work/mineEvil/x.ts', 'file')
      .add('/outside', 'directory')
      .add('/outside/secret.txt', 'file')
      .add('/outside/deep', 'directory')
      .add('/outside/deep/key', 'file')
      .add('/work/mine/out', 'directory')
      .link('/work/mine/out', '/outside/deep')

    // The control: a target inside the mine answers its real path.
    expect(resolveFileInMine(deps, mine.id, 'src/a.ts')).toEqual({
      ok: true,
      value: '/work/mine/src/a.ts'
    })

    for (const target of [
      '../../outside/secret.txt', // `..` climbs out
      'out/key', // a symlink inside the mine points out of it
      'out/../secret.txt', // the link is followed BEFORE its `..`: /outside/deep/.. = /outside
      '/outside/secret.txt', // an absolute target elsewhere
      '/work/mineEvil/x.ts' // a sibling whose name starts with the mine's
    ]) {
      expect(resolveFileInMine(deps, mine.id, target), target).toEqual({
        ok: false,
        error: 'escapes-mine'
      })
    }

    // Windows: a UNC or device target is refused before any read (no SMB connection is made).
    const win = world('win32', 'C:\\work\\mine')
    win.paths.add('C:', 'directory').add('C:\\work', 'directory').add('C:\\work\\mine', 'directory')
    for (const target of ['\\\\server\\share\\x.txt', '//server/share/x.txt', '\\\\.\\pipe\\p']) {
      expect(resolveFileInMine(win.deps, win.mine.id, target), target).toEqual({
        ok: false,
        error: 'escapes-mine'
      })
    }
    expect(
      win.paths.asked.filter((path) => path.includes('server') || path.includes('pipe'))
    ).toEqual([])
  })

  it('[ADR-019] a missing file answers missing', () => {
    const { deps, paths, mine, save } = world('posix', '/work/mine')
    paths
      .add('/work', 'directory')
      .add('/work/mine', 'directory')
      .add('/work/mine/fifo', 'other')
      .add('/work/mine/dangling', 'file')
      .link('/work/mine/dangling', '/work/mine/gone')

    expect(resolveFileInMine(deps, mine.id, 'src/gone.ts')).toEqual({
      ok: false,
      error: 'missing'
    })
    // A link whose target is gone, and a FIFO or device (nothing a person opens, 18 T-35).
    expect(resolveFileInMine(deps, mine.id, 'dangling')).toEqual({ ok: false, error: 'missing' })
    expect(resolveFileInMine(deps, mine.id, 'fifo')).toEqual({ ok: false, error: 'missing' })
    // No such mine, and a removed mine: no folder to resolve against.
    expect(resolveFileInMine(deps, nextId(), 'src/a.ts')).toEqual({ ok: false, error: 'missing' })
    const removed = transition(
      transition(mine, { type: 'removal-requested' }, T0).mine as Mine,
      { type: 'removal-settled', everyDwarfEnded: true },
      T0
    ).mine as Mine
    save(removed)
    expect(resolveFileInMine(deps, mine.id, '')).toEqual({ ok: false, error: 'missing' })
  })
})
