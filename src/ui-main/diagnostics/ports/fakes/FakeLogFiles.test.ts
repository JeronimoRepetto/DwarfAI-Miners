import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runLogFilesContract } from '../../testing/logFiles.contract'
import { FakeLogFiles } from './FakeLogFiles'

describe('FakeLogFiles (16 §2.8: the double runs the adapter contract)', () => {
  runLogFilesContract('FakeLogFiles', async () => {
    const files = new FakeLogFiles()
    const root = join('/', 'fake-root')
    await files.makeDir(root)
    return {
      files,
      root,
      plantOtherFile: async (dir, name) => files.plant(join(dir, name), 'not a segment\n')
    }
  })

  // The cap tests read totalBytes and peakBytes; these pin their accounting through every way a file's size
  // changes, so the per-folder running total stays equal to the sum of the folder's files.
  it('[ADR-026] totalBytes and peakBytes follow seeds, appends, re-seeds, removals and a deleted folder', async () => {
    const files = new FakeLogFiles()
    const dir = join('/', 'logs')
    const other = join('/', 'other')
    files.seed(join(dir, 'host-000001.jsonl'), 1_000, '2026-10-01T09:00:00.000Z')
    files.seed(join(other, 'host-000001.jsonl'), 7_000, '2026-10-01T09:00:00.000Z')
    expect(await files.append(join(dir, 'ui-000001.jsonl'), 'abc\n')).toBe('ok')
    expect(await files.append(join(dir, 'ui-000001.jsonl'), 'é\n')).toBe('ok')
    expect(files.totalBytes(dir)).toBe(1_007)
    expect(files.peakBytes(dir)).toBe(1_007)

    // A re-seed replaces the file's size, it does not add to it.
    files.seed(join(dir, 'host-000001.jsonl'), 400, '2026-10-01T09:00:00.000Z')
    expect(files.totalBytes(dir)).toBe(407)
    expect(files.peakBytes(dir)).toBe(1_007)

    expect(await files.remove(join(dir, 'ui-000001.jsonl'))).toBe(true)
    expect(await files.remove(join(dir, 'ui-000001.jsonl'))).toBe(false)
    expect(files.totalBytes(dir)).toBe(400)

    // A planted file counts once its folder exists; a deleted folder counts nothing.
    files.plant(join(dir, 'notes.txt'), 'hello\n')
    expect(files.totalBytes(dir)).toBe(406)
    files.removeDir(dir)
    expect(files.totalBytes(dir)).toBe(0)
    expect(files.peakBytes(dir)).toBe(1_007)
    expect(await files.makeDir(dir)).toBe(true)
    expect(files.totalBytes(dir)).toBe(0)
    expect(files.totalBytes(other)).toBe(7_000)
  })
})
