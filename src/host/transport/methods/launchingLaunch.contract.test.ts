// layer: L6
// L6 (17 §1.6): B-M33 `launching.launch` (14 §2.3, §3.4 `LaunchParams` / `LaunchAccepted`, frozen;
// ADR-019 runtime validation; 14 §1.7 answer at acceptance) through the seam-B dispatcher, and the
// B-F19 `launch.failed` payload (14 §3.5; ADR-020 D1 `LaunchFailure`) against its strict() schema.
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  HOST_FRAME_SCHEMAS,
  HOST_METHOD_SCHEMAS,
  type HostFrames,
  type LaunchFailure
} from '@dwarfai/contracts'
import type { LaunchId, MineId, ProviderId } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { LaunchRefusedError, type LaunchRequestInput } from '../../modules/launching'
import { Dispatcher } from '../dispatcher'
import { registerLaunchingLaunch } from './launchingLaunch'

const REQUEST_ID = '01890a5d-ac96-774b-bcce-b302099a8057'
const LAUNCH = '01890a5d-ac96-774b-bcce-b302099a8162' as LaunchId
const MINE = '01890a5d-ac96-774b-bcce-b302099a8001' as MineId
const UI = { role: 'ui' as const, clientId: 'c-ui' }

const PARAMS = {
  mineId: MINE,
  way: { kind: 'supplier', providerId: 'claude' },
  model: 'opus',
  prompt: 'Survey the north seam',
  jevOn: false,
  jevAutoAccept: false,
  requestId: REQUEST_ID
}

function served(refusal?: LaunchRefusedError) {
  const clock = new FakeClock(1_790_000_000_000)
  const dispatcher = new Dispatcher({
    log: new RecordingDiagnosticsLog(),
    clock,
    scheduler: new FakeScheduler(clock),
    state: () => 'ready'
  })
  const calls: LaunchRequestInput[] = []
  registerLaunchingLaunch(dispatcher, {
    launching: {
      launch: async (req) => {
        calls.push(req)
        if (refusal !== undefined) throw refusal
        return { launchId: LAUNCH }
      }
    }
  })
  return { dispatcher, calls }
}

const FAILURE: LaunchFailure = {
  cause: 'exited-at-once',
  supplierLabel: 'Claude Code',
  actions: ['retry'],
  toolOutputTail: 'Error: not logged in'
}

describe('launching.launch params and result (14 §3.4, B-M33)', () => {
  it('[ADR-019] launching.launch params are strict and an extra key is refused with INVALID_PARAMS', async () => {
    const { dispatcher, calls } = served()
    const ok = await dispatcher.dispatch(
      { id: '1', method: 'launching.launch', params: PARAMS },
      UI
    )
    expect(ok).toMatchObject({ ok: true, result: { launchId: LAUNCH } })
    expect(calls).toEqual([
      {
        mineId: MINE,
        way: { kind: 'supplier', providerId: 'claude' as ProviderId },
        model: 'opus',
        prompt: 'Survey the north seam',
        jevOn: false,
        jevAutoAccept: false
      }
    ])

    const extra = await dispatcher.dispatch(
      {
        id: '2',
        method: 'launching.launch',
        params: { ...PARAMS, requestId: '01890a5d-ac96-774b-bcce-b302099a8058', prompt2: 'x' }
      },
      UI
    )
    expect(extra).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } })
    const nestedExtra = await dispatcher.dispatch(
      {
        id: '3',
        method: 'launching.launch',
        params: {
          ...PARAMS,
          requestId: '01890a5d-ac96-774b-bcce-b302099a8059',
          way: { kind: 'supplier', providerId: 'claude', command: 'rm' }
        }
      },
      UI
    )
    expect(nestedExtra).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } })
    expect(calls).toHaveLength(1)
  })

  it('[INV-50, ADR-019] a launch the Host refuses before any row is written answers INVALID_PARAMS', async () => {
    const { dispatcher } = served(new LaunchRefusedError('mine-not-enterable'))
    const res = await dispatcher.dispatch(
      { id: '1', method: 'launching.launch', params: PARAMS },
      UI
    )
    expect(res).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS', retryable: false } })
  })

  it('[ADR-003] only a ui connection may launch', async () => {
    const { dispatcher, calls } = served()
    const res = await dispatcher.dispatch(
      { id: '1', method: 'launching.launch', params: PARAMS },
      { role: 'notifier', clientId: 'c-n' }
    )
    expect(res).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(calls).toEqual([])
  })

  it('[ADR-019] the B-M33 schemas infer exactly the 14 §3.4 entry', () => {
    const { params, result } = HOST_METHOD_SCHEMAS['launching.launch']
    expect(result.safeParse({ launchId: LAUNCH }).success).toBe(true)
    expect(result.safeParse({ launchId: LAUNCH, state: 'resolving' }).success).toBe(false)
    expect(params.safeParse(PARAMS).success).toBe(true)
  })
})

describe('launch.failed payload (14 §3.5, B-F19)', () => {
  it('[ADR-020] launch.failed carries the ADR-020 LaunchFailure shape', () => {
    expect(Object.keys(HOST_FRAME_SCHEMAS)).toContain('launch.failed')
    expectTypeOf<HostFrames['launch.failed']>().toEqualTypeOf<{
      launchId: LaunchId
      mineId: MineId
      failure: LaunchFailure
    }>()
    const schema = HOST_FRAME_SCHEMAS['launch.failed']
    const frame = { launchId: LAUNCH, mineId: MINE, failure: FAILURE }
    expect(schema.safeParse(frame).success).toBe(true)
    // the tail is at most 400 characters (ADR-020 item 6)
    const longTail = { ...FAILURE, toolOutputTail: 'x'.repeat(401) }
    expect(schema.safeParse({ ...frame, failure: longTail }).success).toBe(false)
    // exactly the five causes (INV-52): no sixth literal
    const sixth = { ...FAILURE, cause: 'effort-ceiling' }
    expect(schema.safeParse({ ...frame, failure: sixth }).success).toBe(false)
    expect(schema.safeParse({ ...frame, failure: { ...FAILURE, x: 1 } }).success).toBe(false)
    expect(schema.safeParse({ ...frame, seq: 1 }).success).toBe(false)
  })
})
