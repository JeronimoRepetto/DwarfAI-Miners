// The ObservedSessionStore conformance suite (16 §4.3; 17 §1.3): run on
// `InMemoryObservedSessionStore` and on `SqliteObservedSessionStore` (template DB). One row per
// identity (ADR-015 item 7), saved inside the caller's transaction; the index answers the dwarf
// bound to an identity (the dwarf's UNIQUE key) before observation saved its row, and a departed
// dwarf's session as closed (S4.40).
import { describe, expect, it } from 'vitest'
import type { DwarfId, FolderPath, Instant, ProviderIdentity } from '../../../kernel/domain/values'
import type { ObservedSession, ObservedSessionStore } from '../ports/observedSessionStore'

export interface ObservedSessionStoreSubject {
  store: ObservedSessionStore
  /** The caller's transaction: commits when `work` returns, rolls back when it throws. */
  inTransaction<T>(work: () => T): T
  /** A dwarf bound to `identity` arrives in the mine of `folder` at `at` (crew's write). */
  bindDwarf(identity: ProviderIdentity, folder: FolderPath, at: Instant): DwarfId
  /** That dwarf departs at `at` (crew's write). */
  departDwarf(dwarfId: DwarfId, at: Instant): void
  /** The stored `observed_sessions` rows. The streams `simulated:a` and `simulated:b` exist. */
  rowCount(): number
}

const T0 = 1_790_000_000_000
const FOLDER = '/work/moria' as FolderPath
const CWD = '/work/moria/src' as FolderPath
const ROOT: ProviderIdentity = { providerId: 'simulated', providerSessionId: 'session-1' }

function session(dwarfId: DwarfId, extra: Partial<ObservedSession> = {}): ObservedSession {
  return {
    identity: ROOT,
    dwarfId,
    cwd: CWD,
    firstSeenAt: T0 + 10,
    lastRecordAt: T0 + 10,
    closedAt: null,
    ...extra
  }
}

export function runObservedSessionStoreContract(
  makeSubject: () => ObservedSessionStoreSubject
): void {
  describe('ObservedSessionStore contract', () => {
    it('[ADR-015] byIdentity finds the observed session saved inside the batch transaction and a second save of the same identity keeps one row', () => {
      const subject = makeSubject()
      const { store } = subject
      const dwarfId = subject.bindDwarf(ROOT, FOLDER, T0)

      const seenInside = subject.inTransaction(() => {
        store.save(session(dwarfId))
        return store.byIdentity(ROOT)
      })
      expect(seenInside).toEqual(session(dwarfId))

      subject.inTransaction(() => store.save(session(dwarfId, { lastRecordAt: T0 + 99 })))
      expect(store.byIdentity(ROOT)).toEqual(session(dwarfId, { lastRecordAt: T0 + 99 }))
      expect(subject.rowCount()).toBe(1)
    })

    it('[ADR-015] byIdentity answers the dwarf bound to an identity before its row is saved, and null for an unknown one', () => {
      const subject = makeSubject()
      expect(subject.store.byIdentity(ROOT)).toBeNull()
      const dwarfId = subject.bindDwarf(ROOT, FOLDER, T0)
      expect(subject.store.byIdentity(ROOT)).toEqual({
        identity: ROOT,
        dwarfId,
        cwd: FOLDER,
        firstSeenAt: T0,
        lastRecordAt: T0,
        closedAt: null
      })
      expect(subject.store.byIdentity({ ...ROOT, providerAgentId: 'agent-1' })).toBeNull()
      expect(subject.rowCount()).toBe(0)
    })

    it('[ADR-015] streams lists the streams of a session once each, by stream id', () => {
      const subject = makeSubject()
      const { store } = subject
      const dwarfId = subject.bindDwarf(ROOT, FOLDER, T0)
      subject.inTransaction(() => {
        store.save(session(dwarfId))
        store.saveStream({ dwarfId, streamId: 'simulated:b' })
        store.saveStream({ dwarfId, streamId: 'simulated:a' })
        store.saveStream({ dwarfId, streamId: 'simulated:b' })
      })
      expect(store.streams(dwarfId)).toEqual([
        { dwarfId, streamId: 'simulated:a' },
        { dwarfId, streamId: 'simulated:b' }
      ])
      expect(store.streams('00000000-0000-7000-8000-00000000ffff')).toEqual([])
    })

    it('[S4.40] a departed dwarf answers its departure as closedAt, a closed row keeps its own', () => {
      const subject = makeSubject()
      const { store } = subject
      const dwarfId = subject.bindDwarf(ROOT, FOLDER, T0)
      subject.inTransaction(() => store.save(session(dwarfId)))
      subject.departDwarf(dwarfId, T0 + 50)
      expect(store.byIdentity(ROOT)?.closedAt).toBe(T0 + 50)

      subject.inTransaction(() => store.save(session(dwarfId, { closedAt: T0 + 40 })))
      expect(store.byIdentity(ROOT)?.closedAt).toBe(T0 + 40)
    })

    it('[ADR-015] a save outside the caller transaction is refused, and a rolled-back one leaves nothing', () => {
      const subject = makeSubject()
      const { store } = subject
      const dwarfId = subject.bindDwarf(ROOT, FOLDER, T0)
      expect(() => store.save(session(dwarfId))).toThrow(/inside the caller transaction/)
      expect(() =>
        subject.inTransaction(() => {
          store.save(session(dwarfId))
          store.saveStream({ dwarfId, streamId: 'simulated:a' })
          throw new Error('the batch failed')
        })
      ).toThrow('the batch failed')
      expect(subject.rowCount()).toBe(0)
      expect(store.streams(dwarfId)).toEqual([])
    })
  })
}
