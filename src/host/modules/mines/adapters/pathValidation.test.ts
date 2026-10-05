// L3 (17 §1.3): the Host path probe over a temporary folder on the running OS (18 C-17; ADR-019
// item 9). The link out of the mine is a junction on Windows (no elevation needed) and a directory
// symlink elsewhere: Node ignores the `'junction'` type outside Windows. The probe then serves
// `resolveFileInMine`, so the escape is refused on the real disk, not only by the double.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import type { MineId } from '../../../kernel/domain/values'
import { resolveFileInMine } from '../application/resolveFile'
import { mineIdOf, mineNameOf, openMine, type Mine } from '../domain/mine'
import { canonicalMinePath } from '../domain/minePath'
import { NodePathProbe } from './pathValidation'
import { hostVolumeRules } from './volumeCase'

const MINE_ID: MineId = mineIdOf('00000000-0000-7000-8000-000000000066')

let root = ''

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dwarfai-066-paths-')))
  mkdirSync(join(root, 'mine', 'src'), { recursive: true })
  writeFileSync(join(root, 'mine', 'src', 'a.ts'), 'export {}')
  mkdirSync(join(root, 'outside', 'deep'), { recursive: true })
  writeFileSync(join(root, 'outside', 'secret.txt'), 'secret')
  writeFileSync(join(root, 'outside', 'deep', 'key'), 'key')
  symlinkSync(join(root, 'outside', 'deep'), join(root, 'mine', 'out'), 'junction')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('NodePathProbe (C-17)', () => {
  it('[ADR-019] the Host path probe follows a junction or symlink to its real target and names what is there', () => {
    const probe = new NodePathProbe()

    expect(probe.realpath(join(root, 'mine', 'out', 'key'))).toBe(
      join(root, 'outside', 'deep', 'key')
    )
    expect(probe.realpath(join(root, 'mine', 'gone.ts'))).toBeNull()
    expect(probe.kindOf(join(root, 'mine', 'src', 'a.ts'))).toBe('file')
    expect(probe.kindOf(join(root, 'mine', 'src'))).toBe('directory')
    expect(probe.kindOf(join(root, 'mine', 'gone.ts'))).toBeNull()
  })

  it('[ADR-019] resolveFileInMine over the real disk refuses a junction or symlink out of the mine', () => {
    const style = hostVolumeRules(new FakeClock(0)).style
    const mine = openMine(
      {
        cause: 'declared',
        birth: {
          id: MINE_ID,
          path: canonicalMinePath(join(root, 'mine'), { style, caseFold: false }),
          name: mineNameOf('mine')
        }
      },
      0
    ).mine as Mine
    const deps = {
      repository: { byId: (id: MineId) => (id === mine.id ? mine : null) },
      paths: new NodePathProbe(),
      style
    }

    expect(resolveFileInMine(deps, MINE_ID, join('src', 'a.ts'))).toEqual({
      ok: true,
      value: join(root, 'mine', 'src', 'a.ts')
    })
    expect(resolveFileInMine(deps, MINE_ID, join('out', 'key'))).toEqual({
      ok: false,
      error: 'escapes-mine'
    })
    expect(resolveFileInMine(deps, MINE_ID, join('..', 'outside', 'secret.txt'))).toEqual({
      ok: false,
      error: 'escapes-mine'
    })
    expect(resolveFileInMine(deps, MINE_ID, join('src', 'gone.ts'))).toEqual({
      ok: false,
      error: 'missing'
    })
  })
})
