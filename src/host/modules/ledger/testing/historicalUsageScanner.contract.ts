// The HistoricalUsageScanner conformance suite (16 §4.10 doubles row: "straddling stream pays
// nothing as coal", 09 §5.5; 17 §1.3), run on `FakeHistoricalUsageScanner` and on
// `ProviderHistoryScanner` over synthetic provider history. A subject turns the neutral
// `ContractHistory` into its own source (a script for the fake, provider files for the adapter) and
// says which scan unit and unit key each name became. Never imported by production code (R14).
import { afterEach, describe, expect, it } from 'vitest'
import type { Instant, MineId } from '../../../kernel/domain/values'
import type {
  HistoricalUsage,
  HistoricalUsageScanner,
  ScanBudget
} from '../ports/historicalUsageScanner'

export const SCAN_BEFORE: Instant = 1_760_000_000_000

/** One record of the contract history. */
export interface ContractRecord {
  /** The record's own id: a message id (per-unit) or a stream id (lifetime). */
  id: string
  tokens: number
  /** The unit's provider time, or the stream's newest record time. */
  at: Instant
  /** Whether its folder resolves to a mine (O-11-10: no coal for folders that are not mines). */
  inMine: boolean
}

/** One scan unit of the contract history. */
export interface ContractUnit {
  name: string
  /** `per-unit`: records are accounted units; `lifetime`: each record is a whole stream's total. */
  shape: 'per-unit' | 'lifetime'
  records: ContractRecord[]
  /** The unit's files cannot be read (a vanished or unreadable provider file). */
  unreadable?: boolean
}

export interface ContractHistory {
  units: ContractUnit[]
}

export interface HistoricalUsageScannerSubject {
  scanner: HistoricalUsageScanner
  /** The mine every `inMine` record resolves to. */
  mineId: MineId
  /** The `scanUnit` the unit named `name` is yielded as. */
  scanUnitOf(name: string): string
  /** The `unitKey` a record is yielded with: the live key, or `coal:<streamId>`. */
  unitKeyOf(unit: string, record: string): string
  /** Files one scan reads to finish the unit named `name`. */
  filesOf(name: string): number
  dispose(): void | Promise<void>
}

export type MakeScannerSubject = (
  history: ContractHistory
) => HistoricalUsageScannerSubject | Promise<HistoricalUsageScannerSubject>

/** A budget that never stops a contract scan, unless overridden. */
export function scanBudget(overrides: Partial<ScanBudget> = {}): ScanBudget {
  return {
    maxFiles: 1_500,
    maxDurationMs: 8_000,
    maxFilesPerDir: 400,
    finishedScanUnits: new Set(),
    ...overrides
  }
}

/** Every item of one scan, in order. */
export async function collect(
  iterable: AsyncIterable<HistoricalUsage>
): Promise<HistoricalUsage[]> {
  const items: HistoricalUsage[] = []
  for await (const item of iterable) items.push(item)
  return items
}

const B = SCAN_BEFORE

/** Two finished units: one of per-unit records, one of lifetime streams. */
const TWO_UNITS: ContractHistory = {
  units: [
    {
      name: 'per-unit',
      shape: 'per-unit',
      records: [
        { id: 'msg-early', tokens: 1_200, at: B - 60_000, inMine: true },
        { id: 'msg-edge', tokens: 300, at: B - 1, inMine: true },
        { id: 'msg-at', tokens: 400, at: B, inMine: true },
        { id: 'msg-late', tokens: 500, at: B + 60_000, inMine: true },
        { id: 'msg-elsewhere', tokens: 700, at: B - 60_000, inMine: false }
      ]
    },
    {
      name: 'lifetime',
      shape: 'lifetime',
      records: [
        { id: 'stream-old', tokens: 9_000, at: B - 3_600_000, inMine: true },
        { id: 'stream-straddling', tokens: 8_000, at: B + 1_000, inMine: true }
      ]
    }
  ]
}

export function runHistoricalUsageScannerContract(make: MakeScannerSubject): void {
  describe('HistoricalUsageScanner contract', () => {
    let subject: HistoricalUsageScannerSubject | null = null

    afterEach(async () => {
      await subject?.dispose()
      subject = null
    })

    const setUp = async (history: ContractHistory) => {
      subject = await make(history)
      return subject
    }

    it('[ADR-006, INV-95] a scan yields each unit once with its records strictly before the moment, keyed by the live unit key, and a straddling lifetime stream yields nothing', async () => {
      const s = await setUp(TWO_UNITS)
      const items = await collect(s.scanner.scan(B, scanBudget(), new AbortController().signal))
      expect(items).toHaveLength(2)
      const byUnit = new Map(
        items.flatMap((item) => (item.kind === 'scanned' ? [[item.scanUnit, item]] : []))
      )
      const perUnit = byUnit.get(s.scanUnitOf('per-unit'))
      const lifetime = byUnit.get(s.scanUnitOf('lifetime'))
      expect(
        perUnit?.records.map((r) => [r.unitKey, r.span, r.tokens, r.providerTime, r.mineId])
      ).toEqual(
        expect.arrayContaining([
          [s.unitKeyOf('per-unit', 'msg-early'), 'unit', 1_200, B - 60_000, s.mineId],
          [s.unitKeyOf('per-unit', 'msg-edge'), 'unit', 300, B - 1, s.mineId]
        ])
      )
      expect(perUnit?.records).toHaveLength(2)
      expect(lifetime?.records.map((r) => [r.unitKey, r.span, r.tokens, r.providerTime])).toEqual([
        [s.unitKeyOf('lifetime', 'stream-old'), 'lifetime', 9_000, B - 3_600_000]
      ])
      expect(s.unitKeyOf('lifetime', 'stream-old')).toMatch(/^coal:/)
    })

    it('[S19.04, S19.07] a resumed scan spends nothing on finished scan units', async () => {
      const s = await setUp(TWO_UNITS)
      const finished = new Set([s.scanUnitOf('per-unit')])
      const items = await collect(
        s.scanner.scan(
          B,
          scanBudget({ finishedScanUnits: finished, maxFiles: s.filesOf('lifetime') }),
          new AbortController().signal
        )
      )
      expect(items.map((item) => (item.kind === 'scanned' ? item.scanUnit : item.kind))).toEqual([
        s.scanUnitOf('lifetime')
      ])
    })

    it('[S19.03, FM-098] the scan stops between units once its file budget is reached, says so last, and always finishes its first unit', async () => {
      const s = await setUp(TWO_UNITS)
      const items = await collect(
        s.scanner.scan(B, scanBudget({ maxFiles: 1 }), new AbortController().signal)
      )
      expect(items).toHaveLength(2)
      expect(items[0]?.kind).toBe('scanned')
      expect(items[1]).toEqual({ kind: 'budget-reached' })
    })

    it('[S19.08, FM-098] an unreadable unit is yielded as unreadable without content and the scan continues', async () => {
      const s = await setUp({
        units: [{ ...TWO_UNITS.units[0]!, name: 'broken', unreadable: true }, TWO_UNITS.units[1]!]
      })
      const items = await collect(s.scanner.scan(B, scanBudget(), new AbortController().signal))
      const broken = items.find((item) => item.kind === 'unreadable')
      expect(broken).toMatchObject({ kind: 'unreadable', scanUnit: s.scanUnitOf('broken') })
      expect(Object.keys(broken ?? {}).sort()).toEqual(['adapterId', 'errCode', 'kind', 'scanUnit'])
      expect(
        items.some((item) => item.kind === 'scanned' && item.scanUnit === s.scanUnitOf('lifetime'))
      ).toBe(true)
      expect(
        items.some((item) => item.kind === 'scanned' && item.scanUnit === s.scanUnitOf('broken'))
      ).toBe(false)
    })

    it('[S19.06] an aborted signal ends the scan before its next unit', async () => {
      const s = await setUp(TWO_UNITS)
      const controller = new AbortController()
      const items: HistoricalUsage[] = []
      for await (const item of s.scanner.scan(B, scanBudget(), controller.signal)) {
        items.push(item)
        controller.abort()
      }
      expect(items).toHaveLength(1)
      expect(items[0]?.kind).toBe('scanned')
    })
  })
}
