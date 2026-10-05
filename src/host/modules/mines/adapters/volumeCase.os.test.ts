// L8 OS lane (17 §1.8; ADR-030 item 1; S-030-1): the Host's git inspector, with the running OS's
// path rules and the S-030-1 detection, over folders made in a temporary directory. One describe
// per OS; runs only in `pnpm test:os`.
//
// S-030-1 passed (spike-results/S-030-1.md): a mine key folds case only where the folder folds.
// Each OS asserts a folding folder and a non-folding folder, built the way the spike harness
// (`spikes/S-030-1/caseFolding.os.test.ts`) builds them wherever that needs no elevation:
// - Windows: an NTFS temp folder folds; a temp folder with the per-directory case-sensitive flag
//   (`fsutil file setCaseSensitiveInfo`, not elevated) does not;
// - macOS: two disk images attached with `hdiutil` (not elevated), `APFS` (folds) and
//   `Case-sensitive APFS` (does not);
// - Linux: a plain temp folder does not fold. A folding folder needs an ext4 `casefold` image
//   loop-mounted as root, which this lane does not do; the detection's folding answer on Linux is
//   proven by the spike harness in CI and, on any host, by `volumeCase.test.ts`.
// Commands run through the platform's bounded query runner (argv, no shell): R17 keeps
// `node:child_process` out of the mines module, tests included.
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { NodeFs } from '../../../platform/fs/NodeFs'
import { createQueryRunner } from '../../../platform/process/NodeProcessControl'
import { canonicalMinePath } from '../domain/minePath'
import { createHostGitRepoInspector } from './FsGitRepoInspector'

const COMMAND_TIMEOUT_MS = 60_000
const SETUP_TIMEOUT_MS = 120_000

const runQuery = createQueryRunner()

/** Runs a system tool; fails the test with the tool's own reason when it does not succeed. */
async function runTool(file: string, args: readonly string[]): Promise<void> {
  const outcome = await runQuery(file, args, { timeoutMs: COMMAND_TIMEOUT_MS })
  expect(outcome.ok ? 'ok' : outcome.cause, `${file} ${args.join(' ')}`).toBe('ok')
}

function inspector() {
  return createHostGitRepoInspector({ fs: new NodeFs(), clock: new FakeClock(0) })
}

describe.runIf(process.platform === 'win32')('mine keys on a Windows folder', () => {
  let dir = ''

  beforeEach(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'dwarfai-case-')))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('[S-030-1] two case spellings of one folder give one mine key in an NTFS folder that folds case', async () => {
    mkdirSync(join(dir, 'Repo'))
    expect(existsSync(join(dir, 'REPO'))).toBe(true) // the folder folds case

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

  it('[S-030-1] two folders that differ only in case stay two mine keys, unfolded, in an NTFS folder with the per-directory case-sensitive flag', async () => {
    const exact = join(dir, 'exact')
    mkdirSync(exact)
    const fsutil = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'fsutil.exe')
    await runTool(fsutil, ['file', 'setCaseSensitiveInfo', exact, 'enable'])
    mkdirSync(join(exact, 'Repo'))
    mkdirSync(join(exact, 'repo')) // a second folder: the flag makes names compare exactly

    const host = inspector()

    expect((await host.resolve(join(exact, 'Repo'))).mineKey).toBe(
      canonicalMinePath(join(exact, 'Repo'), { style: 'win32', caseFold: false })
    )
    expect((await host.resolve(join(exact, 'repo'))).mineKey).toBe(
      canonicalMinePath(join(exact, 'repo'), { style: 'win32', caseFold: false })
    )
  })
})

describe.runIf(process.platform === 'linux')('mine keys on a Linux folder', () => {
  let dir = ''

  beforeEach(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'dwarfai-case-')))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('[S-030-1] two folders that differ only in case stay two mine keys, unfolded, in a folder that does not fold case', async () => {
    mkdirSync(join(dir, 'Repo'))
    expect(existsSync(join(dir, 'REPO'))).toBe(false) // the folder does not fold case
    mkdirSync(join(dir, 'repo')) // so this is a second folder

    const host = inspector()

    expect((await host.resolve(join(dir, 'Repo'))).mineKey).toBe(join(dir, 'Repo'))
    expect((await host.resolve(join(dir, 'repo'))).mineKey).toBe(join(dir, 'repo'))
  })
})

describe.runIf(process.platform === 'darwin')('mine keys on a macOS disk image', () => {
  const HDIUTIL = '/usr/bin/hdiutil'
  let root = ''
  const mounts: string[] = []

  /** A temporary disk image of `fs`, attached at a folder under `root` (no elevation). */
  async function attachImage(label: string, fs: string): Promise<string> {
    const image = join(root, `${label}.dmg`)
    const mount = join(root, `${label}-mnt`)
    mkdirSync(mount)
    await runTool(HDIUTIL, [
      'create',
      '-quiet',
      '-size',
      '32m',
      '-fs',
      fs,
      '-volname',
      label,
      image
    ])
    await runTool(HDIUTIL, [
      'attach',
      '-quiet',
      '-nobrowse',
      '-noverify',
      '-noautoopen',
      '-mountpoint',
      mount,
      image
    ])
    mounts.push(mount)
    return realpathSync.native(mount)
  }

  beforeAll(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dwarfai-case-')))
  })

  afterAll(async () => {
    for (const mount of mounts.splice(0)) {
      await runQuery(HDIUTIL, ['detach', mount, '-force'], { timeoutMs: COMMAND_TIMEOUT_MS })
    }
    rmSync(root, { recursive: true, force: true })
  }, SETUP_TIMEOUT_MS)

  it(
    '[S-030-1] two case spellings of one folder give one folded mine key on an APFS image',
    async () => {
      const volume = await attachImage('S0301-apfs', 'APFS')
      mkdirSync(join(volume, 'Repo'))
      expect(existsSync(join(volume, 'REPO'))).toBe(true) // the folder folds case

      const host = inspector()
      const keys = new Set([
        (await host.resolve(join(volume, 'Repo'))).mineKey,
        (await host.resolve(join(volume, 'REPO'))).mineKey
      ])

      expect([...keys]).toEqual([
        canonicalMinePath(join(volume, 'Repo'), { style: 'posix', caseFold: true })
      ])
    },
    SETUP_TIMEOUT_MS
  )

  it(
    '[S-030-1] two folders that differ only in case stay two mine keys, unfolded, on a Case-sensitive APFS image',
    async () => {
      const volume = await attachImage('S0301-apfs-cs', 'Case-sensitive APFS')
      mkdirSync(join(volume, 'Repo'))
      expect(existsSync(join(volume, 'REPO'))).toBe(false) // the folder does not fold case
      mkdirSync(join(volume, 'repo'))

      const host = inspector()

      expect((await host.resolve(join(volume, 'Repo'))).mineKey).toBe(join(volume, 'Repo'))
      expect((await host.resolve(join(volume, 'repo'))).mineKey).toBe(join(volume, 'repo'))
    },
    SETUP_TIMEOUT_MS
  )
})
