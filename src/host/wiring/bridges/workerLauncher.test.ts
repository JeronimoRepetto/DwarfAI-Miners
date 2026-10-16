// layer: L2
// L2 (17 §1.2): the `WorkerLauncher` bridge (16 §4.8, as AMENDMENT-15 (owner, 2026-10-15) gives it
// the delegation id; ISSUE-180) over a scripted launching command, the parent's crew view and a
// RecordingEventBus: the bridge sends one delegated launch and answers only once that launch has
// settled (16 §2.9), with the worker's DwarfId or exactly its launch failure cause (INV-52).
import { describe, expect, it } from 'vitest'
import type { JevSuggestionView } from '@dwarfai/contracts'
import type { LaunchFailure } from '../../kernel/domain/sharedContracts'
import type {
  DwarfId,
  EventId,
  HostEpoch,
  LaunchId,
  MineId,
  ProviderId
} from '../../kernel/domain/values'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import type { DomainEventBus } from '../../kernel/ports/domainEventBus'
import type { DwarfView } from '../../modules/crew'
import {
  buildLaunchFailure,
  LaunchRefusedError,
  type LaunchingEvent,
  type LaunchRequestInput
} from '../../modules/launching'
import { createWorkerLauncher } from './workerLauncher'

const EPOCH = 'epoch-180' as HostEpoch
const MINE = '00000000-0000-7000-8000-0000000180a1' as MineId
const PARENT = '00000000-0000-7000-8000-0000000180d0' as DwarfId
const WORKER = '00000000-0000-7000-8000-0000000180d1' as DwarfId
const OTHER = '00000000-0000-7000-8000-0000000180d2' as DwarfId
const LAUNCH = '00000000-0000-7000-8000-0000000180c1' as LaunchId
const ELSEWHERE = '00000000-0000-7000-8000-0000000180c2' as LaunchId
const DELEGATION = '00000000-0000-7000-8000-0000000180de'
const TASK = 'Map the old shafts below the north seam'

const PICK: JevSuggestionView = {
  providerId: 'simulated',
  model: 'sim-small',
  effort: 'low',
  confidence: { providerId: 0.9 },
  truncated: false,
  parts: { providerId: 'answered', model: 'answered', effort: 'answered' }
}

interface HarnessOptions {
  /** The parent as crew sees it: present (default), departed, or unknown. */
  parent?: 'present' | 'departed' | 'gone'
  /** Runs inside `launch` before it answers, e.g. to refuse it or to publish an early settlement. */
  duringLaunch?: () => void
}

function harness(options: HarnessOptions = {}) {
  const bus = new RecordingEventBus<LaunchingEvent>()
  const requests: LaunchRequestInput[] = []
  // Counts the live subscriptions the bridge holds on the bus.
  let subscriptions = 0
  const events: Pick<DomainEventBus<LaunchingEvent>, 'subscribe'> = {
    subscribe: (type, handler, opts) => {
      const stop = bus.subscribe(type, handler, opts)
      subscriptions += 1
      let stopped = false
      return () => {
        if (stopped) return
        stopped = true
        subscriptions -= 1
        stop()
      }
    }
  }
  const parent = options.parent ?? 'present'
  const launcher = createWorkerLauncher({
    launching: {
      launch: async (req) => {
        requests.push(req)
        options.duringLaunch?.()
        return { launchId: LAUNCH }
      }
    },
    events,
    crew: {
      get: (dwarfId) =>
        dwarfId === PARENT && parent !== 'gone'
          ? ({ id: PARENT, mineId: MINE, departed: parent === 'departed' } as DwarfView)
          : null
    }
  })
  let n = 0
  const meta = () => ({ v: 1 as const, id: `e-${++n}` as EventId, at: 0, hostEpoch: EPOCH })
  return {
    bus,
    requests,
    launcher,
    subscriptions: () => subscriptions,
    launched(launchId: LaunchId, dwarfId: DwarfId): void {
      bus.publish({
        type: 'DwarfLaunched',
        payload: {
          launchId,
          dwarfId,
          mineId: MINE,
          ref: { providerId: 'simulated' as ProviderId, providerSessionId: `s-${dwarfId}` },
          parentDwarfId: PARENT,
          delegated: true,
          prompt: TASK
        },
        ...meta()
      })
    },
    failed(launchId: LaunchId, failure: LaunchFailure): void {
      bus.publish({ type: 'LaunchFailed', payload: { launchId, mineId: MINE, failure }, ...meta() })
    }
  }
}

/** Lets pending promise jobs run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

describe('WorkerLauncher bridge', () => {
  it("[ADR-013] launchWorker answers only after the launch settled, with the worker's DwarfId", async () => {
    const h = harness()
    let answer: unknown
    void h.launcher.launchWorker(DELEGATION, PARENT, PICK, TASK).then((a) => {
      answer = a
    })
    await flush()

    // Accepted, not settled: no answer yet.
    expect(h.requests).toHaveLength(1)
    expect(answer).toBeUndefined()
    // Another launch's settlement is not this one's.
    h.launched(ELSEWHERE, OTHER)
    await flush()
    expect(answer).toBeUndefined()

    h.launched(LAUNCH, WORKER)
    await flush()
    expect(answer).toEqual({ ok: true, value: WORKER })
  })

  it('[INV-52] a failed worker launch answers exactly its launch failure cause', async () => {
    const h = harness()
    const answer = h.launcher.launchWorker(DELEGATION, PARENT, PICK, TASK)
    await flush()

    h.failed(LAUNCH, buildLaunchFailure({ cause: 'exited-at-once', supplierLabel: 'Simulated' }))

    expect(await answer).toEqual({ ok: false, error: 'exited-at-once' })
  })

  it("[ADR-013] the delegated launch carries the pick, the task as its prompt, the parent's mine and the delegation", async () => {
    const h = harness()
    void h.launcher.launchWorker(DELEGATION, PARENT, PICK, TASK)
    await flush()

    expect(h.requests).toEqual([
      {
        mineId: MINE,
        way: { kind: 'supplier', providerId: 'simulated' },
        model: 'sim-small',
        effort: 'low',
        prompt: TASK,
        jevOn: false,
        jevAutoAccept: false,
        delegation: { delegationId: DELEGATION, parentDwarfId: PARENT }
      }
    ])
  })

  it('[S5.15, ADR-028] a pick that fell back is sent as a jev way with its reason, never as a supplier', async () => {
    const h = harness()
    const fellBack: JevSuggestionView = {
      confidence: {},
      truncated: false,
      parts: {},
      fallback: 'effort-ceiling'
    }
    void h.launcher.launchWorker(DELEGATION, PARENT, fellBack, TASK)
    await flush()

    expect(h.requests).toEqual([
      {
        mineId: MINE,
        way: { kind: 'jev' },
        prompt: TASK,
        jevOn: false,
        jevAutoAccept: false,
        delegation: { delegationId: DELEGATION, parentDwarfId: PARENT, fallback: 'effort-ceiling' }
      }
    ])
  })

  it('[INV-52] a parent crew no longer knows, or one that departed, answers could-not-start and launches nothing', async () => {
    for (const parent of ['gone', 'departed'] as const) {
      const h = harness({ parent })

      expect(await h.launcher.launchWorker(DELEGATION, PARENT, PICK, TASK)).toEqual({
        ok: false,
        error: 'could-not-start'
      })
      expect(h.requests).toEqual([])
      expect(h.subscriptions()).toBe(0)
    }
  })

  it('[INV-52] a launch refused at acceptance answers could-not-start, never a sixth cause', async () => {
    const h = harness({
      duringLaunch: () => {
        throw new LaunchRefusedError('mine-not-enterable')
      }
    })

    expect(await h.launcher.launchWorker(DELEGATION, PARENT, PICK, TASK)).toEqual({
      ok: false,
      error: 'could-not-start'
    })
    expect(h.requests).toHaveLength(1)
    expect(h.subscriptions()).toBe(0)
  })

  it('[ADR-013] a settlement published before launch answered is not missed', async () => {
    const h = harness({ duringLaunch: () => h.launched(LAUNCH, WORKER) })

    expect(await h.launcher.launchWorker(DELEGATION, PARENT, PICK, TASK)).toEqual({
      ok: true,
      value: WORKER
    })
  })

  it('[ADR-013] the bridge holds no bus subscription once the launch settled, on success and on failure', async () => {
    const h = harness()
    const succeeded = h.launcher.launchWorker(DELEGATION, PARENT, PICK, TASK)
    await flush()
    expect(h.subscriptions()).toBe(2)
    h.launched(LAUNCH, WORKER)
    await succeeded
    expect(h.subscriptions()).toBe(0)

    const failed = h.launcher.launchWorker(DELEGATION, PARENT, PICK, TASK)
    await flush()
    expect(h.subscriptions()).toBe(2)
    h.failed(LAUNCH, buildLaunchFailure({ cause: 'not-installed', supplierLabel: 'Simulated' }))
    await failed
    expect(h.subscriptions()).toBe(0)
  })
})
