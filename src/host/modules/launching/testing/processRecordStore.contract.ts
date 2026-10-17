// The ProcessRecordStore conformance suite (16 §4.5; 17 §1.3): run on the in-memory double and on
// the SQLite adapter. A process is keyed by its full identity (ADR-014 item 1, never a bare pid);
// `ended` drops the records of a pid recorded up to the exit instant and keeps a later process that
// reused the pid; every write runs inside the caller's transaction (16 §2.2).
import { afterEach, describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { HostEpoch, LaunchId } from '../../../kernel/domain/values'
import type { FakeClock } from '../../../kernel/fakes/FakeClock'
import type { ProcessRecord, ProcessRecordStore } from '../ports/processRecordStore'

export interface ProcessRecordStoreSubject {
  store: ProcessRecordStore
  /** Stamps each record's recording instant. */
  clock: FakeClock
  /** A launch that exists in the subject's store (the SQLite half seeds its `launches` row). */
  launchId: LaunchId
  /** The caller's transaction: commits when `work` returns, rolls back when it throws. */
  inTransaction<T>(work: () => T): T
  dispose(): void | Promise<void>
}

class CallerFailure extends Error {}

const EPOCH: HostEpoch = 'epoch-0161'
const BOOT = 'boot-0161'

function record(
  pid: number,
  extra: Partial<ProcessRecord> & { start?: number; bootId?: string } = {}
): ProcessRecord {
  const { start, bootId, ...rest } = extra
  return {
    identity: { pid, processStartTimeMs: start ?? 1_790_000_000_000 + pid, bootId: bootId ?? BOOT },
    purpose: 'session',
    hostEpoch: EPOCH,
    ...rest
  }
}

export function runProcessRecordStoreContract(
  makeSubject: () => ProcessRecordStoreSubject | Promise<ProcessRecordStoreSubject>
): void {
  describe('ProcessRecordStore', () => {
    let subject: ProcessRecordStoreSubject | null = null

    afterEach(async () => {
      await subject?.dispose()
      subject = null
    })

    const setUp = async () => {
      subject = await makeSubject()
      return subject
    }

    const putIn = (s: ProcessRecordStoreSubject, p: ProcessRecord) =>
      s.inTransaction(() => s.store.put(p))

    it('[ADR-015] a process is keyed by pid, start time and boot id, and a second put of the same identity is a no-op', async () => {
      const s = await setUp()
      const first = record(4100, { launchId: s.launchId })
      putIn(s, first)

      putIn(s, { ...first, purpose: 'launcher', hostEpoch: 'another-epoch' })
      const sameStartOtherBoot = record(4100, { bootId: 'boot-other' })
      const samePidOtherStart = record(4100, { start: first.identity.processStartTimeMs + 1 })
      putIn(s, sameStartOtherBoot)
      putIn(s, samePidOtherStart)

      expect(s.store.live()).toEqual([first, sameStartOtherBoot, samePidOtherStart])
    })

    it('[ADR-015] live excludes processes marked ended', async () => {
      const s = await setUp()
      const session = record(4200, { launchId: s.launchId })
      const relay = record(4201, { purpose: 'mcp-relay' })
      putIn(s, session)
      putIn(s, relay)
      s.clock.advance(1_000)

      s.inTransaction(() => s.store.ended(4200, s.clock.now()))

      expect(s.store.live()).toEqual([relay])
    })

    it('[ADR-015, INV-51] ended keeps a later process that reused the pid', async () => {
      const s = await setUp()
      const exited = record(4300)
      putIn(s, exited)
      s.clock.advance(1_000)
      const exitAt = s.clock.now()
      s.clock.advance(1_000)
      const reused = record(4300, { start: exited.identity.processStartTimeMs + 5_000 })
      putIn(s, reused)

      s.inTransaction(() => s.store.ended(4300, exitAt))

      expect(s.store.live()).toEqual([reused])
    })

    it('[ADR-015] a write outside a transaction is refused and a rolled-back put leaves nothing', async () => {
      const s = await setUp()
      const p = record(4400)

      expect(() => s.store.put(p)).toThrow(HostInvariantError)
      expect(() =>
        s.inTransaction(() => {
          s.store.put(p)
          throw new CallerFailure('the caller failed after recording')
        })
      ).toThrow(CallerFailure)
      putIn(s, p)
      expect(() => s.store.ended(4400, s.clock.now())).toThrow(HostInvariantError)

      expect(s.store.live()).toEqual([p])
    })
  })
}
