// L8 OS lane (17 §1.8; ADR-030 item 1; S-030-1): the Host's git inspector, with the running OS's
// path rules, over folders made in a temporary directory with plain file-system calls. One
// describe per OS; runs only in `pnpm test:os`.
//
// S-030-1 has not passed, so the conservative default holds (`21` §2 cut 1): Windows folds case,
// macOS and Linux fold nothing. On Windows two spellings of one folder give one mine key; on a
// case-sensitive Linux volume two folders that differ only in case give two; on macOS (whose
// default volume is case-insensitive) no key is folded until S-030-1 passes.
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { NodeFs } from '../../../platform/fs/NodeFs'
import { canonicalMinePath } from '../domain/minePath'
import { createHostGitRepoInspector } from './FsGitRepoInspector'

let dir = ''

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'dwarfai-case-')))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function inspector() {
  return createHostGitRepoInspector({ fs: new NodeFs(), clock: new FakeClock(0) })
}

describe.runIf(process.platform === 'win32')('mine keys on a Windows volume', () => {
  it('[S-030-1] two case spellings of one folder give one mine key on a case-insensitive volume and two on a case-sensitive one', async () => {
    mkdirSync(join(dir, 'Repo'))
    expect(existsSync(join(dir, 'REPO'))).toBe(true) // the volume is case-insensitive

    const host = inspector()
    const keys = new Set([
      (await host.resolve(join(dir, 'Repo'))).mineKey,
      (await host.resolve(join(dir, 'REPO'))).mineKey,
      (await host.resolve(join(dir, 'repo'))).mineKey
    ])

    expect([...keys]).toEqual([
      canonicalMinePath(join(dir, 'Repo'), { style: 'win32', caseFold: true })
    ])
  })
})

describe.runIf(process.platform === 'linux')('mine keys on a Linux volume', () => {
  it('[S-030-1] two case spellings of one folder give one mine key on a case-insensitive volume and two on a case-sensitive one', async () => {
    mkdirSync(join(dir, 'Repo'))
    expect(existsSync(join(dir, 'REPO'))).toBe(false) // the volume is case-sensitive
    mkdirSync(join(dir, 'repo')) // so this is a second folder

    const host = inspector()

    expect((await host.resolve(join(dir, 'Repo'))).mineKey).toBe(join(dir, 'Repo'))
    expect((await host.resolve(join(dir, 'repo'))).mineKey).toBe(join(dir, 'repo'))
  })
})

describe.runIf(process.platform === 'darwin')('mine keys on a macOS volume', () => {
  it('[S-030-1] while S-030-1 has not passed, a macOS volume folds no case in a mine key', async () => {
    mkdirSync(join(dir, 'Repo'))
    const host = inspector()

    for (const spelling of ['Repo', 'REPO']) {
      const cwd = join(dir, spelling)
      // Whatever the volume's sensitivity, the key is the real path as the OS spells it, unfolded.
      const real = existsSync(cwd) ? realpathSync.native(cwd) : cwd
      expect((await host.resolve(cwd)).mineKey).toBe(
        canonicalMinePath(real, { style: 'posix', caseFold: false })
      )
    }
  })
})
