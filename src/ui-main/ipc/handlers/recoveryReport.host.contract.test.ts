// layer: L6
// L6 (17 §1.6): A-N10 `retryRecovery` / `host:recovery:retry` and A-N11 `dismissRecovery` / `host:recovery:dismiss`
// (14 §2.2 NEW, `host`, owner launching; `RecoveryActionParams` → `IpcResult<Outcome<…, 'no-report'>>`; ADR-015
// item 5; OQ-41 A, OQ-43; ADR-019 items 7, 8) as their `host` handler serves them, over a faked HostClient: main
// validates the renderer's payload against the registry's request (the same object as B-M35's and B-M36's params,
// 14 §1.2) and relays `launching.retryRecovery` / `launching.dismissRecovery` with exactly `{ hostEpoch, requestId }`;
// the Host's outcome is the value, a call error the error branch; every answer is checked against the registry's
// response schema.
import { describe, expect, it } from 'vitest'
import {
  CHANNELS,
  type HostMethod,
  type HostParams,
  type HostResult,
  type IpcError
} from '@dwarfai/contracts'
import { HostCallError } from '../../host-client/HostClient'
import type { HostClient } from '../../window/ports/hostClient'
import {
  createRecoveryReportRow,
  DISMISS_RECOVERY,
  RECOVERY_REPORT_ROWS,
  RETRY_RECOVERY
} from './recoveryReport.host'

const DWARF = '01920000-0000-7000-a000-000000000101'
const MESSAGE = '01920000-0000-7000-a000-000000000102'
const REQUEST = '01920000-0000-7000-a000-000000000103'

const ACTION = { hostEpoch: 'epoch-1', requestId: REQUEST }

const SETTLED_REPORT = {
  hostEpoch: 'epoch-1',
  at: 4,
  resumed: [],
  unrecovered: [{ dwarfId: DWARF, reason: 'turn-lost', messageIds: [MESSAGE] }],
  state: 'settled',
  shownAt: 5,
  settledAt: 6,
  retryOutcomes: [{ dwarfId: DWARF, outcome: 'resumed' }]
}

/** The HostClient `call` the row uses: records each call and answers `answers[method]`, or refuses. */
class FakeRecoveryHost implements Pick<HostClient, 'call'> {
  readonly calls: Array<{ method: string; params: unknown }> = []
  answers: Record<string, unknown> = {
    'launching.retryRecovery': { ok: true, value: SETTLED_REPORT },
    'launching.dismissRecovery': { ok: true, value: {} }
  }
  refusal: IpcError | null = null

  call<M extends HostMethod>(method: M, params: HostParams[M]): Promise<HostResult[M]> {
    this.calls.push({ method, params })
    if (this.refusal !== null) return Promise.reject(new HostCallError(this.refusal))
    return Promise.resolve(this.answers[method]) as Promise<HostResult[M]>
  }
}

describe('A-N10, A-N11 the recovery report actions, host handler (14 §2.2)', () => {
  it('[ADR-015, ADR-019] Retry and Dismiss validate RecoveryActionParams in main and relay B-M35 and B-M36 unchanged', async () => {
    const host = new FakeRecoveryHost()
    const row = createRecoveryReportRow(host)

    expect(RECOVERY_REPORT_ROWS).toEqual([RETRY_RECOVERY, DISMISS_RECOVERY])
    expect(
      CHANNELS[RETRY_RECOVERY].response.parse(await row.serve(RETRY_RECOVERY, ACTION))
    ).toEqual({ ok: true, value: { ok: true, value: SETTLED_REPORT } })
    expect(
      CHANNELS[DISMISS_RECOVERY].response.parse(await row.serve(DISMISS_RECOVERY, ACTION))
    ).toEqual({ ok: true, value: { ok: true, value: {} } })
    expect(host.calls).toEqual([
      { method: 'launching.retryRecovery', params: ACTION },
      { method: 'launching.dismissRecovery', params: ACTION }
    ])

    // A missing requestId, a dwarf list, a non-string epoch: nothing leaves main.
    for (const channel of RECOVERY_REPORT_ROWS) {
      for (const payload of [
        { hostEpoch: 'epoch-1' },
        { ...ACTION, dwarfIds: [DWARF] },
        { ...ACTION, hostEpoch: 1 },
        { ...ACTION, requestId: 'req-1' },
        undefined
      ]) {
        expect(
          CHANNELS[channel].response.parse(await row.serve(channel, payload)),
          `${channel} ${JSON.stringify(payload)}`
        ).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } })
      }
    }
    expect(host.calls).toHaveLength(2)
  })

  it('[ADR-015] no-report is the value, a call error is the error branch, never a throw', async () => {
    const host = new FakeRecoveryHost()
    const row = createRecoveryReportRow(host)
    host.answers = {
      'launching.retryRecovery': { ok: false, error: 'no-report' },
      'launching.dismissRecovery': { ok: false, error: 'no-report' }
    }

    for (const channel of RECOVERY_REPORT_ROWS) {
      expect(CHANNELS[channel].response.parse(await row.serve(channel, ACTION))).toEqual({
        ok: true,
        value: { ok: false, error: 'no-report' }
      })
    }
    host.refusal = { code: 'HOST_NOT_READY', message: 'starting', retryable: true }
    for (const channel of RECOVERY_REPORT_ROWS) {
      expect(CHANNELS[channel].response.parse(await row.serve(channel, ACTION))).toEqual({
        ok: false,
        error: host.refusal
      })
    }
    expect(await row.serve('dwarf:stop', ACTION)).toMatchObject({
      ok: false,
      error: { code: 'METHOD_NOT_FOUND' }
    })
    expect(host.calls).toHaveLength(4)
  })
})
