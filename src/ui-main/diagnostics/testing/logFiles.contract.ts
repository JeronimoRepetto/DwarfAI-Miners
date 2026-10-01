// The LogFiles contract (17 §1.3, 16 §2.8): one suite run by the real adapter over a per-test temporary folder and
// by the double, so the double cannot drift from what the disk does.
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { LogFiles } from '../ports/logFiles'

export interface LogFilesSubject {
  readonly files: LogFiles
  /** An existing, empty folder for this test only. */
  readonly root: string
  /** Puts a file that is not a log segment into `dir` (the folder exists). */
  plantOtherFile(dir: string, name: string): Promise<void>
}

const LINE = '{"ts":"2026-10-01T10:00:00.000Z","level":"info"}\n'

export function runLogFilesContract(name: string, subject: () => Promise<LogFilesSubject>): void {
  it(`[ADR-026] ${name}: an append creates the segment and the listing reports its bytes and first ts`, async () => {
    const { files, root } = await subject()
    const dir = join(root, 'logs')
    expect(await files.makeDir(dir)).toBe(true)
    expect(await files.append(join(dir, 'ui-000001.jsonl'), LINE)).toBe('ok')
    expect(await files.append(join(dir, 'ui-000001.jsonl'), '{"ts":"later","msg":"é"}\n')).toBe(
      'ok'
    )
    expect(await files.segments(dir)).toEqual([
      {
        name: 'ui-000001.jsonl',
        bytes: Buffer.byteLength(LINE) + Buffer.byteLength('{"ts":"later","msg":"é"}\n'),
        firstTs: '2026-10-01T10:00:00.000Z'
      }
    ])
  })

  it(`[ADR-026] ${name}: the listing holds only segment files, and an empty segment has no first ts`, async () => {
    const { files, root, plantOtherFile } = await subject()
    const dir = join(root, 'logs')
    await files.makeDir(dir)
    await plantOtherFile(dir, 'notes.txt')
    await plantOtherFile(dir, 'ui-1.jsonl')
    await files.append(join(dir, 'host-000003.jsonl'), '')
    const listed = await files.segments(dir)
    expect(listed).toEqual([{ name: 'host-000003.jsonl', bytes: 0, firstTs: '' }])
  })

  it(`[ADR-026] ${name}: a missing folder lists nothing and an append into it is not-found`, async () => {
    const { files, root } = await subject()
    const dir = join(root, 'gone')
    expect(await files.segments(dir)).toEqual([])
    expect(await files.append(join(dir, 'ui-000001.jsonl'), LINE)).toBe('not-found')
  })

  it(`[ADR-026] ${name}: makeDir creates parents and remove deletes once`, async () => {
    const { files, root } = await subject()
    const dir = join(root, 'a', 'b', 'logs')
    expect(await files.makeDir(dir)).toBe(true)
    expect(await files.makeDir(dir)).toBe(true)
    await files.append(join(dir, 'shim-000001.jsonl'), LINE)
    expect(await files.remove(join(dir, 'shim-000001.jsonl'))).toBe(true)
    expect(await files.remove(join(dir, 'shim-000001.jsonl'))).toBe(false)
    expect(await files.segments(dir)).toEqual([])
  })
}
