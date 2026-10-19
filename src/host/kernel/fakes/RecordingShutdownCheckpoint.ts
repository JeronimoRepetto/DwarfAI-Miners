// The ShutdownCheckpoint double (16 §2.8 `Recording<Port>`): keeps every call in order, and writes
// each one to an optional shared journal so a test can order the checkpoint against the frames
// and the exit. Never imported by production code (R14).
import type { CleanShutdownReason, ShutdownCheckpoint } from '../ports/shutdownCheckpoint'

export type CheckpointCall = { kind: 'flush' } | { kind: 'markClean'; reason: CleanShutdownReason }

export class RecordingShutdownCheckpoint implements ShutdownCheckpoint {
  /** Every call, in call order. */
  readonly calls: CheckpointCall[] = []

  constructor(private readonly journal?: string[]) {}

  flush(): void {
    this.calls.push({ kind: 'flush' })
    this.journal?.push('checkpoint.flush')
  }

  markClean(reason: CleanShutdownReason): void {
    this.calls.push({ kind: 'markClean', reason })
    this.journal?.push(`checkpoint.markClean:${reason}`)
  }
}
