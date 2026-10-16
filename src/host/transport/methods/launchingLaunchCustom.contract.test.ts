// layer: L6
// L6 (17 §1.6): B-M34 `launching.launchCustom` (14 §2.3, §3.4 `LaunchCustomParams` /
// `LaunchAccepted`, frozen; ADR-019 runtime validation; 14 §1.7 answer at acceptance) through the
// seam-B dispatcher (ISSUE-165). A command the parser refuses is not a call error: it is accepted
// and settles `launch.failed{could-not-start}` (ADR-020 item 3), so only a refusal before any row
// (INV-50, INV-54) answers INVALID_PARAMS.
import { describe, expect, it } from 'vitest'
import { HOST_METHOD_SCHEMAS } from '@dwarfai/contracts'
import type { LaunchId, MineId } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { LaunchRefusedError, type LaunchCustomInput } from '../../modules/launching'
import { Dispatcher } from '../dispatcher'
import { registerLaunchingLaunchCustom } from './launchingLaunchCustom'

const REQUEST_ID = '01890a5d-ac96-774b-bcce-b302099a8165'
const LAUNCH = '01890a5d-ac96-774b-bcce-b302099a8166' as LaunchId
const MINE = '01890a5d-ac96-774b-bcce-b302099a8001' as MineId
const UI = { role: 'ui' as const, clientId: 'c-ui' }

const PARAMS = {
  mineId: MINE,
  command: 'my-agent --once',
  prompt: 'Survey the north seam',
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
  const calls: LaunchCustomInput[] = []
  registerLaunchingLaunchCustom(dispatcher, {
    launching: {
      launchCustom: async (req) => {
        calls.push(req)
        if (refusal !== undefined) throw refusal
        return { launchId: LAUNCH }
      }
    }
  })
  return { dispatcher, calls }
}

describe('launching.launchCustom params and result (14 §3.4, B-M34)', () => {
  it('[ADR-019] launchCustom params are strict and an extra key is refused', async () => {
    const { dispatcher, calls } = served()
    const ok = await dispatcher.dispatch(
      { id: '1', method: 'launching.launchCustom', params: PARAMS },
      UI
    )
    expect(ok).toMatchObject({ ok: true, result: { launchId: LAUNCH } })
    // The requestId is the transport's only (16 §4.5): the module gets the request without it.
    expect(calls).toEqual([
      { mineId: MINE, command: 'my-agent --once', prompt: 'Survey the north seam' }
    ])

    const extra = await dispatcher.dispatch(
      {
        id: '2',
        method: 'launching.launchCustom',
        params: { ...PARAMS, requestId: '01890a5d-ac96-774b-bcce-b302099a8167', shell: true }
      },
      UI
    )
    expect(extra).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } })
    expect(calls).toHaveLength(1)
  })

  it('[INV-50, ADR-019] a custom launch the Host refuses before any row is written answers INVALID_PARAMS', async () => {
    const { dispatcher } = served(new LaunchRefusedError('mine-not-enterable'))
    const res = await dispatcher.dispatch(
      { id: '1', method: 'launching.launchCustom', params: PARAMS },
      UI
    )
    expect(res).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS', retryable: false } })
  })

  it('[ADR-003] only a ui connection may launch a custom command', async () => {
    const { dispatcher, calls } = served()
    const res = await dispatcher.dispatch(
      { id: '1', method: 'launching.launchCustom', params: PARAMS },
      { role: 'viewer', clientId: 'c-v' }
    )
    expect(res).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(calls).toEqual([])
  })

  it('[ADR-019] the B-M34 schemas infer exactly the 14 §3.4 entry', () => {
    const { params, result } = HOST_METHOD_SCHEMAS['launching.launchCustom']
    expect(params.safeParse(PARAMS).success).toBe(true)
    expect(params.safeParse({ ...PARAMS, retryOf: LAUNCH }).success).toBe(true)
    expect(result.safeParse({ launchId: LAUNCH }).success).toBe(true)
    expect(result.safeParse({ launchId: LAUNCH, argv: [] }).success).toBe(false)
  })
})
