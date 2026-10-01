// `<hostDataDir>/run/host.identity` (ADR-002 D3, D7, D9; 09 §1 "Run-time credentials and locks"):
// the running Host's process identity (ADR-014 item 1: `pid`, `processStartTimeMs`, `bootId`) plus
// its boot epoch, in the shape contracts/host-protocol/runFiles.ts shares with the UI reader.
//
// - publish() writes it right after the endpoint bind and before any `hello` is answered: `0600`,
//   by temp + rename (RunFileWriter), so a reader sees the whole file or none. The identity is this
//   process as the OS reports it (ProcessControl.probe). When that cannot be read, nothing is
//   written and a previous boot's file is removed: an identity the UI could not match would only
//   make the hung-Host end signal nothing (`identity-missing`, ADR-002 D9), never a wrong process.
// - deferUntilPublished(published, accept) holds every connection accepted after the bind until
//   the run files exist, so no `hello` is read, let alone answered, before them; if they cannot be
//   written the held connections are closed unanswered.
// - remove() deletes it at the clean exit (cleanExit.ts, ADR-002 D7). A crash leaves it behind; the
//   ADR-015 item 6 cleanup sweeps a stale one.
//
// The file is not a secret and grants nothing.
import { join } from 'node:path'
import {
  HOST_IDENTITY_FILE,
  hostIdentityRecordSchema,
  type HostIdentityRecord
} from '@dwarfai/contracts'
import type { ProcessControl } from '../../kernel/ports/processControl'

/** The run folder's file store (nodeRunFileWriter.ts in production). */
export interface RunFileWriter {
  /**
   * Writes `text` to `path` as a file of mode `0600` through a temporary sibling renamed over it,
   * creating the folder `0700` when it is missing; throws when it cannot.
   */
  writeAtomic(path: string, text: string): Promise<void>
  /** Deletes the file; a file already gone is a success. */
  remove(path: string): Promise<void>
}

export interface HostIdentityFileDeps {
  /** `<hostDataDir>/run`. */
  runDir: string
  writer: RunFileWriter
  /** Reads this process's identity as the OS reports it. */
  processes: Pick<ProcessControl, 'probe'>
  /** This Host process's pid. */
  pid: number
  /** This boot's epoch (mintBootEpoch). */
  epoch: string
}

export type PublishOutcome = 'written' | 'identity-unreadable'

export class HostIdentityFile {
  private readonly path: string

  constructor(private readonly deps: HostIdentityFileDeps) {
    this.path = join(deps.runDir, HOST_IDENTITY_FILE)
  }

  /** Writes `run/host.identity`; throws when the file cannot be written. */
  async publish(): Promise<PublishOutcome> {
    const self = await this.deps.processes.probe(this.deps.pid)
    if (self === 'absent' || self === 'unknown') {
      await this.deps.writer.remove(this.path)
      return 'identity-unreadable'
    }
    const record: HostIdentityRecord = hostIdentityRecordSchema.parse({
      pid: self.pid,
      processStartTimeMs: self.processStartTimeMs,
      bootId: self.bootId,
      epoch: this.deps.epoch
    })
    await this.deps.writer.writeAtomic(this.path, JSON.stringify(record))
    return 'written'
  }

  /** Deletes `run/host.identity` (the clean exit). */
  remove(): Promise<void> {
    return this.deps.writer.remove(this.path)
  }
}

/**
 * Hands each accepted connection to `accept` only once `published` resolves; a connection accepted
 * before is held, its bytes buffered unread. If `published` rejects, every held connection is
 * closed unanswered.
 */
export function deferUntilPublished<T extends { destroy(): void }>(
  published: Promise<unknown>,
  accept: (connection: T) => void
): (connection: T) => void {
  const ready = published.then(
    () => true,
    () => false
  )
  return (connection) => {
    void ready.then((ok) => (ok ? accept(connection) : connection.destroy()))
  }
}
