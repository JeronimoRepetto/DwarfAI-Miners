import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { protectDataDir, protectDbFiles, type FileModeInfo, type FileModes } from './fileProtection'

// L1/L3 (17 §1.1, §1.3): the data-at-rest protection of 09 §1, §9 (ADR-017 item 6; 18 C-24, T-36)
// over a fake of its file operations: which paths are narrowed, to which mode, and what is logged.
// The real modes are fileProtection.os.test.ts's (L8).

const DATA_DIR = join('home', 'j', '.config', 'DwarfAI', 'host')
const DB = join(DATA_DIR, 'dwarfai.db')

/** An in-memory tree of directories and files with permission bits; records every chmod. */
class FakeFileModes implements FileModes {
  readonly entries = new Map<string, FileModeInfo>()
  readonly chmods: Array<{ path: string; mode: number }> = []
  readonly madeDirs: Array<{ path: string; mode: number }> = []

  constructor(entries: Record<string, FileModeInfo> = {}) {
    for (const [path, info] of Object.entries(entries)) this.entries.set(path, { ...info })
  }

  inspect(path: string): Promise<FileModeInfo | null> {
    const info = this.entries.get(path)
    return Promise.resolve(info === undefined ? null : { ...info })
  }

  chmod(path: string, mode: number): Promise<void> {
    this.chmods.push({ path, mode })
    const info = this.entries.get(path)
    if (info !== undefined) info.mode = mode
    return Promise.resolve()
  }

  makeDir(path: string, mode: number): Promise<void> {
    this.madeDirs.push({ path, mode })
    if (!this.entries.has(path)) this.entries.set(path, { kind: 'dir', mode })
    return Promise.resolve()
  }

  list(dir: string): Promise<string[]> {
    const names = [...this.entries.keys()]
      .filter((path) => path.startsWith(`${dir}`) && path !== dir)
      .map((path) => path.slice(dir.length + 1))
      .filter((name) => name !== '' && !name.includes('/') && !name.includes('\\'))
    return Promise.resolve(names)
  }

  modeOf(path: string): number | undefined {
    return this.entries.get(path)?.mode
  }
}

const dir = (mode: number): FileModeInfo => ({ kind: 'dir', mode })
const file = (mode: number): FileModeInfo => ({ kind: 'file', mode })

describe('data directory and database file protection (09 §1, §9; ADR-017 item 6; C-24)', () => {
  it('[ADR-017] a hostDataDir found with mode 0755 is set to 0700 and the repair is logged', async () => {
    const files = new FakeFileModes({ [DATA_DIR]: dir(0o755) })
    const log = new RecordingDiagnosticsLog()

    await protectDataDir(DATA_DIR, { log, files, platform: 'linux' })

    expect(files.modeOf(DATA_DIR)).toBe(0o700)
    expect(log.byEvent('db.file-mode')).toEqual([
      {
        level: 'warn',
        event: 'db.file-mode',
        subsystem: 'host',
        causeClass: 'data-dir',
        outcome: 'ok',
        count: 1,
        msg: 'a looser mode was found and narrowed'
      }
    ])
  })

  it('[ADR-017] a missing hostDataDir is created 0700 and nothing is logged', async () => {
    const files = new FakeFileModes()
    const log = new RecordingDiagnosticsLog()

    await protectDataDir(DATA_DIR, { log, files, platform: 'darwin' })

    expect(files.madeDirs).toEqual([{ path: DATA_DIR, mode: 0o700 }])
    expect(files.modeOf(DATA_DIR)).toBe(0o700)
    expect(log.byEvent('db.file-mode')).toEqual([])
  })

  it('[ADR-017] a hostDataDir already 0700 is left as it is and nothing is logged', async () => {
    const files = new FakeFileModes({ [DATA_DIR]: dir(0o700) })
    const log = new RecordingDiagnosticsLog()

    await protectDataDir(DATA_DIR, { log, files, platform: 'linux' })

    expect(files.chmods).toEqual([])
    expect(log.byEvent('db.file-mode')).toEqual([])
  })

  it('[ADR-017] the database, WAL, SHM and every backup are set to 0600', async () => {
    const files = new FakeFileModes({
      [DATA_DIR]: dir(0o700),
      [DB]: file(0o644),
      [`${DB}-wal`]: file(0o644),
      [`${DB}-shm`]: file(0o664),
      [`${DB}.bak-v1-20250615T150740000Z`]: file(0o644),
      [`${DB}.bak-v2-20250616T150740000Z`]: file(0o600),
      [`${DB}.corrupt-20250617T150740000Z`]: file(0o644),
      [join(DATA_DIR, 'run')]: dir(0o700),
      [join(DATA_DIR, 'settings.json')]: file(0o644)
    })
    const log = new RecordingDiagnosticsLog()

    await protectDbFiles(DB, { log, files, platform: 'linux' })

    expect(files.modeOf(DB)).toBe(0o600)
    expect(files.modeOf(`${DB}-wal`)).toBe(0o600)
    expect(files.modeOf(`${DB}-shm`)).toBe(0o600)
    expect(files.modeOf(`${DB}.bak-v1-20250615T150740000Z`)).toBe(0o600)
    expect(files.modeOf(`${DB}.corrupt-20250617T150740000Z`)).toBe(0o600)
    // Only the database's own files: a file already 0600 and every other file are not touched.
    expect(files.chmods.map((call) => call.path).sort()).toEqual(
      [
        DB,
        `${DB}-wal`,
        `${DB}-shm`,
        `${DB}.bak-v1-20250615T150740000Z`,
        `${DB}.corrupt-20250617T150740000Z`
      ].sort()
    )
    // One record for the whole repair, however many files it narrowed.
    expect(log.byEvent('db.file-mode')).toEqual([
      {
        level: 'warn',
        event: 'db.file-mode',
        subsystem: 'host',
        causeClass: 'db-file',
        outcome: 'ok',
        count: 5,
        msg: 'a looser mode was found and narrowed'
      }
    ])
  })

  it('[ADR-017] a link named like a database file is never followed or changed', async () => {
    const files = new FakeFileModes({
      [DATA_DIR]: dir(0o700),
      [DB]: file(0o600),
      [`${DB}-wal`]: { kind: 'other', mode: 0o777 }
    })
    const log = new RecordingDiagnosticsLog()

    await protectDbFiles(DB, { log, files, platform: 'linux' })

    expect(files.chmods).toEqual([])
    expect(log.byEvent('db.file-mode')).toEqual([])
  })

  it('[ADR-017] on Windows no mode is changed: the files keep the per-user profile ACL they inherit', async () => {
    const files = new FakeFileModes({
      [DATA_DIR]: dir(0o666),
      [DB]: file(0o666)
    })
    const log = new RecordingDiagnosticsLog()

    await protectDataDir(DATA_DIR, { log, files, platform: 'win32' })
    await protectDbFiles(DB, { log, files, platform: 'win32' })

    expect(files.chmods).toEqual([])
    expect(files.madeDirs).toEqual([{ path: DATA_DIR, mode: 0o700 }])
    expect(log.byEvent('db.file-mode')).toEqual([])
  })
})
