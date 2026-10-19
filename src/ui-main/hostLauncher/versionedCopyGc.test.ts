// Garbage collection of the Host's versioned copies (ADR-027 item 2, ADR-002 D5): at Host start the
// copies not used by a running Host and older than the two newest are deleted. L3-style over a
// temporary directory; a busy copy is injected through CopyOps (on Windows a running executable
// cannot be removed or opened for writing, while its folder can still be renamed:
// versionedCopyInUse.os.test.ts).
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RecordingUiLog } from './fakes/RecordingUiLog'
import { nodeCopyOps, type CopyOps } from './versionedCopy'
import { collectVersionedCopies, compareVersions } from './versionedCopyGc'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function rootWith(names: readonly string[]): string {
  const root = mkdtempSync(path.join(tmpdir(), 'dwarfai-031-gc-'))
  dirs.push(root)
  for (const name of names) {
    mkdirSync(path.join(root, name, 'resources'), { recursive: true })
    writeFileSync(path.join(root, name, 'app.exe'), name)
  }
  return root
}

describe('collectVersionedCopies (ADR-027 item 2)', () => {
  it('[ADR-027] when a Host is started, copies older than the two newest are deleted, the copy about to be used is kept, and a busy copy is skipped without failing the start', async () => {
    const root = rootWith(['0.8.0', '1.0.0', '1.9.0', '1.10.0', '1.11.0'])
    const busy = path.join(root, '0.8.0')
    const ops: CopyOps = {
      ...nodeCopyOps,
      rename: (from, to) =>
        from === busy
          ? Promise.reject(Object.assign(new Error('resource busy'), { code: 'EBUSY' }))
          : nodeCopyOps.rename(from, to)
    }
    const log = new RecordingUiLog()

    const report = await collectVersionedCopies({ root, inUse: '1.0.0', pid: 4242, ops, log })

    expect(report).toEqual({ deleted: ['1.9.0'], skipped: ['0.8.0'] })
    expect(readdirSync(root).sort()).toEqual(['0.8.0', '1.0.0', '1.10.0', '1.11.0'])
    expect(log.byEvent('versioned-copy')).toMatchObject([
      { level: 'warn', outcome: 'skipped', causeClass: 'gc', errCode: 'EBUSY' },
      { level: 'info', outcome: 'ok', causeClass: 'gc' }
    ])
  })

  it('[ADR-027] an old copy a running process still executes from is skipped whole, never renamed aside or removed', async () => {
    // On Windows the folder of a running executable can be renamed, and a removal deletes every file but the held
    // ones (versionedCopyInUse.os.test.ts), so the rename is no busy test: a held file is.
    const root = rootWith(['0.8.0', '1.10.0', '1.11.0'])
    const held = path.join(root, '0.8.0')
    const calls: string[] = []
    const ops: CopyOps = {
      ...nodeCopyOps,
      busyFile: async (dir) => (dir === held ? 'EBUSY' : nodeCopyOps.busyFile(dir)),
      rename: async (from, to) => {
        calls.push(`rename ${path.basename(from)}`)
        await nodeCopyOps.rename(from, to)
      },
      removeTree: async (target) => {
        calls.push(`removeTree ${path.basename(target)}`)
        await nodeCopyOps.removeTree(target)
      }
    }
    const log = new RecordingUiLog()

    const report = await collectVersionedCopies({ root, inUse: '1.11.0', pid: 5, ops, log })

    expect(report).toEqual({ deleted: [], skipped: ['0.8.0'] })
    expect(calls).toEqual([])
    expect(readdirSync(root).sort()).toEqual(['0.8.0', '1.10.0', '1.11.0'])
    expect(readdirSync(held).sort()).toEqual(['app.exe', 'resources'])
    expect(log.byEvent('versioned-copy')).toMatchObject([
      { level: 'warn', outcome: 'skipped', causeClass: 'gc', errCode: 'EBUSY' }
    ])
  })

  it('[ADR-027, FM-129] a copy renamed aside but not removed stays as a .tmp- leftover for the next start, and temporary directories are never counted as copies', async () => {
    const root = rootWith(['1.0.0', '2.0.0', '3.0.0', '3.0.0.tmp-77'])
    const ops: CopyOps = {
      ...nodeCopyOps,
      removeTree: () => Promise.reject(Object.assign(new Error('denied'), { code: 'EPERM' }))
    }
    const log = new RecordingUiLog()

    const report = await collectVersionedCopies({ root, inUse: '3.0.0', pid: 9, ops, log })

    expect(report).toEqual({ deleted: [], skipped: ['1.0.0'] })
    expect(readdirSync(root).sort()).toEqual(['1.0.0.tmp-9-gc', '2.0.0', '3.0.0', '3.0.0.tmp-77'])
  })

  it('[ADR-027] a root that cannot be read collects nothing and does not fail the start', async () => {
    const log = new RecordingUiLog()
    const missing = path.join(rootWith([]), 'absent')

    const report = await collectVersionedCopies({
      root: missing,
      inUse: '1.0.0',
      pid: 1,
      ops: nodeCopyOps,
      log
    })

    expect(report).toEqual({ deleted: [], skipped: [] })
  })

  it('[ADR-027] "newest" is version precedence: 1.10.0 is newer than 1.9.0, and a prerelease is older than its release', () => {
    const sorted = ['1.9.0', '2.0.0', '1.10.0', '2.0.0-beta.2', '2.0.0-beta.10', 'dev', '0.1.0']
      .slice()
      .sort(compareVersions)
    expect(sorted).toEqual([
      'dev',
      '0.1.0',
      '1.9.0',
      '1.10.0',
      '2.0.0-beta.2',
      '2.0.0-beta.10',
      '2.0.0'
    ])
  })
})
