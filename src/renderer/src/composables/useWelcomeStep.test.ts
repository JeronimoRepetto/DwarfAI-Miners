// @vitest-environment jsdom
// Renderer unit (17 §1.6): `useWelcomeStep`, the first-run consent step (14 §6.4 row "new `useWelcomeStep`":
// singleton; snapshot `preferences.welcome` + `preferences.changed`; A-N32; shows only the options in
// `welcome.offered`; AMENDMENT-7, AMENDMENT-9; 07 machine 41; ADR-033 items 2–3), over the generated fake `window.api`:
// the snapshot's step first, then the B-F24 frames above its seq; A-N32 relays the ticks as the person left them with
// one requestId, and a per-integration failure of the result is kept for one display.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AnswerWelcomeParams,
  AnswerWelcomeResult,
  HostFrame,
  IntegrationId,
  IpcResult,
  PreferencesView,
  SnapshotPage,
  SnapshotParams,
  WelcomeStepState
} from '@dwarfai/contracts'
import { createFakeWindowApi } from '../../../contracts/ipc/testing/fakeWindowApi'
import { useWelcomeStep } from './useWelcomeStep'

type Api = ReturnType<typeof createFakeWindowApi>
type SnapshotAnswer = IpcResult<SnapshotPage>

const EPOCH = 'epoch-0224'
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const BOTH: IntegrationId[] = ['claude-hooks', 'opencode-permissions']

function due(offered: IntegrationId[] = BOTH): WelcomeStepState {
  return { due: true, reason: 'first-run', legacyFound: [], offered }
}

const ANSWERED: WelcomeStepState = { due: false, legacyFound: [], offered: BOTH }

function preferences(welcome: WelcomeStepState): PreferencesView {
  return {
    preferences: {
      subagentDelegationOn: false,
      routingProfile: 'balanced',
      systemNotificationsOn: true,
      openCodePermissionsOn: false
    },
    secrets: [],
    secretBackend: 'unavailable',
    integrations: [
      { id: 'claude-hooks', state: 'off', changedAt: 1 },
      { id: 'opencode-permissions', state: 'off', changedAt: 1 }
    ],
    welcome
  } as PreferencesView
}

function page(seq: number, welcome: WelcomeStepState): SnapshotAnswer {
  return {
    ok: true,
    value: {
      snapshotId: `snap-${seq}`,
      seq,
      epoch: EPOCH,
      chunks: [{ section: 'preferences', data: preferences(welcome) }]
    }
  } as SnapshotAnswer
}

function changed(seq: number, welcome: WelcomeStepState): HostFrame {
  return {
    type: 'evt',
    seq,
    epoch: EPOCH,
    name: 'preferences.changed',
    data: preferences(welcome)
  } as HostFrame
}

function settled(
  integrations: Partial<AnswerWelcomeResult['integrations']> = {}
): IpcResult<AnswerWelcomeResult> {
  return {
    ok: true,
    value: {
      integrations: {
        'claude-hooks': { state: 'on-verified' },
        'opencode-permissions': { state: 'on-verified' },
        ...integrations
      },
      welcome: ANSWERED
    }
  }
}

interface Host {
  push(frames: HostFrame[]): void
  sent: AnswerWelcomeParams[]
}

/** The fake `window.api`: A-N01 answers `answer` (a function may push frames meanwhile), A-N32 answers `result`. */
function installHost(
  answer: SnapshotAnswer | (() => SnapshotAnswer),
  result: () => Promise<IpcResult<AnswerWelcomeResult>> = () => Promise.resolve(settled())
): Host {
  let listener: ((frames: HostFrame[]) => void) | null = null
  const sent: AnswerWelcomeParams[] = []
  const api = createFakeWindowApi({
    getHostSnapshot: vi.fn((_request: SnapshotParams) =>
      Promise.resolve(typeof answer === 'function' ? answer() : answer)
    ) as unknown as Api['getHostSnapshot'],
    onHostEvent: vi.fn((follow: (frames: HostFrame[]) => void) => {
      listener = follow
      return () => {
        listener = null
      }
    }) as unknown as Api['onHostEvent'],
    answerWelcome: vi.fn((request: AnswerWelcomeParams) => {
      sent.push(request)
      return result()
    }) as unknown as Api['answerWelcome']
  })
  Object.defineProperty(window, 'api', { configurable: true, value: api })
  return {
    push(frames) {
      if (listener === null) throw new Error('nothing follows onHostEvent')
      listener(frames)
    },
    sent
  }
}

afterEach(() => {
  useWelcomeStep().stop()
})

describe('useWelcomeStep (14 §6.4; A-N32, B-F24; 07 machine 41)', () => {
  it('[US-SET-012.AC07] only the options in welcome.offered are shown, each pre-selected', async () => {
    installHost(page(5, due(['opencode-permissions'])))
    const step = useWelcomeStep()

    expect(await step.start()).toBe(true)

    expect(step.due.value).toBe(true)
    expect(step.options.value).toEqual([{ id: 'opencode-permissions', ticked: true }])
  })

  it('[US-SET-012.AC07] with both tools offered both options are shown, Claude Code first, each pre-selected', async () => {
    installHost(page(5, due(['opencode-permissions', 'claude-hooks'])))
    const step = useWelcomeStep()

    await step.start()

    expect(step.options.value).toEqual([
      { id: 'claude-hooks', ticked: true },
      { id: 'opencode-permissions', ticked: true }
    ])
  })

  it('[US-SET-012.AC03] Activate sends answerWelcome with the ticks as left', async () => {
    const host = installHost(page(5, due()))
    const step = useWelcomeStep()
    await step.start()
    // Nothing is sent before the click (ADR-016 item 5).
    expect(host.sent).toEqual([])

    await step.answer({ 'claude-hooks': false, 'opencode-permissions': true })

    expect(host.sent).toEqual([
      { claudeHooks: false, openCodePermissions: true, requestId: expect.stringMatching(UUID_V7) }
    ])
  })

  it('[US-SET-012.AC07, S41.04] a tick for an option not offered is sent unticked', async () => {
    const host = installHost(page(5, due(['opencode-permissions'])))
    const step = useWelcomeStep()
    await step.start()

    await step.answer({ 'claude-hooks': true, 'opencode-permissions': true })

    expect(host.sent).toEqual([
      { claudeHooks: false, openCodePermissions: true, requestId: expect.stringMatching(UUID_V7) }
    ])
  })

  it('[US-SET-012.AC03] a second Activate while one is in flight sends nothing', async () => {
    let release: (value: IpcResult<AnswerWelcomeResult>) => void = () => undefined
    const host = installHost(
      page(5, due()),
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const step = useWelcomeStep()
    await step.start()

    const first = step.answer({ 'claude-hooks': true, 'opencode-permissions': true })
    expect(step.answering.value).toBe(true)
    await step.answer({ 'claude-hooks': true, 'opencode-permissions': true })
    release(settled())
    await first

    expect(host.sent).toHaveLength(1)
    expect(step.answering.value).toBe(false)
  })

  it('[S41.05] preferences.changed with due false closes the step', async () => {
    const host = installHost(page(5, due()))
    const step = useWelcomeStep()
    await step.start()

    // A frame at or below the last applied seq is old news (ADR-033 item 3).
    host.push([changed(5, ANSWERED)])
    expect(step.due.value).toBe(true)

    host.push([changed(6, ANSWERED)])
    expect(step.due.value).toBe(false)
    expect(step.options.value).toEqual([])
  })

  it('[S41.05, ADR-033] a frame at or below the snapshot seq that arrived while the snapshot was read is dropped', async () => {
    let host: Host | null = null
    host = installHost(() => {
      host?.push([changed(7, ANSWERED)])
      return page(8, due())
    })
    const step = useWelcomeStep()

    await step.start()

    // The snapshot (seq 8) is newer than the buffered frame (seq 7): the step stays due.
    expect(step.due.value).toBe(true)
  })

  it('[S41.05] the answer alone never closes the step: the frame does', async () => {
    const host = installHost(page(5, due()))
    const step = useWelcomeStep()
    await step.start()

    await step.answer({ 'claude-hooks': true, 'opencode-permissions': true })
    expect(step.due.value).toBe(true)

    host.push([changed(6, ANSWERED)])
    expect(step.due.value).toBe(false)
  })

  it('[S41.08] a step still due after a reload is shown again', async () => {
    const host = installHost(page(5, due()))
    let step = useWelcomeStep()
    await step.start()
    // The window closes without an answer.
    step.stop()
    expect(step.due.value).toBe(false)
    expect(host.sent).toEqual([])

    installHost(page(9, due()))
    step = useWelcomeStep()
    await step.start()

    expect(step.due.value).toBe(true)
    expect(step.options.value).toEqual([
      { id: 'claude-hooks', ticked: true },
      { id: 'opencode-permissions', ticked: true }
    ])
  })

  it('[ADR-016, S41.05] a per-integration failure of the result is kept for one display', async () => {
    const host = installHost(page(5, due()), () =>
      Promise.resolve(
        settled({ 'opencode-permissions': { state: 'off', failure: 'config-write-failed' } })
      )
    )
    const step = useWelcomeStep()
    await step.start()

    await step.answer({ 'claude-hooks': true, 'opencode-permissions': true })
    host.push([changed(6, ANSWERED)])

    expect(step.failures.value).toEqual([
      { id: 'opencode-permissions', failure: 'config-write-failed' }
    ])
    expect(step.shown.value).toBe(true)

    step.acknowledge()
    expect(step.failures.value).toEqual([])
    expect(step.shown.value).toBe(false)
  })

  it('[S41.05, 14 §3.10] an answer that failed or timed out keeps the step shown with nothing to report', async () => {
    const host = installHost(page(5, due()), () =>
      Promise.resolve({
        ok: false,
        error: { code: 'TIMEOUT', message: 'no answer', retryable: true }
      })
    )
    const step = useWelcomeStep()
    await step.start()

    await step.answer({ 'claude-hooks': true, 'opencode-permissions': true })

    expect(host.sent).toHaveLength(1)
    expect(step.due.value).toBe(true)
    expect(step.shown.value).toBe(true)
    expect(step.failures.value).toEqual([])
    expect(step.answering.value).toBe(false)
  })

  it('[S41.08] the step is not shown while the Host has not reported it due', async () => {
    installHost(page(5, ANSWERED))
    const step = useWelcomeStep()
    expect(step.shown.value).toBe(false)

    await step.start()

    expect(step.due.value).toBe(false)
    expect(step.shown.value).toBe(false)
  })
})
