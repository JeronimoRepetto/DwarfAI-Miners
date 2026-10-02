// @vitest-environment jsdom
import type { HostConnectionView } from '@dwarfai/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeWindowApi } from '../../../contracts/ipc/testing/fakeWindowApi'
import { defaultDwarf, defaultMine } from '../testing/factories'
import {
  DEFAULT_JEV_PREFERENCES,
  DEFAULT_JEV_SETTINGS,
  DEFAULT_OPENCODE_SETTINGS,
  type DwarfPermissionRequest,
  type DwarfQuestion
} from '../types'
import { useAgentLaunch } from './useAgentLaunch'
import { useDwarfKicking } from './useDwarfKicking'
import { useDwarfMessaging } from './useDwarfMessaging'
import { useDwarfQuestion } from './useDwarfQuestion'
import { useHostConnection } from './useHostConnection'
import { useJevSettings } from './useJevSettings'
import { useMines } from './useMines'
import { useNotificationSettings } from './useNotificationSettings'
import { useOpenCodeSettings } from './useOpenCodeSettings'
import { useProjectBrowse } from './useProjectBrowse'
import { useResetMetrics } from './useResetMetrics'
import { useToasts } from './useToasts'

/** `window.api`'s own type, as the preload declares it on `Window` (R8: never imported from the preload). */
type DwarfAiMinersApi = Window['api']

/*
 * The renderer's read model of the Host connection (14 §6.4 new `useHostConnection`; ADR-002 D9; 07 §12B): it reads
 * A-N03 `getHostConnection` once and follows the A-N04 `onHostConnection` push; while the Host is not `connected` the
 * Panel keeps its last snapshot read-only and no Host-owned mutation leaves (13 FM-146). Tested against the generated
 * fake `window.api` with scripted pushes (ADR-033 item 7).
 */

const connected: HostConnectionView = {
  state: 'connected',
  hostVersion: '1.0.0',
  compat: false,
  capabilities: []
}
const reconnecting: HostConnectionView = { state: 'reconnecting', since: 1_000 }
const crashLoop: HostConnectionView = { state: 'unavailable', reason: 'crash-loop' }

interface Scripted {
  api: DwarfAiMinersApi
  push(view: unknown): void
}

/** The fake `window.api` with A-N03 answering `first` and A-N04 scripted by the test. */
function install(first: unknown, overrides: Partial<DwarfAiMinersApi> = {}): Scripted {
  let listener: ((view: HostConnectionView) => void) | null = null
  const api = createFakeWindowApi({
    getHostConnection: vi.fn(() => Promise.resolve(first as HostConnectionView)),
    onHostConnection: vi.fn((next: (view: HostConnectionView) => void) => {
      listener = next
      return () => {
        listener = null
      }
    }),
    ...overrides
  })
  Object.defineProperty(window, 'api', { configurable: true, value: api })
  return {
    api,
    push(view) {
      if (listener === null) throw new Error('nothing follows onHostConnection')
      listener(view as HostConnectionView)
    }
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

const question: DwarfQuestion = {
  toolUseId: 'toolu_01',
  channel: 'held',
  questions: [
    {
      question: 'Which database?',
      multiSelect: false,
      options: [{ label: 'Postgres' }, { label: 'SQLite' }]
    }
  ]
}
const permission: DwarfPermissionRequest = {
  toolUseId: 'toolu_p1',
  toolName: 'Bash',
  input: 'pnpm install',
  channel: 'held',
  askedAt: '2026-09-28T09:00:00.000Z'
}

beforeEach(() => {
  useHostConnection().stop()
  useDwarfMessaging().clearAll()
  useDwarfQuestion().clearAll()
  useDwarfKicking().clearAll()
})

afterEach(() => {
  useHostConnection().stop()
})

describe('useHostConnection', () => {
  it('[FM-146, ADR-002] while reconnecting the read model is read-only and a Host-owned action is not sent', async () => {
    const sendDwarfText = vi.fn(() =>
      Promise.resolve({ delivered: true, via: 'terminal' as const })
    )
    const { push } = install(connected, { sendDwarfText })
    const host = useHostConnection()
    await host.start()
    expect(host.readOnly.value).toBe(false)

    push(reconnecting)
    expect(host.readOnly.value).toBe(true)
    const messaging = useDwarfMessaging()
    await expect(messaging.send('dwarf-1', 'dig', true)).resolves.toBe(false)
    expect(sendDwarfText).not.toHaveBeenCalled()
    // No delivery mark and no bubble is invented for a send that never left (ADR-002 D9).
    expect(messaging.echoesFor('dwarf-1')).toEqual([])
    expect(messaging.stateFor('dwarf-1')).toBeUndefined()

    push(connected)
    expect(host.readOnly.value).toBe(false)
    await expect(messaging.send('dwarf-1', 'dig', true)).resolves.toBe(true)
    expect(sendDwarfText).toHaveBeenCalledOnce()
  })

  /*
   * Every Host-owned mutation of 13 FM-146 and ADR-002 D9 (send, answer, launch, stop, remove, reset, Host-owned
   * settings), each through the read model that owns its call: none of them leaves while the Host is reconnecting.
   */
  const hostOwned: ReadonlyArray<{
    name: string
    member: keyof DwarfAiMinersApi
    answer: unknown
    arrange?: () => Promise<void>
    act: () => Promise<unknown>
  }> = [
    {
      name: 'an answer to a question',
      member: 'answerDwarfQuestion',
      answer: { answered: true },
      act: () => useDwarfQuestion().answer('dwarf-1', question, 'Postgres')
    },
    {
      name: 'an answer in the person’s own words',
      member: 'answerDwarfQuestion',
      answer: { answered: true },
      act: () => useDwarfQuestion().answerWithText('dwarf-1', question, 'MySQL')
    },
    {
      name: 'a permission decision',
      member: 'answerDwarfPermission',
      answer: { answered: true },
      act: () => useDwarfQuestion().decide('dwarf-1', permission, 'allow')
    },
    {
      name: 'a retry of a failed message',
      member: 'sendDwarfText',
      answer: { delivered: false, via: 'none', error: 'refused' },
      // The message failed while the Host was connected; its Retry is pressed while it is not.
      arrange: async () => {
        await useDwarfMessaging().send('dwarf-1', 'dig', true)
      },
      act: () => {
        const failed = useDwarfMessaging().echoesFor('dwarf-1')[0]!
        expect(failed.state.phase).toBe('failed')
        return useDwarfMessaging().retry('dwarf-1', failed.id)
      }
    },
    {
      name: 'a stop',
      member: 'kickDwarf',
      answer: { delivered: true, via: 'terminal' },
      act: () => useDwarfKicking().kick('dwarf-1')
    },
    {
      name: 'a launch',
      member: 'launchHeldSession',
      answer: { launched: true },
      act: async () => {
        const launch = useAgentLaunch()
        await launch.open('mine-1')
        launch.choose('claude')
        launch.setPrompt('dig the east gallery')
        await launch.submit()
      }
    },
    {
      name: 'a mine removal',
      member: 'undeclareMine',
      answer: { outcome: 'removed' },
      act: () => useProjectBrowse().removeProject('mine-1')
    },
    {
      name: 'a new mine',
      member: 'declareMine',
      answer: { outcome: 'cancelled' },
      act: () => useProjectBrowse().addProject()
    },
    {
      name: 'a main-project mine',
      member: 'declareMainProject',
      answer: { outcome: 'cancelled' },
      act: () => useProjectBrowse().openMainProject()
    },
    {
      name: 'a metrics reset',
      member: 'resetMetrics',
      answer: { outcome: 'reset' },
      act: () => useResetMetrics().reset()
    },
    {
      name: 'the notifications switch',
      member: 'setNotificationsEnabled',
      answer: true,
      act: () => useNotificationSettings().set(false)
    },
    {
      name: 'a Jev key',
      member: 'setJevApiKey',
      answer: DEFAULT_JEV_SETTINGS,
      act: () => useJevSettings().save('key')
    },
    {
      name: 'forgetting the Jev key',
      member: 'clearJevApiKey',
      answer: DEFAULT_JEV_SETTINGS,
      act: () => useJevSettings().clear()
    },
    {
      name: 'the Jev preferences',
      member: 'setJevPreferences',
      answer: DEFAULT_JEV_SETTINGS,
      act: () => useJevSettings().setPreferences(DEFAULT_JEV_PREFERENCES)
    },
    {
      name: 'the OpenCode relay switch',
      member: 'setOpenCodePluginEnabled',
      answer: DEFAULT_OPENCODE_SETTINGS,
      act: () => useOpenCodeSettings().setPluginEnabled(true)
    },
    {
      name: 'an OpenCode server password',
      member: 'setOpenCodeServerPassword',
      answer: DEFAULT_OPENCODE_SETTINGS,
      act: () => useOpenCodeSettings().savePassword('secret')
    },
    {
      name: 'forgetting the OpenCode server password',
      member: 'clearOpenCodeServerPassword',
      answer: DEFAULT_OPENCODE_SETTINGS,
      act: () => useOpenCodeSettings().clearPassword()
    }
  ]

  it.each(hostOwned)(
    '[FM-146, ADR-002] while reconnecting $name is not sent',
    async ({ member, answer, arrange, act }) => {
      const call = vi.fn(() => Promise.resolve(answer))
      const { push } = install(connected, {
        [member]: call,
        listAgentProviders: vi.fn(() =>
          Promise.resolve({
            providers: [{ provider: 'claude' as const, installed: true, launchable: true }]
          })
        ),
        listAgentModels: vi.fn(() => Promise.resolve({ catalogs: [] })),
        getJevSettings: vi.fn(() => Promise.resolve(DEFAULT_JEV_SETTINGS)),
        getNotificationsEnabled: vi.fn(() => Promise.resolve(true)),
        getOpenCodeSettings: vi.fn(() => Promise.resolve(DEFAULT_OPENCODE_SETTINGS)),
        queryProjects: vi.fn(() => Promise.reject(new Error('not asked here')))
      })
      await useHostConnection().start()
      await arrange?.()
      const sentBefore = call.mock.calls.length
      push(reconnecting)

      await act()
      expect(call).toHaveBeenCalledTimes(sentBefore)
    }
  )

  it('[ADR-002, S12.B04] a lost connection keeps every dwarf of the last snapshot and raises no toast but the reconnecting notice', async () => {
    const { push } = install(connected)
    const host = useHostConnection()
    await host.start()
    const mines = useMines()
    mines.clear()
    const crew = [defaultDwarf({ id: 'a' }), defaultDwarf({ id: 'b' })]
    mines.setMines({ mines: [defaultMine({ dwarfs: crew })], tokensObserved: 0 })
    const before = mines.state.mines

    push(reconnecting)
    push(crashLoop)

    expect(host.message.value.variant).toBe('crash-loop')
    expect(mines.state.mines).toBe(before)
    expect(mines.state.mines[0]!.dwarfs.map((dwarf) => dwarf.id)).toEqual(['a', 'b'])
    // AMENDED for the owner's ruling of 2026-10-02 (was: no toast at all): the reconnecting notice is now its one
    // toast; the crash-loop is the dialog and raises none, and no toast is about the board.
    const texts = useToasts().toasts.value.map((toast) => toast.text)
    expect(texts).toContain('⟦COPY NEEDED: O-5 reconnecting message⟧')
    expect(texts).not.toContain('⟦COPY NEEDED: O-15 crash-loop variant⟧')
  })

  // Owner's ruling (2026-10-02): a notice without an action is a toast, raised once per entry into its state.
  it('[ADR-002, FM-012] each state without an action raises exactly one toast when it is entered, and a repeat raises none', async () => {
    const { push } = install(connected)
    const host = useHostConnection()
    await host.start()
    const raised = (text: string): number =>
      useToasts().toasts.value.filter((toast) => toast.text === text).length
    const inJobText = '⟦COPY NEEDED: O-4 in-job message⟧'
    const reconnectingText = '⟦COPY NEEDED: O-5 reconnecting message⟧'
    const inJobBefore = raised(inJobText)
    const reconnectingBefore = raised(reconnectingText)

    push({ ...connected, jobStatus: 'in-job' })
    push({ ...connected, jobStatus: 'in-job' })
    expect(raised(inJobText), 'connected in-job toasts once').toBe(inJobBefore + 1)

    push(reconnecting)
    push({ state: 'reconnecting', since: 2_000 })
    expect(raised(reconnectingText), 'reconnecting toasts once').toBe(reconnectingBefore + 1)

    push(connected)
    push(reconnecting)
    expect(raised(reconnectingText), 'a second reconnect toasts again').toBe(reconnectingBefore + 2)

    push(crashLoop)
    expect(
      raised('⟦COPY NEEDED: O-15 crash-loop variant⟧'),
      'a notice with an action is no toast'
    ).toBe(0)
  })

  it('[ADR-002] retry calls retryHostConnection once and the message stays until the push reports connected', async () => {
    let answerRetry: (view: HostConnectionView) => void = () => undefined
    const retryHostConnection = vi.fn(
      () =>
        new Promise<HostConnectionView>((resolve) => {
          answerRetry = resolve
        })
    )
    const confirmHostRestart = vi.fn(() => Promise.resolve(connected))
    const { push } = install(crashLoop, { retryHostConnection, confirmHostRestart })
    const host = useHostConnection()
    await host.start()
    expect(host.message.value.variant).toBe('crash-loop')

    const first = host.retry()
    const second = host.retry()
    answerRetry({ state: 'connecting' })
    await Promise.all([first, second])
    expect(retryHostConnection).toHaveBeenCalledOnce()
    expect(host.message.value.variant).toBe('crash-loop')

    push({ state: 'connecting' })
    expect(host.message.value.variant).toBe('crash-loop')
    expect(host.readOnly.value).toBe(true)

    push(connected)
    expect(host.message.value.variant).toBe('none')
    expect(host.readOnly.value).toBe(false)
    expect(confirmHostRestart).not.toHaveBeenCalled()
  })

  it('[ADR-002] an unrouted Host connection row leaves the Panel usable and shows no message', async () => {
    // Hidden until built (21 §1 item 8): until the cut-0 switch the router refuses A-N03 with a typed error.
    install({
      ok: false,
      error: { code: 'METHOD_NOT_FOUND', message: 'no route', retryable: false }
    })
    const host = useHostConnection()
    await host.start()
    expect(host.view.value).toBeNull()
    expect(host.readOnly.value).toBe(false)
    expect(host.message.value.variant).toBe('none')
  })

  it('[ADR-002] a Host connection row that rejects leaves the Panel usable', async () => {
    install(null, {
      getHostConnection: vi.fn(() => Promise.reject(new Error('no handler')))
    })
    const host = useHostConnection()
    await host.start()
    expect(host.readOnly.value).toBe(false)
  })

  it('[ADR-002] a push that arrives before the first answer is not overwritten by it', async () => {
    let answerGet: (view: HostConnectionView) => void = () => undefined
    const { push } = install(null, {
      getHostConnection: vi.fn(
        () =>
          new Promise<HostConnectionView>((resolve) => {
            answerGet = resolve
          })
      )
    })
    const host = useHostConnection()
    const started = host.start()
    push(reconnecting)
    answerGet(connected)
    await started
    await settle()
    expect(host.view.value).toEqual(reconnecting)
    expect(host.readOnly.value).toBe(true)
  })

  it('[ADR-002] a push that is not a Host connection view is ignored', async () => {
    const { push } = install(connected)
    const host = useHostConnection()
    await host.start()
    push({ state: 'gone' })
    expect(host.view.value).toEqual(connected)
    expect(host.readOnly.value).toBe(false)
  })

  it('[ADR-002] reads the connection once however often it is started', async () => {
    const { api } = install(connected)
    const host = useHostConnection()
    await host.start()
    await useHostConnection().start()
    expect(api.getHostConnection).toHaveBeenCalledOnce()
    expect(api.onHostConnection).toHaveBeenCalledOnce()
  })

  it('[ADR-002] Stop everything from the incompatible message sends requestStopEverything once and never an upgrade request', async () => {
    const requestStopEverything = vi.fn()
    const confirmHostRestart = vi.fn(() => Promise.resolve(connected))
    const retryHostConnection = vi.fn(() => Promise.resolve(connected))
    const { push } = install(connected, {
      requestStopEverything,
      confirmHostRestart,
      retryHostConnection
    })
    const host = useHostConnection()
    await host.start()

    // Nothing to stop from while no message offers it.
    host.stopEverything()
    expect(requestStopEverything).not.toHaveBeenCalled()

    push({ state: 'unavailable', reason: 'incompatible' })
    expect(host.message.value.action).toBe('stop-everything')
    host.stopEverything()
    expect(requestStopEverything).toHaveBeenCalledOnce()
    expect(requestStopEverything).toHaveBeenCalledWith()
    expect(confirmHostRestart).not.toHaveBeenCalled()
    expect(retryHostConnection).not.toHaveBeenCalled()
  })
})
