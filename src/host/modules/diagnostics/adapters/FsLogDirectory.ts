// The real LogDirectory (05 §3.13, 16 §4.13): lists the segment files of the shared `logs/` folder
// with their sizes and first-record timestamps. Synchronous, as the port is: the folder holds about
// twenty segments at most and only the first bytes of each are read. A file another writer deletes
// between the listing and its read is simply not listed (the benign ENOENT race of ADR-026 item 2).
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseSegmentName } from '../../../../contracts/logging'
import type { LogDirectory } from '../ports/logDirectory'

/** A written line starts with its `ts` field (`toLogLine` writes `LogRecord` field order). */
const FIRST_TS = /^\{"ts":"([^"\\r\n]{1,64})"/
const HEAD_BYTES = 128

export class FsLogDirectory implements LogDirectory {
  constructor(private readonly dir: string) {}

  segments(): readonly { name: string; bytes: number; firstTs: string }[] {
    let names: string[]
    try {
      names = readdirSync(this.dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && parseSegmentName(entry.name) !== null)
        .map((entry) => entry.name)
    } catch {
      // A missing or unreadable folder lists nothing; the writer recreates it (FM-108).
      return []
    }
    const listed: { name: string; bytes: number; firstTs: string }[] = []
    for (const name of names) {
      const segment = readSegment(join(this.dir, name))
      if (segment !== null) listed.push({ name, ...segment })
    }
    return listed
  }
}

function readSegment(path: string): { bytes: number; firstTs: string } | null {
  try {
    const bytes = statSync(path).size
    const fd = openSync(path, 'r')
    try {
      const head = Buffer.alloc(Math.min(bytes, HEAD_BYTES))
      const read = readSync(fd, head, 0, head.length, 0)
      const firstTs = FIRST_TS.exec(head.subarray(0, read).toString('utf8'))?.[1] ?? ''
      return { bytes, firstTs }
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}
