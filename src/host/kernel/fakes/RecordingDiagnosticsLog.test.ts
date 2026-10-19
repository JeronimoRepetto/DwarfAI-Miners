import { describe, expect, it } from 'vitest'
import { RecordingDiagnosticsLog } from './RecordingDiagnosticsLog'
import { runDiagnosticsLogContract } from '../testing/diagnosticsLog.contract'

describe('RecordingDiagnosticsLog', () => {
  it('[ADR-026] keeps every recorded entry in call order and finds them by event', () => {
    const log = new RecordingDiagnosticsLog()

    log.record({ level: 'warn', event: 'launch.failed', subsystem: 'launching' })
    log.record({ level: 'info', event: 'host.start', subsystem: 'host', outcome: 'ok' })
    log.record({ level: 'warn', event: 'launch.failed', subsystem: 'launching', count: 2 })

    expect(log.entries.map((entry) => entry.event)).toEqual([
      'launch.failed',
      'host.start',
      'launch.failed'
    ])
    expect(log.byEvent('launch.failed')).toEqual([
      { level: 'warn', event: 'launch.failed', subsystem: 'launching' },
      { level: 'warn', event: 'launch.failed', subsystem: 'launching', count: 2 }
    ])
  })
})

runDiagnosticsLogContract(() => {
  const log = new RecordingDiagnosticsLog()
  return {
    log,
    kept: () =>
      Promise.resolve(
        log.entries.map(({ level, event, subsystem }) => ({ level, event, subsystem }))
      )
  }
})
