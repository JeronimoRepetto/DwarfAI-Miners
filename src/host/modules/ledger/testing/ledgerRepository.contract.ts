// The LedgerRepository conformance suite (16 §4.10 doubles row: transplanted `ledger.test.ts:166`
// and `:308`, duplicate credits once; 17 §1.3), run on `InMemoryLedgerRepository` and on
// `SqliteLedgerRepository` over the template database. It covers the members of 16 §4.10 (as
// amended 2026-10-05) built here, the crediting reads included (see ports/ledgerRepository.ts). The
// transplanted `:166` (never coal from live) is the domain's INV-95 case and the L5 CHECK case.
// Never imported by production code (R14).
import { afterEach, describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { UsageObservation } from '../../../kernel/domain/sharedContracts'
import type { DwarfId, Instant, MineId } from '../../../kernel/domain/values'
import type { UsagePath } from '../domain/credit'
import { MATERIALS, type LiveMaterial, type Material } from '../domain/materials'
import type { LedgerRepository } from '../ports/ledgerRepository'

/** One stored `ledger_entries` row. */
export interface StoredEntry {
  unitKey: string
  material: Material
  tokens: number
  units: number
  kind: 'live' | 'coal-backfill'
}

export interface LedgerRepositorySubject {
  /** The repository under test, over the subject's one storage. */
  repository: LedgerRepository
  /** The caller's transaction (16 §2.2): commits when `work` returns, rolls back when it throws. */
  inTransaction<T>(work: () => T): T
  /** A mine measured with `tier`, or never measured (`null`). */
  addMine(tier: LiveMaterial | null): MineId
  /** A dwarf of `mineId` whose stored authoritative path is `usagePath`. */
  addDwarf(mineId: MineId, usagePath: UsagePath): DwarfId
  /** Rewrites the install moment; `null` removes it (between a reset's `db` and `install-moment` steps). */
  setInstallMoment(at: Instant | null): void
  /** Opens (`true`) or finishes (`false`) a reset saga (`reset_journal`). */
  setResetInProgress(inProgress: boolean): void
  /** Every ledger entry of the mine, by unit key. */
  entries(mineId: MineId): StoredEntry[]
  /** The stored `ledger_entries.id` of every entry of the mine. */
  entryIds(mineId: MineId): string[]
  dispose(): void | Promise<void>
}

export const CONTRACT_INSTALL_MOMENT = 1_760_000_000_000

/** A usage observation of `dwarfId`, sealed and after the install moment unless overridden. */
export function usageObservation(
  dwarfId: DwarfId,
  overrides: Partial<UsageObservation> = {}
): UsageObservation {
  return {
    sourceKey: 'claude:claude:session-1:msg-1',
    unitKey: 'claude:session-1:msg-1',
    dwarfId,
    fidelity: 1,
    tokens: { inputNet: 1_000, output: 200, cacheRead: 4_000, cacheWrite: 0, reasoning: 0 },
    sealed: true,
    providerTime: CONTRACT_INSTALL_MOMENT + 10_000,
    observedAt: CONTRACT_INSTALL_MOMENT + 10_200,
    ...overrides
  }
}

export function runLedgerRepositoryContract(
  makeSubject: () => LedgerRepositorySubject | Promise<LedgerRepositorySubject>
): void {
  describe('LedgerRepository contract', () => {
    let subject: LedgerRepositorySubject | null = null

    afterEach(async () => {
      await subject?.dispose()
      subject = null
    })

    const setUp = async (): Promise<LedgerRepositorySubject> => {
      subject = await makeSubject()
      subject.setInstallMoment(CONTRACT_INSTALL_MOMENT)
      return subject
    }

    it('[ADR-006] credit with the same unit key twice answers duplicate and totals equal the sum of ledger entries', async () => {
      const s = await setUp()
      const mine = s.addMine('silver')
      const dwarf = s.addDwarf(mine, 'transcript')
      const store = s.repository
      const first = usageObservation(dwarf, { unitKey: 'u-1', sourceKey: 'k-1' })
      const second = usageObservation(dwarf, { unitKey: 'u-2', sourceKey: 'k-2' })

      const answers = s.inTransaction(() => {
        store.record(first, mine, 'transcript')
        store.record(second, mine, 'transcript')
        return [
          store.credit('u-1', mine, 'silver', 60_000, 1, 'live'),
          store.credit('u-1', mine, 'silver', 60_000, 1, 'live'),
          store.credit('u-2', mine, 'silver', 140_000, 2, 'live')
        ]
      })

      expect(answers.map((answer) => answer.outcome)).toEqual(['credited', 'duplicate', 'credited'])
      const ids = answers.flatMap((a) => (a.outcome === 'credited' ? [a.ledgerEntryId] : []))
      expect(ids).toHaveLength(2)
      expect(new Set(ids).size).toBe(2)
      for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/)
      const entries = s.entries(mine)
      expect(entries.map((e) => e.unitKey).sort()).toEqual(['u-1', 'u-2'])
      const totals = store.totals(mine)
      for (const material of MATERIALS) {
        const sum = entries
          .filter((entry) => entry.material === material)
          .reduce((acc, entry) => acc + entry.tokens, 0)
        expect(totals[material]).toEqual({ tokens: sum })
      }
      expect(totals.silver).toEqual({ tokens: 200_000 })
      expect(s.entryIds(mine).sort()).toEqual([...ids].sort())
    })

    it('[INV-90, ADR-006] storing a usage observation whose sourceKey is already stored inserts nothing', async () => {
      const s = await setUp()
      const mine = s.addMine('bronze')
      const dwarf = s.addDwarf(mine, 'transcript')
      const store = s.repository
      const observation = usageObservation(dwarf, { sealed: false })
      const reRead = usageObservation(dwarf, {
        fidelity: 2,
        sealed: true,
        tokens: { inputNet: 9, output: 9, cacheRead: 9, cacheWrite: 9, reasoning: 9 }
      })

      const answers = s.inTransaction(() => [
        store.record(observation, mine, 'transcript'),
        store.record(reRead, mine, 'transcript')
      ])

      expect(answers).toEqual(['new', 'duplicate'])
      expect(store.unit(observation.unitKey)).toMatchObject({
        sealed: false,
        best: { transcript: { sourceKey: observation.sourceKey, tokens: 5_200 } }
      })
    })

    it('[US-MINE-010.AC04] a mine nothing was credited to has zero of every material', async () => {
      // Transplanted from `src/main/domain/ledger.test.ts:308` ("returns an empty breakdown for a
      // mine that has never produced").
      const s = await setUp()
      const mine = s.addMine('gold')
      const store = s.repository
      expect(store.totals(mine)).toEqual({
        coal: { tokens: 0 },
        bronze: { tokens: 0 },
        copper: { tokens: 0 },
        silver: { tokens: 0 },
        gold: { tokens: 0 },
        uranium: { tokens: 0 }
      })
    })

    it('[ADR-006] a unit is sealed once any of its observations seals it and keeps the provider time of that sealing record', async () => {
      const s = await setUp()
      const mine = s.addMine('copper')
      const dwarf = s.addDwarf(mine, 'transcript')
      const store = s.repository
      const T = CONTRACT_INSTALL_MOMENT
      s.inTransaction(() => {
        store.record(
          usageObservation(dwarf, {
            sourceKey: 'k-a',
            sealed: false,
            providerTime: T + 1_000,
            observedAt: T + 1_100
          }),
          mine,
          'transcript'
        )
      })
      expect(store.unit('claude:session-1:msg-1')).toMatchObject({
        sealed: false,
        providerTime: T + 1_000,
        firstObservedAt: T + 1_100,
        credited: false,
        dwarfId: dwarf,
        mineId: mine
      })

      s.inTransaction(() => {
        store.record(
          usageObservation(dwarf, {
            sourceKey: 'k-b',
            sealed: true,
            providerTime: T + 2_000,
            observedAt: T + 2_100
          }),
          mine,
          'transcript'
        )
        // A later unsealed record never unseals it and never moves its provider time.
        store.record(
          usageObservation(dwarf, {
            sourceKey: 'k-c',
            sealed: false,
            providerTime: T + 3_000,
            observedAt: T + 3_100
          }),
          mine,
          'transcript'
        )
      })
      expect(store.unit('claude:session-1:msg-1')).toMatchObject({
        sealed: true,
        providerTime: T + 2_000,
        firstObservedAt: T + 1_100
      })
      expect(store.sealedUncredited(mine)).toEqual(['claude:session-1:msg-1'])
    })

    it('[ADR-006] the best observation of a unit on each path is the highest fidelity, ties to the earlier', async () => {
      const s = await setUp()
      const mine = s.addMine('copper')
      const dwarf = s.addDwarf(mine, 'driver')
      const T = CONTRACT_INSTALL_MOMENT
      const tokens = (n: number) => ({
        inputNet: n,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0
      })
      const store = s.repository
      s.inTransaction(() => {
        store.record(
          usageObservation(dwarf, {
            sourceKey: 't-1',
            fidelity: 1,
            tokens: tokens(10),
            observedAt: T + 2
          }),
          mine,
          'transcript'
        )
        store.record(
          usageObservation(dwarf, {
            sourceKey: 't-2',
            fidelity: 1,
            tokens: tokens(20),
            observedAt: T + 1
          }),
          mine,
          'transcript'
        )
        store.record(
          usageObservation(dwarf, {
            sourceKey: 'd-1',
            fidelity: 0,
            tokens: tokens(30),
            observedAt: T + 1
          }),
          mine,
          'driver'
        )
        store.record(
          usageObservation(dwarf, {
            sourceKey: 'd-2',
            fidelity: 2,
            tokens: tokens(40),
            observedAt: T + 3
          }),
          mine,
          'driver'
        )
      })
      expect(store.unit('claude:session-1:msg-1')?.best).toEqual({
        transcript: { sourceKey: 't-2', tokens: 20 },
        driver: { sourceKey: 'd-2', tokens: 40 }
      })
    })

    it("[INV-92, INV-94, INV-97] the reads give the dwarf's mine and stored path, the mine's confirmed tier, the install moment and an unfinished reset", async () => {
      const s = await setUp()
      const measured = s.addMine('uranium')
      const unmeasured = s.addMine(null)
      const dwarf = s.addDwarf(measured, 'driver')
      const store = s.repository

      expect(store.subjectOf(dwarf)).toEqual({ mineId: measured, usagePath: 'driver' })
      expect(store.subjectOf('00000000-0000-7000-8000-0000000fffff' as DwarfId)).toBeNull()
      expect(store.confirmedTier(measured)).toBe('uranium')
      expect(store.confirmedTier(unmeasured)).toBeNull()
      expect(store.installMoment()).toBe(CONTRACT_INSTALL_MOMENT)
      expect(store.resetInProgress()).toBe(false)

      s.setResetInProgress(true)
      s.setInstallMoment(null)
      expect(store.resetInProgress()).toBe(true)
      expect(store.installMoment()).toBeNull()
      s.setResetInProgress(false)
      expect(store.resetInProgress()).toBe(false)
    })

    it('[INV-94] the sealed uncredited units of a mine are listed oldest first and a credited one leaves the list', async () => {
      const s = await setUp()
      const mine = s.addMine(null)
      const other = s.addMine(null)
      const dwarf = s.addDwarf(mine, 'transcript')
      const elsewhere = s.addDwarf(other, 'transcript')
      const store = s.repository
      const T = CONTRACT_INSTALL_MOMENT
      s.inTransaction(() => {
        store.record(
          usageObservation(dwarf, { unitKey: 'u-late', sourceKey: 'k-1', observedAt: T + 9 }),
          mine,
          'transcript'
        )
        store.record(
          usageObservation(dwarf, { unitKey: 'u-early', sourceKey: 'k-2', observedAt: T + 1 }),
          mine,
          'transcript'
        )
        store.record(
          usageObservation(dwarf, { unitKey: 'u-open', sourceKey: 'k-3', sealed: false }),
          mine,
          'transcript'
        )
        store.record(
          usageObservation(elsewhere, { unitKey: 'u-other', sourceKey: 'k-4' }),
          other,
          'transcript'
        )
      })
      expect(store.sealedUncredited(mine)).toEqual(['u-early', 'u-late'])

      s.inTransaction(() => store.credit('u-early', mine, 'gold', 5_200, 0, 'live'))
      expect(store.sealedUncredited(mine)).toEqual(['u-late'])
      expect(store.unit('u-early')?.credited).toBe(true)
    })

    it('[ADR-006] record and credit outside a transaction throw and write nothing', async () => {
      const s = await setUp()
      const mine = s.addMine('bronze')
      const dwarf = s.addDwarf(mine, 'transcript')
      const store = s.repository
      expect(() => store.record(usageObservation(dwarf), mine, 'transcript')).toThrow(
        HostInvariantError
      )
      expect(() => store.credit('u-1', mine, 'bronze', 1, 0, 'live')).toThrow(HostInvariantError)
      expect(store.unit('claude:session-1:msg-1')).toBeNull()
      expect(s.entries(mine)).toEqual([])
    })

    // The coal backfill members (16 §4.10; 09 §5.5; ISSUE-077).

    it('[S19.01] a written install moment has a not-started backfill with no recorded scan units', async () => {
      const s = await setUp()
      expect(s.repository.backfillState()).toEqual({ state: 'not-started', creditedScanUnits: [] })
    })

    it('[S19.03, S19.05, FM-022] a scan unit is recorded once, the state keeps its done instant, and a new install moment empties the progress', async () => {
      const s = await setUp()
      const store = s.repository
      const T = CONTRACT_INSTALL_MOMENT
      const unit = { scanUnit: 'claude:/history/project-a', adapterId: 'claude', tokensCredited: 7 }

      const marks = s.inTransaction(() => {
        store.setBackfillState({ state: 'running', creditedScanUnits: [] })
        return [
          store.markScanUnit(unit, T - 5),
          store.markScanUnit({ ...unit, tokensCredited: 9 }, T - 4),
          store.markScanUnit(
            { scanUnit: 'codex:/history/2026/01/02', adapterId: 'codex', tokensCredited: 0 },
            T - 3
          )
        ]
      })
      expect(marks).toEqual(['new', 'duplicate', 'new'])
      expect(store.backfillState()).toEqual({
        state: 'running',
        creditedScanUnits: ['claude:/history/project-a', 'codex:/history/2026/01/02']
      })

      s.inTransaction(() => store.setBackfillState({ state: 'paused', creditedScanUnits: [] }))
      expect(store.backfillState().state).toBe('paused')
      expect(store.backfillState().creditedScanUnits).toHaveLength(2)

      s.inTransaction(() =>
        store.setBackfillState({ state: 'done', creditedScanUnits: [], doneAt: T + 50 })
      )
      expect(store.backfillState()).toEqual({
        state: 'done',
        creditedScanUnits: ['claude:/history/project-a', 'codex:/history/2026/01/02'],
        doneAt: T + 50
      })

      s.setInstallMoment(T + 1_000)
      expect(store.backfillState()).toEqual({ state: 'not-started', creditedScanUnits: [] })
    })

    it('[S19.05] a done state without its instant and another state with one are refused and change nothing', async () => {
      const s = await setUp()
      const store = s.repository
      expect(() =>
        s.inTransaction(() => store.setBackfillState({ state: 'done', creditedScanUnits: [] }))
      ).toThrow()
      expect(() =>
        s.inTransaction(() =>
          store.setBackfillState({ state: 'paused', creditedScanUnits: [], doneAt: 1 })
        )
      ).toThrow()
      expect(store.backfillState()).toEqual({ state: 'not-started', creditedScanUnits: [] })
    })

    it('[ADR-006] the backfill writes throw outside a transaction, and with no install moment a scan unit is refused and the state is not written', async () => {
      const s = await setUp()
      const store = s.repository
      const unit = {
        scanUnit: 'opencode:/history/opencode.db',
        adapterId: 'opencode',
        tokensCredited: 0
      }
      expect(() => store.markScanUnit(unit, 1)).toThrow(HostInvariantError)
      expect(() => store.setBackfillState({ state: 'running', creditedScanUnits: [] })).toThrow(
        HostInvariantError
      )
      expect(store.backfillState()).toEqual({ state: 'not-started', creditedScanUnits: [] })

      s.setInstallMoment(null)
      expect(() => s.inTransaction(() => store.markScanUnit(unit, 1))).toThrow()
      s.inTransaction(() => store.setBackfillState({ state: 'running', creditedScanUnits: [] }))
      expect(store.backfillState()).toEqual({ state: 'not-started', creditedScanUnits: [] })
    })

    // The Reset saga's install moment (16 §4.10 `setInstallMoment`; 07 S13.05; ISSUE-121).

    it("[S13.05, S19.01] setInstallMoment writes the new moment in the caller's transaction and the old moment's backfill progress goes with it", async () => {
      const s = await setUp()
      const store = s.repository
      const T = CONTRACT_INSTALL_MOMENT
      s.inTransaction(() => {
        store.markScanUnit(
          { scanUnit: 'claude:/history/a', adapterId: 'claude', tokensCredited: 3 },
          T
        )
        store.setBackfillState({ state: 'done', creditedScanUnits: [], doneAt: T + 1 })
      })

      s.inTransaction(() => store.setInstallMoment(T + 2_000))

      expect(store.installMoment()).toBe(T + 2_000)
      expect(store.backfillState()).toEqual({ state: 'not-started', creditedScanUnits: [] })
    })

    it('[S13.05] setInstallMoment outside a transaction throws and keeps the moment', async () => {
      const s = await setUp()
      const store = s.repository

      expect(() => store.setInstallMoment(CONTRACT_INSTALL_MOMENT + 2_000)).toThrow(
        HostInvariantError
      )

      expect(store.installMoment()).toBe(CONTRACT_INSTALL_MOMENT)
    })
  })
}
