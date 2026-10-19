// The ObservationAdapter double (16 §4.3 `FakeObservationAdapter`: scripted events). Never imported
// by production code (R14). A test lists its sources and scripts each stream's `read`: the script
// gets the cursor it is read from and answers the batch, or throws (an adapter failure, INV-38).
// Every read is recorded. Type-only imports (05 R2).
import type { ProviderId } from '../../../../kernel/domain/values'
import type { FileSystem } from '../../../../kernel/ports/fileSystem'
import type { ObservedCapabilities } from '../../../suppliers'
import type { Cursor, ObservationAdapter, ObservedEvent, SourceFile } from '../observationAdapter'

export interface ScriptedBatch {
  events: ObservedEvent[]
  next: Cursor
  warnings: string[]
}

export type ReadScript = (from: Cursor | null, source: SourceFile) => ScriptedBatch

export class FakeObservationAdapter implements ObservationAdapter {
  readonly cursorKind: 'byte-offset' | 'watermark' | 'no-actions'
  /** What `discover` answers; a test changes it between cycles. */
  sources: SourceFile[] = []
  /** Every `read`, in order. */
  readonly reads: Array<{ streamId: string; from: Cursor | null }> = []
  private readonly scripts = new Map<string, ReadScript>()

  constructor(
    readonly providerId: ProviderId,
    options: { cursorKind?: 'byte-offset' | 'watermark' | 'no-actions' } = {}
  ) {
    this.cursorKind = options.cursorKind ?? 'byte-offset'
  }

  capabilities(): ObservedCapabilities {
    return {}
  }

  /** Scripts the reads of `streamId` (the stream id the loop reads, generation included). */
  onRead(streamId: string, script: ReadScript): void {
    this.scripts.set(streamId, script)
  }

  discover(_fs: FileSystem): Promise<SourceFile[]> {
    return Promise.resolve(this.sources.map((s) => ({ ...s })))
  }

  read(
    source: SourceFile,
    from: Cursor | null
  ): Promise<{ events: ObservedEvent[]; next: Cursor; warnings: string[] }> {
    this.reads.push({ streamId: source.streamId, from: from === null ? null : { ...from } })
    const script = this.scripts.get(source.streamId)
    if (script === undefined) {
      return Promise.resolve({
        events: [],
        next: from ?? {
          adapterId: this.providerId,
          kind: this.cursorKind === 'no-actions' ? 'none' : this.cursorKind,
          value: 0,
          fileIdentity: source.fileIdentity
        },
        warnings: []
      })
    }
    try {
      return Promise.resolve(script(from, source))
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }
}
