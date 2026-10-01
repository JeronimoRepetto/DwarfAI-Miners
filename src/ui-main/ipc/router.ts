// The router of Electron main (ADR-001 item 3; 21 §1 items 1, 2, 2a; 05 §2.1 `ui-main/ipc/`). It registers the
// `ipcMain` listeners from the channel registry and dispatches each call by the route table: `legacy` → today's
// runtime through `LegacyRuntimeRoute` (the only door to legacy code, lint R16), or through the route's named shape
// adapter for a `legacy` + `target` route (21 §3.1); `ui-local` → the window module; `host` → the HostClient. A call
// whose (channel, qualifier) has no route is refused with a typed error, never guessed. Every call goes through the
// seam A gate first (`validate.ts`, ADR-019 items 7, 8): an unknown sender or an invalid payload never reaches a
// handler; it is answered with the row's typed refusal, and a one-way call is dropped and counted.
import {
  CHANNELS,
  PRELOAD_HELPERS,
  ROW_IDS,
  type ChannelKey,
  type IpcError
} from '@dwarfai/contracts'
import type { ChannelRoute, RouteQualifier } from './channelRoute'
import { resolveRoute } from './routeResolver'
import type { IpcSenderEvent, SenderPolicy } from './senderCheck'
import { createValidateCall, type GateErrorCode, type Refusal } from './validate'

/** The part of Electron's `ipcMain` the router uses: the event (for the sender check) and the one payload argument. */
export interface IpcMainRegistrar {
  handle(
    channel: string,
    listener: (event: IpcSenderEvent, payload: unknown) => Promise<unknown>
  ): void
  on(channel: string, listener: (event: IpcSenderEvent, payload: unknown) => void): void
}

/** An owner that serves a routed call: by today's wire name for a `today` route, by the registry key otherwise. */
export interface RouteTarget {
  serve(channel: string, payload: unknown): Promise<unknown>
}

export interface RouterDeps {
  routes: readonly ChannelRoute[]
  /** `LegacyRuntimeRoute` (21 §3). */
  legacy: RouteTarget
  /** The window module (ISSUE-046, ISSUE-047); needed once a route is `ui-local`. */
  uiLocal?: RouteTarget
  /** The HostClient (ISSUE-051); needed once a route is `host`. */
  host?: RouteTarget
  /** The 21 §3.1 shape adapters by name; each is needed once a route names it. */
  shapeAdapters?: Readonly<Record<string, RouteTarget>>
  /** Who may call: the app entry and the mode-window registry (ADR-019 item 8). */
  senders: SenderPolicy
}

/** The router's answer to a call with no route: a seam A call error (14 §1.5, §3.3). */
export interface RouteRefusal {
  ok: false
  error: IpcError
}

export interface Router {
  /** Registers one listener per `invoke` and `send` row of the registry; none for a push or a preload helper. */
  register(ipc: IpcMainRegistrar): void
  /** One renderer call: the gate first (sender, then payload), then the route. */
  dispatch(
    channel: ChannelKey,
    event: IpcSenderEvent,
    payload: unknown,
    qualifier?: RouteQualifier
  ): Promise<unknown>
  /** How many calls of `channel` the gate refused with `code` since the router started. */
  refusalCount(channel: ChannelKey, code: GateErrorCode): number
}

const KEYS = Object.keys(CHANNELS) as ChannelKey[]
const WIRE_NAMES = Object.keys(ROW_IDS)
const helpers: readonly string[] = PRELOAD_HELPERS

/** A row's today wire name: the ROW_IDS entry of the same row that is not a registry key (A-44), else the key. */
function todayWireOf(channel: ChannelKey): string {
  const today = WIRE_NAMES.find(
    (wire) => wire !== channel && ROW_IDS[wire] === ROW_IDS[channel] && !(wire in CHANNELS)
  )
  return today ?? channel
}

/** The wire name the renderer calls a row by in this release: today's while its routes keep `shape: 'today'`. */
function wireOf(routes: readonly ChannelRoute[], channel: ChannelKey): string {
  const own = routes.filter((r) => r.channel === channel)
  return own.length > 0 && own.every((r) => r.shape === 'today') ? todayWireOf(channel) : channel
}

function refusal(channel: ChannelKey): RouteRefusal {
  return {
    ok: false,
    error: { code: 'METHOD_NOT_FOUND', message: `no route for ${channel}`, retryable: false }
  }
}

export function createRouter(deps: RouterDeps): Router {
  const { routes, legacy, uiLocal, host, shapeAdapters = {}, senders } = deps
  const validateCall = createValidateCall(senders)
  const refusals = new Map<string, number>()
  const refusalKey = (channel: ChannelKey, code: GateErrorCode): string => `${channel} ${code}`

  /** The target that serves a route; a route whose target is not bound stops the router from starting. */
  function targetOf(route: ChannelRoute): RouteTarget {
    if (route.shapeAdapter !== undefined) {
      const adapter = shapeAdapters[route.shapeAdapter]
      if (adapter === undefined) throw new Error(`router: no shape adapter ${route.shapeAdapter}`)
      return adapter
    }
    const target = { legacy, 'ui-local': uiLocal, host }[route.owner]
    if (target === undefined)
      throw new Error(`router: no ${route.owner} target for ${route.channel}`)
    return target
  }
  const targets = new Map(routes.map((route) => [route, targetOf(route)]))

  /** Serves `channel` by `route` with `payload`; a call with no route (or no bound target) is refused. */
  function serve(channel: ChannelKey, route: ChannelRoute | undefined, payload: unknown) {
    const target = route && targets.get(route)
    if (route === undefined || target === undefined) return Promise.resolve(refusal(channel))
    return target.serve(route.shape === 'today' ? todayWireOf(channel) : channel, payload)
  }

  /** The answer to a refused call; nothing the renderer sent reaches a handler. */
  async function answer(refused: Refusal): Promise<unknown> {
    switch (refused.kind) {
      case 'error':
        return { ok: false, error: refused.error }
      case 'answer':
        return structuredClone(refused.value)
      case 'drop':
        return undefined
      case 'unchanged':
        // A read-only row, called by main itself with no payload.
        return serve(refused.reader, resolveRoute(routes, refused.reader), undefined)
    }
  }

  async function dispatch(
    channel: ChannelKey,
    event: IpcSenderEvent,
    payload: unknown,
    qualifier: RouteQualifier = {}
  ): Promise<unknown> {
    const route = resolveRoute(routes, channel, qualifier)
    const verdict = validateCall(channel, event, payload, route?.shape)
    if (!verdict.ok) {
      const key = refusalKey(channel, verdict.code)
      refusals.set(key, (refusals.get(key) ?? 0) + 1)
      return answer(verdict.refusal)
    }
    return serve(channel, route, verdict.payload)
  }

  return {
    dispatch,
    refusalCount: (channel, code) => refusals.get(refusalKey(channel, code)) ?? 0,
    register(ipc) {
      for (const channel of KEYS) {
        const { kind } = CHANNELS[channel]
        if (helpers.includes(channel) || kind === 'push') continue
        const wire = wireOf(routes, channel)
        if (kind === 'invoke') {
          ipc.handle(wire, (event, payload) => dispatch(channel, event, payload))
        } else ipc.on(wire, (event, payload) => void dispatch(channel, event, payload))
      }
    }
  }
}
