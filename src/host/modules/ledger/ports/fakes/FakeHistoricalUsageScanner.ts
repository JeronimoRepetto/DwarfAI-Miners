// The HistoricalUsageScanner double (16 §4.10 `FakeHistoricalUsageScanner`; 16 §2.8): a scripted
// history it scans as the port says (`runHistoricalUsageScannerContract`, the suite
// `ProviderHistoryScanner` runs): records strictly before `before` only (a straddling stream pays
// nothing as coal), finished units skipped, the file budget checked between units and never before
// the first (a unit reads at most `maxFilesPerDir`), an aborted signal ending the scan. It records
// every `scan` call. Type imports only (05 R2). Never imported by production code (R14).
import type { Instant } from '../../../../kernel/domain/values'
import type {
  HistoricalUsage,
  HistoricalUsageRecord,
  HistoricalUsageScanner,
  ScanBudget
} from '../historicalUsageScanner'

/** One scripted scan unit. */
export interface FakeHistoryUnit {
  scanUnit: string
  adapterId: string
  /** Files a scan reads to finish it (the file budget's measure). */
  files: number
  records: HistoricalUsageRecord[]
  /** When set, the unit cannot be read and is yielded as unreadable with this code. */
  unreadable?: string
}

export class FakeHistoricalUsageScanner implements HistoricalUsageScanner {
  /** Every `scan` call, in order. */
  readonly scans: Array<{ before: Instant; budget: ScanBudget }> = []

  constructor(private units: FakeHistoryUnit[] = []) {}

  /** Replaces the scripted history (a provider file changed between runs). */
  script(units: FakeHistoryUnit[]): void {
    this.units = units
  }

  async *scan(
    before: Instant,
    budget: ScanBudget,
    signal: AbortSignal
  ): AsyncIterable<HistoricalUsage> {
    this.scans.push({ before, budget })
    let filesRead = 0
    for (const unit of this.units) {
      if (signal.aborted) return
      if (budget.finishedScanUnits.has(unit.scanUnit)) continue
      // Between units, never before the first: a run always records some progress.
      if (filesRead > 0 && filesRead >= budget.maxFiles) {
        yield { kind: 'budget-reached' }
        return
      }
      filesRead += Math.min(unit.files, budget.maxFilesPerDir)
      await Promise.resolve()
      if (signal.aborted) return
      const { scanUnit, adapterId } = unit
      if (unit.unreadable !== undefined) {
        yield { kind: 'unreadable', scanUnit, adapterId, errCode: unit.unreadable }
        continue
      }
      // Only records strictly before the moment (a straddling lifetime stream yields nothing).
      const records = unit.records.filter((record) => record.providerTime < before)
      yield { kind: 'scanned', scanUnit, adapterId, records: records.map((r) => ({ ...r })) }
    }
  }
}
