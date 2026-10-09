// @vitest-environment jsdom
// Renderer unit (17 §1.6): `useClaudeHooksSettings`, Settings → Integrations "Claude Code · instant updates"
// (14 §6.4 row "new `useClaudeHooksSettings`": snapshot `preferences.integrations` + `integration.changed`; A-N31;
// AMENDMENT-7; ADR-033 item 3), over the generated fake `window.api`: the snapshot's state first, then the B-F25
// frames above its seq; A-N31 relays `{ on, requestId }` and the answer's failure is shown, never a guessed state.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  HostFrame,
  HostFrames,
  IntegrationSetting,
  IpcResult,
  SetClaudeHooksParams,
  SetClaudeHooksResult,
  SnapshotPage,
  SnapshotParams
} from '@dwarfai/contracts'
import { createFakeWindowApi } from '../../../contracts/ipc/testing/fakeWindowApi'
import { useClaudeHooksSettings } from './useClaudeHooksSettings'

type Api = ReturnType<typeof createFakeWindowApi>
type SnapshotAnswer = IpcResult<SnapshotPage>

const EPOCH = 'epoch-0221'
const REQUEST = '01920000-0000-7000-a000-000000000221'

function page(seq: number, claude: IntegrationSetting): SnapshotAnswer {
  return {
    ok: true,
    value: {
      snapshotId: `snap-${seq}`,
      seq,
      epoch: EPOCH,
      chunks: [
        {
          section: 'preferences',
          data: {
            preferences: {
              subagentDelegationOn: false,
              routingProfile: 'balanced',
              systemNotificationsOn: true,
              openCodePermissionsOn: false
            },
            secrets: [],
            secretBackend: 'unavailable',
            integrations: [claude, { id: 'opencode-permissions', state: 'off', changedAt: 1 }],
            welcome: { due: false, legacyFound: [], offered: [] }
          }
        }
      ]
    }
  } as SnapshotAnswer
}

function changed(seq: number, data: HostFrames['integration.changed']): HostFrame {
  return { type: 'evt', seq, epoch: EPOCH, name: 'integration.changed', data } as HostFrame
}

interface Host {
  push(frames: HostFrame[]): void
  requests: SnapshotParams[]
  sent: SetClaudeHooksParams[]
}

/** The fake `window.api`: A-N01 answers `answer` (a function may push frames meanwhile), A-N31 answers `result`. */
function installHost(
  answer: SnapshotAnswer | (() => SnapshotAnswer),
  result: () => Promise<IpcResult<SetClaudeHooksResult>> = () =>
    Promise.resolve({ ok: true, value: { ok: true, value: { state: 'on-verified' } } })
): Host {
  let listener: ((frames: HostFrame[]) => void) | null = null
  const requests: SnapshotParams[] = []
  const sent: SetClaudeHooksParams[] = []
  const api = createFakeWindowApi({
    getHostSnapshot: vi.fn((request: SnapshotParams) => {
      requests.push(request)
      return Promise.resolve(typeof answer === 'function' ? answer() : answer)
    }) as unknown as Api['getHostSnapshot'],
    onHostEvent: vi.fn((follow: (frames: HostFrame[]) => void) => {
      listener = follow
      return () => {
        listener = null
      }
    }) as unknown as Api['onHostEvent'],
    setClaudeHooksEnabled: vi.fn((request: SetClaudeHooksParams) => {
      sent.push(request)
      return result()
    }) as unknown as Api['setClaudeHooksEnabled']
  })
  Object.defineProperty(window, 'api', { configurable: true, value: api })
  return {
    push(frames) {
      if (listener === null) throw new Error('nothing follows onHostEvent')
      listener(frames)
    },
    requests,
    sent
  }
}

const stops: Array<() => void> = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
})

function settings(newRequestId = () => REQUEST) {
  const hooks = useClaudeHooksSettings({ newRequestId })
  stops.push(hooks.stop)
  return hooks
}

describe('useClaudeHooksSettings (14 §6.4; A-N31, B-F25)', () => {
  it('[US-SET-013.AC01] the toggle state follows integration.changed', async () => {
    const host = installHost(page(10, { id: 'claude-hooks', state: 'off', changedAt: 1 }))
    const hooks = settings()

    expect(await hooks.start()).toBe(true)
    expect(host.requests).toEqual([{ sections: ['preferences'] }])
    expect(hooks.state.value).toBe('off')

    host.push([
      changed(11, { id: 'claude-hooks', state: 'on-verified', consentOrigin: 'settings' })
    ])
    expect(hooks.state.value).toBe('on-verified')
    // Another integration's frame changes nothing here.
    host.push([changed(12, { id: 'opencode-permissions', state: 'off' })])
    expect(hooks.state.value).toBe('on-verified')
    // A frame at or below the last applied seq is old news (ADR-033 item 3).
    host.push([changed(12, { id: 'claude-hooks', state: 'off' })])
    host.push([changed(9, { id: 'claude-hooks', state: 'off' })])
    expect(hooks.state.value).toBe('on-verified')
    host.push([changed(13, { id: 'claude-hooks', state: 'off' })])
    expect(hooks.state.value).toBe('off')
  })

  it('[US-SET-013.AC01, ADR-033] a frame at or below the snapshot seq that arrived while the snapshot was read is dropped; a newer one applies', async () => {
    let host: Host | null = null
    host = installHost(() => {
      host?.push([
        changed(7, { id: 'claude-hooks', state: 'off' }),
        changed(8, { id: 'claude-hooks', state: 'off' })
      ])
      return page(8, {
        id: 'claude-hooks',
        state: 'on-unverified',
        consentOrigin: 'settings',
        changedAt: 2
      })
    })
    const hooks = settings()

    await hooks.start()

    // The snapshot already holds what frames 7 and 8 said.
    expect(hooks.state.value).toBe('on-unverified')
    host.push([changed(9, { id: 'claude-hooks', state: 'on-verified', consentOrigin: 'settings' })])
    expect(hooks.state.value).toBe('on-verified')
  })

  it('[US-SET-013.AC02] a fresh install reads off from the snapshot', async () => {
    installHost(page(3, { id: 'claude-hooks', state: 'off', changedAt: 1 }))
    const hooks = settings()
    expect(hooks.state.value).toBe('off')
    await hooks.start()
    expect(hooks.state.value).toBe('off')
    expect(hooks.failure.value).toBeNull()
  })

  it('[US-SET-013.AC04, FM-148] turning it on or off calls A-N31 with one requestId per intent; a failure is shown and the state stays the frames’', async () => {
    let next: IpcResult<SetClaudeHooksResult> = {
      ok: true,
      value: { ok: false, error: 'config-revert-failed' }
    }
    const host = installHost(
      page(4, {
        id: 'claude-hooks',
        state: 'on-verified',
        consentOrigin: 'settings',
        changedAt: 1
      }),
      () => Promise.resolve(next)
    )
    const ids = ['01920000-0000-7000-a000-000000000001', '01920000-0000-7000-a000-000000000002']
    const hooks = settings(() => ids.shift() ?? REQUEST)
    await hooks.start()

    await hooks.setEnabled(false)
    // The Host answered the locked turn-off with the unchanged state (16 §7.4).
    host.push([changed(5, { id: 'claude-hooks', state: 'on-verified', consentOrigin: 'settings' })])
    expect(hooks.failure.value).toBe('config-revert-failed')
    expect(hooks.state.value).toBe('on-verified')

    next = { ok: true, value: { ok: true, value: { state: 'off' } } }
    await hooks.setEnabled(false)
    host.push([changed(6, { id: 'claude-hooks', state: 'off' })])
    expect(hooks.failure.value).toBeNull()
    expect(hooks.state.value).toBe('off')
    expect(host.sent).toEqual([
      { on: false, requestId: '01920000-0000-7000-a000-000000000001' },
      { on: false, requestId: '01920000-0000-7000-a000-000000000002' }
    ])
  })

  it('[ADR-016] a second toggle while one is in flight is ignored, and a refused call keeps the frames’ state', async () => {
    let release: (value: IpcResult<SetClaudeHooksResult>) => void = () => undefined
    const host = installHost(page(4, { id: 'claude-hooks', state: 'off', changedAt: 1 }), () => {
      return new Promise((resolve) => {
        release = resolve
      })
    })
    const hooks = settings()
    await hooks.start()

    const first = hooks.setEnabled(true)
    expect(hooks.applying.value).toBe(true)
    await hooks.setEnabled(false)
    release({ ok: false, error: { code: 'HOST_NOT_READY', message: 'starting', retryable: true } })
    await first

    expect(host.sent).toHaveLength(1)
    expect(hooks.applying.value).toBe(false)
    expect(hooks.state.value).toBe('off')
  })

  // AMENDED for ISSUE-221 (appended, review F5).
  it('[US-SET-013.AC01, ADR-033] an answer with a state but no frame leaves the state as the frames say', async () => {
    const host = installHost(page(4, { id: 'claude-hooks', state: 'off', changedAt: 1 }), () =>
      Promise.resolve({ ok: true, value: { ok: true, value: { state: 'on-verified' } } })
    )
    const hooks = settings()
    await hooks.start()

    await hooks.setEnabled(true)

    expect(host.sent).toHaveLength(1)
    expect(hooks.failure.value).toBeNull()
    expect(hooks.state.value).toBe('off')
  })
})
