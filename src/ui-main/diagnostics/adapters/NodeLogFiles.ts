// The real LogFiles (05 §3.13 UI side; ADR-026 items 1–2): the shared `logs/` folder on disk. Every OS failure is
// a value: a folder that vanished is `not-found` (the writer opens its next segment, FM-108), any other failure is
// `failed`, and a file another writer deletes between the listing and its read is simply not listed (the benign
// ENOENT race of ADR-026 item 2).
import { appendFile, mkdir, open, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { parseSegmentName, type SegmentInfo } from '@dwarfai/contracts'
import type { AppendOutcome, LogFiles } from '../ports/logFiles'

/** A written line starts with its `ts` field (`toLogLine` writes `LogRecord` field order). */
const FIRST_TS = /^\{"ts":"([^"\\\r\n]{1,64})"/
const HEAD_BYTES = 128

export class NodeLogFiles implements LogFiles {
  async makeDir(dir: string): Promise<boolean> {
    try {
      await mkdir(dir, { recursive: true })
      return true
    } catch {
      return false
    }
  }

  async append(path: string, data: string): Promise<AppendOutcome> {
    try {
      await appendFile(path, data, 'utf8')
      return 'ok'
    } catch (error) {
      return (error as { code?: unknown }).code === 'ENOENT' ? 'not-found' : 'failed'
    }
  }

  async remove(path: string): Promise<boolean> {
    try {
      await unlink(path)
      return true
    } catch {
      return false
    }
  }

  async segments(dir: string): Promise<SegmentInfo[]> {
    let names: string[]
    try {
      names = (await readdir(dir, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && parseSegmentName(entry.name) !== null)
        .map((entry) => entry.name)
    } catch {
      return []
    }
    const listed: SegmentInfo[] = []
    for (const name of names) {
      const segment = await readSegment(join(dir, name))
      if (segment !== null) listed.push({ name, ...segment })
    }
    return listed
  }
}

async function readSegment(path: string): Promise<{ bytes: number; firstTs: string } | null> {
  try {
    const { size } = await stat(path)
    const handle = await open(path, 'r')
    try {
      const head = Buffer.alloc(Math.min(size, HEAD_BYTES))
      const { bytesRead } = await handle.read(head, 0, head.length, 0)
      const firstTs = FIRST_TS.exec(head.subarray(0, bytesRead).toString('utf8'))?.[1] ?? ''
      return { bytes: size, firstTs }
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}
