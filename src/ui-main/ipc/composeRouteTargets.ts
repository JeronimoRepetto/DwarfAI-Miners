// One `ui-local` route target out of the parts several issues build (preference rows, A-N30 renderer diagnostics,
// and later the links and pickers, the Panel rows…): the router takes one target per owner (ADR-001 item 3), so the
// parts are joined here and each call is dispatched by its channel. Every channel has exactly one owner (21 §1
// item 1): a channel two parts declare stops the composition, and a channel no part declares is refused like a call
// with no route (14 §1.5), never guessed. The call's sender is passed through. Pure: no Electron, no I/O.
import type { ChannelKey, IpcError } from '@dwarfai/contracts'
import type { RouteRefusal, RouteTarget } from './router'

/** One part of the `ui-local` target: the registry rows it serves and the target that serves them. */
export interface RouteTargetPart {
  readonly channels: readonly ChannelKey[]
  readonly target: RouteTarget
}

function noRoute(channel: string): RouteRefusal {
  const error: IpcError = {
    code: 'METHOD_NOT_FOUND',
    message: `no route for ${channel}`,
    retryable: false
  }
  return { ok: false, error }
}

/** Throws when one channel is declared by two parts (a composition defect). */
export function composeRouteTargets(parts: readonly RouteTargetPart[]): RouteTarget {
  const owners = new Map<string, RouteTarget>()
  for (const { channels, target } of parts) {
    for (const channel of new Set(channels)) {
      if (owners.has(channel))
        throw new Error(`composeRouteTargets: two ui-local owners for ${channel}`)
      owners.set(channel, target)
    }
  }
  return {
    serve(channel, payload, sender) {
      const owner = owners.get(channel)
      return owner === undefined
        ? Promise.resolve(noRoute(channel))
        : owner.serve(channel, payload, sender)
    }
  }
}
