// layer: L1
// The diagram-conformance walk of 07 machine 16 (Host recovery report, S16.01…S16.09) and the
// per-item settle rules of a Retry and a Dismiss (07 S16.05, S16.07, S2.19; ADR-015 item 5).
import { describe, expect, it } from 'vitest'
import type { DwarfId } from '../../../kernel/domain/values'
import {
  NO_REPORT,
  planDismiss,
  planRetry,
  stepRecoveryReport,
  type RecoveryReportEvent,
  type RecoveryReportPhase,
  type RecoveryReportState
} from './recoveryReport'

const T0 = 1_790_000_000_000
const A = '00000000-0000-7000-8000-0000000174a1' as DwarfId
const B = '00000000-0000-7000-8000-0000000174a2' as DwarfId
const C = '00000000-0000-7000-8000-0000000174a3' as DwarfId

const phase = (state: RecoveryReportState, over: Partial<RecoveryReportPhase> = {}) => ({
  state,
  shownAt: null,
  settledAt: null,
  ...over
})

describe('Host recovery report machine 16', () => {
  it('[S16.01, S16.03, S16.04] every machine 16 transition reaches its target: the boot classification starts collecting, an empty unrecovered list emits nothing, and a ui attach shows a pending report once with its shownAt; a transition 07 does not list is rejected', () => {
    const shown = phase('shown', { shownAt: T0 })
    const walk: Array<[RecoveryReportPhase, RecoveryReportEvent, string, RecoveryReportPhase]> = [
      [NO_REPORT, { t: 'boot-classification' }, 'S16.01', phase('collecting')],
      [
        phase('collecting'),
        { t: 'classified', unrecovered: 2 },
        'S16.02',
        phase('pending-display')
      ],
      [phase('collecting'), { t: 'classified', unrecovered: 0 }, 'S16.03', NO_REPORT],
      [phase('pending-display'), { t: 'ui-attached', at: T0 }, 'S16.04', shown],
      [shown, { t: 'retry' }, 'S16.05', phase('retrying', { shownAt: T0 })],
      [
        phase('retrying', { shownAt: T0 }),
        { t: 'retries-settled', at: T0 + 9 },
        'S16.06',
        phase('settled', { shownAt: T0, settledAt: T0 + 9 })
      ],
      [
        shown,
        { t: 'dismiss', at: T0 + 7 },
        'S16.07',
        phase('settled', { shownAt: T0, settledAt: T0 + 7 })
      ],
      [shown, { t: 'window-closed' }, 'S16.08', shown],
      [phase('pending-display'), { t: 'host-crashed' }, 'S16.09', phase('superseded')],
      [shown, { t: 'host-crashed' }, 'S16.09', phase('superseded', { shownAt: T0 })],
      [
        phase('retrying', { shownAt: T0 }),
        { t: 'host-crashed' },
        'S16.09',
        phase('superseded', { shownAt: T0 })
      ]
    ]
    for (const [from, event, transition, to] of walk) {
      expect(stepRecoveryReport(from, event), `${from.state} --${event.t}-->`).toEqual({
        ok: true,
        value: { phase: to, transition }
      })
    }
    // Shown once: a second attach of a shown report is no transition of 07, so shownAt stays.
    const rejected: Array<[RecoveryReportPhase, RecoveryReportEvent]> = [
      [shown, { t: 'ui-attached', at: T0 + 50 }],
      [phase('pending-display'), { t: 'retry' }],
      [phase('pending-display'), { t: 'dismiss', at: T0 }],
      [phase('retrying', { shownAt: T0 }), { t: 'dismiss', at: T0 }],
      [phase('retrying', { shownAt: T0 }), { t: 'retry' }],
      [phase('settled', { shownAt: T0, settledAt: T0 }), { t: 'retry' }],
      [phase('settled', { shownAt: T0, settledAt: T0 }), { t: 'host-crashed' }],
      [phase('superseded'), { t: 'ui-attached', at: T0 }],
      [phase('collecting'), { t: 'ui-attached', at: T0 }],
      [NO_REPORT, { t: 'classified', unrecovered: 1 }]
    ]
    for (const [from, event] of rejected) {
      expect(stepRecoveryReport(from, event), `${from.state} --${event.t}-->`).toEqual({
        ok: false,
        error: 'not-listed'
      })
    }
  })

  it('[S16.05, ADR-015] a retry re-attempts only the listed dwarfs still unrecovered, and a turn-lost item whose session resumed settles as is', () => {
    const items = [
      { dwarfId: A, reason: 'no-resume' as const },
      { dwarfId: B, reason: 'turn-lost' as const },
      { dwarfId: C, reason: 'stale-ref' as const }
    ]
    const processOf = (id: DwarfId) =>
      id === B
        ? ('running' as const)
        : id === C
          ? ('unrecovered' as const)
          : ('unrecovered' as const)
    expect(planRetry(items, processOf)).toEqual({ retry: [A, C], settleAsIs: [B] })
    // A listed dwarf already gone (closed, or no crew row) has nothing left to retry either.
    expect(planRetry(items, (id) => (id === A ? 'closed' : id === C ? null : 'running'))).toEqual({
      retry: [],
      settleAsIs: [A, B, C]
    })
  })

  it('[S16.07, S2.13, S2.19] a dismissal walks out every listed dwarf still unrecovered and keeps one whose session is running', () => {
    const items = [
      { dwarfId: A, reason: 'resume-error' as const },
      { dwarfId: B, reason: 'turn-lost' as const }
    ]
    const processOf = (id: DwarfId) => (id === B ? ('running' as const) : ('unrecovered' as const))
    expect(planDismiss(items, processOf)).toEqual({ walkOut: [A], stays: [B] })
  })
})
