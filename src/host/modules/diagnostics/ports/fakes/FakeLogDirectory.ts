// The LogDirectory double (16 §4.13): a listing of one folder of a FakeFs, so a writer's appends
// and deletions through the FakeFs are what the listing reports. It runs the same
// runLogDirectoryContract as FsLogDirectory. Never imported by production code (R14). A ports
// folder imports types only (R2), so the two listing rules are restated here and held equal to
// FsLogDirectory's by the shared contract.
import type { FakeFs } from '../../../../kernel/fakes/FakeFs'
import type { LogDirectory } from '../logDirectory'

/** ADR-026 item 1, 19 §2: `<prefix><six-digit seq>.jsonl`. */
const SEGMENT_NAME = /^(host-|ui-|shim-)\d{6}\.jsonl$/
/** A written line starts with its `ts` field (`toLogLine` writes `LogRecord` field order). */
const FIRST_TS = /^\{"ts":"([^"\\r\n]{1,64})"/
const HEAD_BYTES = 128

export class FakeLogDirectory implements LogDirectory {
  constructor(
    private readonly fs: FakeFs,
    private readonly dir: string
  ) {}

  segments(): readonly { name: string; bytes: number; firstTs: string }[] {
    const entries = this.fs.entriesNow(this.dir) ?? []
    return entries
      .filter((entry) => !entry.isDirectory && SEGMENT_NAME.test(entry.name))
      .map((entry) => {
        const head = this.fs.headNow(`${this.dir}/${entry.name}`, HEAD_BYTES) ?? ''
        return { name: entry.name, bytes: entry.size, firstTs: FIRST_TS.exec(head)?.[1] ?? '' }
      })
  }
}
