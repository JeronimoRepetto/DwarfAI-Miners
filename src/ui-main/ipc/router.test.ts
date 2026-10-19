// layer: L2
import { describe, expect, it } from 'vitest'
import { CHANNELS, PRELOAD_HELPERS, type ChannelKey } from '@dwarfai/contracts'
import type { ChannelRoute } from './channelRoute'
import { createRouter, type IpcMainRegistrar, type RouteTarget } from './router'
// AMENDED for ISSUE-056 (was: `ROUTES`, which was this table until the cut-0 switch): the suite is written against
// today's table, every row `legacy` with today's shape, kept as `PRE_CUT_0_ROUTES`.
import { PRE_CUT_0_ROUTES } from './testing/preCutRoutes'
import type { IpcSenderEvent, SenderPolicy } from './senderCheck'

/**
 * The router (ADR-001 item 3; 21 §1 item 1): it registers the `ipcMain` listeners from the channel registry and
 * dispatches each call by the table; a call whose (channel, qualifier) has no route is refused, never guessed.
 */
describe('router (ADR-001 item 3)', () => {
  /** Records every listener the router registers, by wire name. */
  class RecordingIpcMain implements IpcMainRegistrar {
    readonly handled = new Map<
      string,
      (event: IpcSenderEvent, payload: unknown) => Promise<unknown>
    >()
    readonly listened = new Map<string, (event: IpcSenderEvent, payload: unknown) => void>()
    handle(
      channel: string,
      listener: (event: IpcSenderEvent, payload: unknown) => Promise<unknown>
    ): void {
      if (this.handled.has(channel)) throw new Error(`second handler for ${channel}`)
      this.handled.set(channel, listener)
    }
    on(channel: string, listener: (event: IpcSenderEvent, payload: unknown) => void): void {
      if (this.listened.has(channel)) throw new Error(`second listener for ${channel}`)
      this.listened.set(channel, listener)
    }
  }

  /** A stand-in for a route owner that records what it served. */
  function recordingTarget(answer: unknown = 'served') {
    const served: [string, unknown][] = []
    const target: RouteTarget = {
      async serve(channel, payload) {
        served.push([channel, payload])
        return answer
      }
    }
    return { target, served }
  }

  const keys = Object.keys(CHANNELS) as ChannelKey[]
  // The Panel window showing the app entry: a sender the seam A gate accepts (ADR-019 item 8, ISSUE-044).
  const APP_ENTRY = 'file:///opt/DwarfAI/out/renderer/index.html'
  const senders: SenderPolicy = { appEntry: APP_ENTRY, isModeWindow: (id) => id === 1 }
  const panel: IpcSenderEvent = { sender: { id: 1 }, senderFrame: { url: APP_ENTRY } }
  const without = (channel: ChannelKey): ChannelRoute[] =>
    PRE_CUT_0_ROUTES.filter((r) => r.channel !== channel)

  it('[ADR-001] a call with no route for its channel is refused with a typed error and never reaches a handler', async () => {
    const legacy = recordingTarget()
    const router = createRouter({
      routes: without('dwarf:kick'),
      legacy: legacy.target,
      senders
    })
    const ipc = new RecordingIpcMain()
    router.register(ipc)

    const refusal = {
      ok: false,
      error: { code: 'METHOD_NOT_FOUND', message: 'no route for dwarf:kick', retryable: false }
    }
    expect(await router.dispatch('dwarf:kick', panel, { dwarfId: 'd-1' })).toEqual(refusal)
    // TC-043-04, TC-043-05: the renderer's call reaches the registered listener and gets the same refusal (a NEW row
    // listed in unrouted.ts has no route, so it is refused exactly like this).
    expect(await ipc.handled.get('dwarf:kick')?.(panel, { dwarfId: 'd-1' })).toEqual(refusal)
    // A qualified call with no route for its qualifier and no unqualified route is refused too.
    const qualifiedOnly = createRouter({
      routes: [
        ...without('agent:launch'),
        {
          channel: 'agent:launch',
          owner: 'legacy',
          since: 'pre-cut-0',
          parity: 'n/a',
          shape: 'today',
          qualifier: { origin: 'legacy-launch' }
        }
      ],
      legacy: legacy.target,
      senders
    })
    expect(
      await qualifiedOnly.dispatch('agent:launch', panel, {}, { origin: 'legacy-ask-channel' })
    ).toEqual({
      ok: false,
      error: { code: 'METHOD_NOT_FOUND', message: 'no route for agent:launch', retryable: false }
    })
    expect(legacy.served).toEqual([])
  })

  it('[ADR-001] the router registers one ipcMain listener per invoke and send row under today’s wire name and none for a push or the A-X1 preload helper', () => {
    const ipc = new RecordingIpcMain()
    createRouter({ routes: PRE_CUT_0_ROUTES, legacy: recordingTarget().target, senders }).register(
      ipc
    )

    const helpers: readonly string[] = PRELOAD_HELPERS
    const wire = (key: ChannelKey): string =>
      key === 'presence:visibleMines' ? 'panel:openMine' : key // A-44's today wire (ROW_IDS)
    const ofKind = (kind: 'invoke' | 'send'): string[] =>
      keys
        .filter((k) => CHANNELS[k].kind === kind && !helpers.includes(k))
        .map(wire)
        .sort()

    expect([...ipc.handled.keys()].sort()).toEqual(ofKind('invoke'))
    expect([...ipc.listened.keys()].sort()).toEqual(ofKind('send'))
    expect(ipc.handled.has('pathForDroppedFile')).toBe(false)
    for (const push of keys.filter((k) => CHANNELS[k].kind === 'push')) {
      expect(ipc.handled.has(push) || ipc.listened.has(push), push).toBe(false)
    }
  })

  it('[ADR-001] a legacy row is served by LegacyRuntimeRoute under today’s wire name with the renderer payload unchanged', async () => {
    const legacy = recordingTarget({ opened: true })
    const ipc = new RecordingIpcMain()
    createRouter({ routes: PRE_CUT_0_ROUTES, legacy: legacy.target, senders }).register(ipc)
    // A-21's today request is the link itself (a string, 14 §2.1); the gate lets a valid one through untouched.
    const link = 'https://example.org'

    expect(await ipc.handled.get('shell:openExternalLink')?.(panel, link)).toEqual({ opened: true })
    ipc.listened.get('panel:openMine')?.(panel, 'mine-1')
    await Promise.resolve()

    expect(legacy.served).toEqual([
      ['shell:openExternalLink', link],
      ['panel:openMine', 'mine-1']
    ])
  })

  it('[ADR-001] a router whose table names an owner or a shape adapter with no bound target does not start', () => {
    const legacy = recordingTarget().target
    const host: ChannelRoute = {
      channel: 'mines:get',
      owner: 'host',
      since: 'cut-1',
      parity: 'passed',
      shape: 'target'
    }
    expect(() =>
      createRouter({ routes: [...without('mines:get'), host], legacy, senders })
    ).toThrow('no host target')
    expect(() =>
      createRouter({
        routes: [...without('mines:get'), { ...host, owner: 'ui-local' }],
        legacy,
        senders
      })
    ).toThrow('no ui-local target')
    const adapted: ChannelRoute = {
      ...host,
      owner: 'legacy',
      shapeAdapter: 'BoardFacadeShape'
    }
    expect(() =>
      createRouter({ routes: [...without('mines:get'), adapted], legacy, senders })
    ).toThrow('no shape adapter BoardFacadeShape')
    expect(() =>
      createRouter({
        routes: [...without('mines:get'), adapted],
        legacy,
        shapeAdapters: { BoardFacadeShape: recordingTarget().target },
        senders
      })
    ).not.toThrow()
  })

  it('[ADR-001] the target of a routed call is told which window sent it', async () => {
    const seen: [string, unknown, IpcSenderEvent | undefined][] = []
    const uiLocal: RouteTarget = {
      async serve(channel, payload, sender) {
        seen.push([channel, payload, sender])
        return undefined
      }
    }
    const route: ChannelRoute = {
      channel: 'panel:hide',
      owner: 'ui-local',
      since: 'cut-0',
      parity: 'n/a',
      shape: 'target'
    }
    const router = createRouter({
      routes: [...without('panel:hide'), route],
      legacy: recordingTarget().target,
      uiLocal,
      senders
    })
    await router.dispatch('panel:hide', panel, undefined)
    expect(seen).toEqual([['panel:hide', undefined, panel]])
  })
})
