// The LogDirectory conformance suite (16 §4.13, 17 §1.3): run against FakeLogDirectory over a
// FakeFs and against FsLogDirectory over a per-test temporary directory.
import { describe, expect, it } from 'vitest'
import type { LogDirectory } from '../ports/logDirectory'

export interface LogDirectorySubject {
  /** A LogDirectory listing the folder at `path`. */
  directoryAt(path: string): LogDirectory
  /** A path under the subject's own empty root, built from path segments. */
  pathOf(...segments: string[]): string
  /** Puts a file on the subject's storage (parents included). */
  seed(path: string, content: string): Promise<void>
}

const line = (ts: string, event: string): string =>
  `{"ts":"${ts}","level":"info","proc":"host","pid":7,"appVersion":"1.0.0","event":"${event}","subsystem":"host"}\n`

export function runLogDirectoryContract(
  makeSubject: () => LogDirectorySubject | Promise<LogDirectorySubject>
): void {
  describe('LogDirectory contract', () => {
    it('[ADR-026] segments list names, sizes and first-record timestamps across host-, ui- and shim- prefixes; a missing folder lists empty', async () => {
      const { directoryAt, pathOf, seed } = await makeSubject()
      const hostLines =
        line('2026-10-02T09:14:03.120Z', 'host.start') +
        line('2026-10-02T09:15:00.000Z', 'host.ready')
      const uiLines = line('2026-10-01T08:00:00.000Z', 'ui.start')
      const shimLines = line('2026-10-03T10:00:00.500Z', 'shim.failed')
      await seed(pathOf('logs', 'host-000001.jsonl'), hostLines)
      await seed(pathOf('logs', 'ui-000003.jsonl'), uiLines)
      await seed(pathOf('logs', 'shim-000002.jsonl'), shimLines)
      // A segment just opened by another writer holds no record yet: its first timestamp is unknown.
      await seed(pathOf('logs', 'host-000002.jsonl'), '')
      // Anything that is not a segment is not listed.
      await seed(pathOf('logs', 'notes.txt'), 'kept by a person')
      await seed(pathOf('logs', 'host-1.jsonl'), line('2026-10-01T00:00:00.000Z', 'x'))
      await seed(
        pathOf('logs', 'nested', 'host-000009.jsonl'),
        line('2026-10-01T00:00:00.000Z', 'x')
      )

      const listed = [...directoryAt(pathOf('logs')).segments()].sort((a, b) =>
        a.name < b.name ? -1 : 1
      )
      expect(listed).toEqual([
        {
          name: 'host-000001.jsonl',
          bytes: Buffer.byteLength(hostLines),
          firstTs: '2026-10-02T09:14:03.120Z'
        },
        { name: 'host-000002.jsonl', bytes: 0, firstTs: '' },
        {
          name: 'shim-000002.jsonl',
          bytes: Buffer.byteLength(shimLines),
          firstTs: '2026-10-03T10:00:00.500Z'
        },
        {
          name: 'ui-000003.jsonl',
          bytes: Buffer.byteLength(uiLines),
          firstTs: '2026-10-01T08:00:00.000Z'
        }
      ])

      expect(directoryAt(pathOf('missing', 'logs')).segments()).toEqual([])
    })
  })
}
