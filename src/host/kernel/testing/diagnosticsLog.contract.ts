// The DiagnosticsLog conformance suite (16 §2.8, §3 row `DiagnosticsLog`; 17 §1.3): run against
// RecordingDiagnosticsLog and HostDiagnosticsLog. `record` accepts only ADR-026 allowlist fields: a record that the
// allowlist refuses (`field-not-allowed`, or `sensitive` for a value that does not have its declared shape) is dropped
// and counted, and `record` never throws into its caller (16 §3; 13 FM-108).
import { describe, expect, it } from 'vitest'
import type { DiagnosticEntry, DiagnosticsLog } from '../ports/diagnosticsLog'

/** What a log kept of one record: the double's recorded entry, the real log's written line. */
export interface KeptRecord {
  level: unknown
  event: unknown
  subsystem: unknown
}

export interface DiagnosticsLogSubject {
  log: DiagnosticsLog
  /** Every record the log kept so far, in order (the real log's, once its writes settled). */
  kept(): Promise<KeptRecord[]>
}

const ALLOWED: DiagnosticEntry = { level: 'warn', event: 'launch.failed', subsystem: 'launching' }

export function runDiagnosticsLogContract(makeSubject: () => DiagnosticsLogSubject): void {
  describe('DiagnosticsLog contract', () => {
    it('[ADR-026] an entry of allowlisted fields is kept with its level, event and subsystem', async () => {
      const { log, kept } = makeSubject()

      log.record(ALLOWED)
      log.record({ level: 'info', event: 'host.start', subsystem: 'host', outcome: 'ok' })

      expect(await kept()).toEqual([
        { level: 'warn', event: 'launch.failed', subsystem: 'launching' },
        { level: 'info', event: 'host.start', subsystem: 'host' }
      ])
    })

    it('[ADR-026, NFR-SEC-12] an entry with a field outside the LogRecord allowlist is dropped, never thrown', async () => {
      const { log, kept } = makeSubject()
      const outside = { ...ALLOWED, prompt: 'the words a person typed' } as DiagnosticEntry

      expect(() => log.record(outside)).not.toThrow()

      expect(await kept()).toEqual([])
    })

    it('[ADR-026, NFR-SEC-12] an entry whose value does not have its declared shape is dropped, never thrown', async () => {
      const { log, kept } = makeSubject()
      const payload = { ...ALLOWED, msg: { tool: 'output tail' } } as unknown as DiagnosticEntry

      expect(() => log.record(payload)).not.toThrow()

      expect(await kept()).toEqual([])
    })
  })
}
