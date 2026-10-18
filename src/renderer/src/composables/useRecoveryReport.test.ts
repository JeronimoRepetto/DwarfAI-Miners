// @vitest-environment jsdom
// Renderer unit (17 §1.6): `useRecoveryReport`, the grouped recovery message's read model (14 §6.4 row "new
// recovery-message store": singleton; snapshot `recovery` + B-F21 `host.recovered`; A-N10, A-N11; ADR-015 item 5;
// 07 machine 16; ADR-033 items 2–3), over the generated fake `window.api`: one report at a time, shown until it
// settles; Retry and Dismiss send the report's epoch once and the message follows the Host's answer.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  DwarfId,
  HostFrame,
  HostRecoveryReportView,
  IpcResult,
  Outcome,
  RecoveryActionParams,
  SnapshotPage,
  SnapshotParams
} from '@dwarfai/contracts'
import { createFakeWindowApi } from '../../../contracts/ipc/testing/fakeWindowApi'
import { useRecoveryReport } from './useRecoveryReport'

type Api = ReturnType<typeof createFakeWindowApi>
type SnapshotAnswer = IpcResult<SnapshotPage>
type RetryAnswer = IpcResult<Outcome<HostRecoveryReportView, 'no-report'>>
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- 14 §2.2 spells the empty value as {}
type DismissAnswer = IpcResult<Outcome<{}, 'no-report'>>

const EPOCH = 'epoch-0330'
const D1 = '01920000-0000-7000-a000-000000000331' as DwarfId
const D2 = '01920000-0000-7000-a000-000000000332' as DwarfId
const D3 = '01920000-0000-7000-a000-000000000333' as DwarfId
const M1 = '01920000-0000-7000-a000-000000000334'
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function report(overrides: Partial<HostRecoveryReportView> = {}): HostRecoveryReportView {
  return {
    hostEpoch: EPOCH,
    at: 1_000,
    resumed: [D1],
    unrecovered: [
      { dwarfId: D2, reason: 'no-resume' },
      { dwarfId: D3, reason: 'turn-lost', messageIds: [M1] }
    ],
    state: 'pending-display',
    ...overrides
  }
}

function page(seq: number, data: HostRecoveryReportView | null): SnapshotAnswer {
  return {
    ok: true,
    value: { snapshotId: `snap-${seq}`, seq, epoch: EPOCH, chunks: [{ section: 'recovery', data }] }
  } as SnapshotAnswer
}

function recovered(seq: number, data: HostRecoveryReportView): HostFrame {
  return {
    type: 'evt',
    seq,
    epoch: EPOCH,
    name: 'host.recovered',
    data: { report: data }
  } as HostFrame
}

interface Host {
  push(frames: HostFrame[]): void
  requests: SnapshotParams[]
  retried: RecoveryActionParams[]
  dismissed: RecoveryActionParams[]
  /** The members that end or remove a dwarf: Dismiss never calls one (ADR-015 item 5). */
  enders: Array<ReturnType<typeof vi.fn>>
}

interface Answers {
  snapshot: SnapshotAnswer | (() => SnapshotAnswer)
  retry?: () => Promise<RetryAnswer>
  dismiss?: () => Promise<DismissAnswer>
}

function installHost(answers: Answers): Host {
  let listener: ((frames: HostFrame[]) => void) | null = null
  const requests: SnapshotParams[] = []
  const retried: RecoveryActionParams[] = []
  const dismissed: RecoveryActionParams[] = []
  const stopDwarf = vi.fn(() => Promise.reject(new Error('Dismiss never ends a dwarf')))
  const kickDwarf = vi.fn(() => Promise.reject(new Error('Dismiss never ends a dwarf')))
  const retireDwarf = vi.fn()
  const requestStopEverything = vi.fn()
  const api = createFakeWindowApi({
    getHostSnapshot: vi.fn((request: SnapshotParams) => {
      requests.push(request)
      const { snapshot } = answers
      return Promise.resolve(typeof snapshot === 'function' ? snapshot() : snapshot)
    }) as unknown as Api['getHostSnapshot'],
    onHostEvent: vi.fn((follow: (frames: HostFrame[]) => void) => {
      listener = follow
      return () => {
        listener = null
      }
    }) as unknown as Api['onHostEvent'],
    retryRecovery: vi.fn((request: RecoveryActionParams) => {
      retried.push(request)
      return answers.retry?.() ?? Promise.reject(new Error('no retry answer'))
    }) as unknown as Api['retryRecovery'],
    dismissRecovery: vi.fn((request: RecoveryActionParams) => {
      dismissed.push(request)
      return answers.dismiss?.() ?? Promise.reject(new Error('no dismiss answer'))
    }) as unknown as Api['dismissRecovery'],
    stopDwarf: stopDwarf as unknown as Api['stopDwarf'],
    kickDwarf: kickDwarf as unknown as Api['kickDwarf'],
    retireDwarf: retireDwarf as unknown as Api['retireDwarf'],
    requestStopEverything: requestStopEverything as unknown as Api['requestStopEverything']
  })
  Object.defineProperty(window, 'api', { configurable: true, writable: true, value: api })
  return {
    push(frames) {
      if (listener === null) throw new Error('nothing follows onHostEvent')
      listener(frames)
    },
    requests,
    retried,
    dismissed,
    enders: [stopDwarf, kickDwarf, retireDwarf, requestStopEverything]
  }
}

const stops: Array<() => void> = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
})

function recovery() {
  const model = useRecoveryReport()
  stops.push(model.stop)
  return model
}

describe('useRecoveryReport (14 §6.4; A-N10, A-N11, B-F21; ADR-015 item 5)', () => {
  it('[S16.02, ADR-015] one host.recovered frame shows one message listing every unrecovered session', async () => {
    const host = installHost({ snapshot: page(10, null) })
    const model = recovery()

    expect(await model.start()).toBe(true)
    expect(host.requests).toEqual([{ sections: ['recovery'] }])
    expect(model.shown.value).toBe(false)

    host.push([recovered(11, report())])
    expect(model.shown.value).toBe(true)
    expect(model.unrecovered.value).toEqual([
      { dwarfId: D2, reason: 'no-resume' },
      { dwarfId: D3, reason: 'turn-lost', messageIds: [M1] }
    ])

    // The Host marks it shown (S16.04): the same one report, never a second message.
    host.push([recovered(12, report({ state: 'shown', shownAt: 1_001 }))])
    expect(model.shown.value).toBe(true)
    expect(model.report.value?.state).toBe('shown')
    expect(model.unrecovered.value).toHaveLength(2)

    // A frame at or below the last applied seq is old news (ADR-033 item 3).
    host.push([recovered(12, report({ state: 'settled' }))])
    expect(model.shown.value).toBe(true)
  })

  it("[ADR-015] retry sends retryRecovery with the report's epoch and the message closes when the report settles", async () => {
    let settle: (answer: RetryAnswer) => void = () => undefined
    const host = installHost({
      snapshot: page(10, report({ state: 'shown', shownAt: 1_001 })),
      retry: () =>
        new Promise<RetryAnswer>((resolve) => {
          settle = resolve
        })
    })
    const model = recovery()
    await model.start()
    expect(model.shown.value).toBe(true)

    const first = model.retry()
    // One retry at a time (14 §1.6: one requestId per intent): a second press sends nothing.
    void model.retry()
    expect(host.retried).toHaveLength(1)
    expect(host.retried[0]!.hostEpoch).toBe(EPOCH)
    expect(host.retried[0]!.requestId).toMatch(UUID_V7)
    expect(model.acting.value).toBe(true)

    // While the retry runs the Host reports `retrying`: the message stays.
    host.push([recovered(11, report({ state: 'retrying', shownAt: 1_001 }))])
    expect(model.shown.value).toBe(true)

    settle({
      ok: true,
      value: {
        ok: true,
        value: report({
          state: 'settled',
          shownAt: 1_001,
          settledAt: 1_002,
          retryOutcomes: [
            { dwarfId: D2, outcome: 'resumed' },
            { dwarfId: D3, outcome: 'resumed' }
          ]
        })
      }
    })
    await first
    expect(model.shown.value).toBe(false)
    expect(model.acting.value).toBe(false)
    expect(host.retried).toHaveLength(1)
  })

  it('[ADR-015] retry keeps the message when the answer is a refusal, and a no-report outcome clears it', async () => {
    let answer: RetryAnswer = {
      ok: false,
      error: { code: 'TIMEOUT', message: 'no answer', retryable: true }
    }
    const host = installHost({
      snapshot: page(10, report({ state: 'shown' })),
      retry: () => Promise.resolve(answer)
    })
    const model = recovery()
    await model.start()

    // A refusal (the row not routed yet, a timeout) reports nothing: the message stays as the Host says.
    await model.retry()
    expect(model.shown.value).toBe(true)
    expect(model.acting.value).toBe(false)

    answer = { ok: true, value: { ok: false, error: 'no-report' } }
    await model.retry()
    expect(host.retried).toHaveLength(2)
    expect(model.shown.value).toBe(false)
  })

  it('[ADR-015] dismiss sends dismissRecovery and a no-report outcome clears the message', async () => {
    let answer: DismissAnswer = { ok: true, value: { ok: false, error: 'no-report' } }
    const host = installHost({
      snapshot: page(10, report({ state: 'shown' })),
      dismiss: () => Promise.resolve(answer)
    })
    const model = recovery()
    await model.start()

    await model.dismiss()
    expect(host.dismissed).toHaveLength(1)
    expect(host.dismissed[0]!.hostEpoch).toBe(EPOCH)
    expect(host.dismissed[0]!.requestId).toMatch(UUID_V7)
    expect(model.shown.value).toBe(false)

    // A later report of the same epoch, dismissed with an empty value, closes too.
    host.push([recovered(11, report({ state: 'shown' }))])
    expect(model.shown.value).toBe(true)
    answer = { ok: true, value: { ok: true, value: {} } }
    await model.dismiss()
    expect(host.dismissed).toHaveLength(2)
    expect(model.shown.value).toBe(false)
  })

  // OQ-43: dismissal walks out the dwarfs in the Host, never in the window.
  it('[ADR-015] dismiss never ends a running dwarf: only dismissRecovery leaves the window', async () => {
    const host = installHost({
      snapshot: page(10, report({ state: 'shown' })),
      dismiss: () => Promise.resolve({ ok: true, value: { ok: true, value: {} } })
    })
    const model = recovery()
    await model.start()

    await model.dismiss()
    expect(host.dismissed).toHaveLength(1)
    expect(host.retried).toHaveLength(0)
    for (const ender of host.enders) expect(ender).not.toHaveBeenCalled()
  })

  it('[S16.08, FM-023] a report still pending in the snapshot at attach shows the message again', async () => {
    let current: HostRecoveryReportView | null = report({ state: 'shown', shownAt: 1_001 })
    installHost({ snapshot: () => page(20, current) })
    let model = recovery()

    expect(await model.start()).toBe(true)
    expect(model.shown.value).toBe(true)

    // The window closed before the person acted (S16.08): the next attach shows it again.
    model.stop()
    expect(model.shown.value).toBe(false)
    model = recovery()
    expect(await model.start()).toBe(true)
    expect(model.shown.value).toBe(true)
    expect(model.unrecovered.value.map((item) => item.dwarfId)).toEqual([D2, D3])

    // A settled report is never shown.
    model.stop()
    current = report({ state: 'settled', settledAt: 1_002 })
    model = recovery()
    await model.start()
    expect(model.shown.value).toBe(false)
  })
})
