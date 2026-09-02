import type { Mine, TextDeliveryChannel } from '../domain/types'
import type { KickEndpoint, TextDeliveryEndpoint, TextDeliveryTarget } from './port'

/**
 * Turning a provider's raw target into something writable, and stamping the
 * result onto the dwarfs the panel renders.
 *
 * Providers answer per dwarf and never look at each other; only a worker's
 * 'foreman-relay' needs a second hop, and it is resolved here so both the UI
 * (which must not offer a send that cannot land) and the runtime (which has to
 * pick an endpoint) agree on exactly one answer.
 */

/** A target followed all the way to an endpoint that can be written to. */
export interface ResolvedTextDelivery {
  /** Tier reported to the panel and the logs. */
  channel: TextDeliveryChannel
  endpoint: TextDeliveryEndpoint
  /** Prepended to the user's text, e.g. '[for agent Explorer] '. Empty for a direct send. */
  prefix: string
}

/** Same shape as ResolvedTextDelivery; kept as its own type since Kick's prefix means something different. */
export interface ResolvedKickDelivery {
  /** Tier reported to the panel and the logs. */
  channel: TextDeliveryChannel
  /** Narrower than a send's: the Codex queue cannot interrupt a turn (see KickEndpoint). */
  endpoint: KickEndpoint
  /** Prepended tag naming the worker being cancelled, e.g. '[cancel agent Explorer] '. Empty for a direct kick. */
  prefix: string
}

/**
 * Bound on foreman hops. One hop is all a real crew needs (a worker's parent is
 * a session, never another worker); the bound exists so a malformed or circular
 * provider answer can never spin here.
 */
const MAX_FOREMAN_HOPS = 4

export type TextDeliveryLookup = (dwarfId: string) => TextDeliveryTarget | null

/** A target followed all the way to a writable endpoint, before either caller's prefix is applied. */
interface ForemanHops {
  channel: TextDeliveryChannel
  endpoint: TextDeliveryEndpoint
  /** Worker names crossed while following foreman-relay hops, outermost first. */
  workerNames: string[]
}

/**
 * Follow `dwarfId` through any foreman-relay hops to a writable endpoint, or
 * null when no channel exists at all. Shared by resolveTextDelivery and
 * resolveKickDelivery, which only differ in how they phrase the worker names
 * this collects into a prefix.
 */
function followForemanHops(dwarfId: string, targetOf: TextDeliveryLookup): ForemanHops | null {
  const workerNames: string[] = []
  const visited = new Set<string>()
  let currentId = dwarfId

  for (let hop = 0; hop <= MAX_FOREMAN_HOPS; hop++) {
    if (visited.has(currentId)) return null
    visited.add(currentId)

    const target = targetOf(currentId)
    if (target === null) return null
    if (target.kind !== 'foreman-relay') {
      return {
        channel: workerNames.length === 0 ? target.kind : 'foreman-relay',
        endpoint: target,
        workerNames
      }
    }
    workerNames.push(target.workerName)
    currentId = target.foremanDwarfId
  }
  return null
}

/**
 * Follow `dwarfId` to a writable endpoint, or null when no channel exists.
 * A worker contributes an `[for agent <name>] ` prefix so the foreman reading
 * the message knows who it was meant for.
 */
export function resolveTextDelivery(
  dwarfId: string,
  targetOf: TextDeliveryLookup
): ResolvedTextDelivery | null {
  const hops = followForemanHops(dwarfId, targetOf)
  if (hops === null) return null
  return {
    channel: hops.channel,
    endpoint: hops.endpoint,
    prefix: hops.workerNames.map((name) => `[for agent ${name}] `).join('')
  }
}

/**
 * Whether a resolved endpoint can carry a KICK — the ONE rule by which kick
 * routing differs from send routing, so it lives in one place and both
 * resolveKickDelivery and stampTextDelivery read it (#97). Duplicating it is
 * how the panel and the runtime would start disagreeing about the same dwarf.
 *
 * See KickEndpoint in port.ts for why the queue is excluded.
 */
function canCarryKick(endpoint: TextDeliveryEndpoint): endpoint is KickEndpoint {
  return endpoint.kind !== 'codex-queue'
}

/**
 * Same routing as resolveTextDelivery, for Kick: a worker contributes a
 * `[cancel agent <name>] ` tag instead, so the foreman relaying the instruction
 * knows which of its agents to stop.
 *
 * Null also when the endpoint a send would use cannot interrupt anything — a
 * Codex queue. The kick is refused rather than downgraded, because there is no
 * weaker honest thing for it to do.
 */
export function resolveKickDelivery(
  dwarfId: string,
  targetOf: TextDeliveryLookup
): ResolvedKickDelivery | null {
  const hops = followForemanHops(dwarfId, targetOf)
  if (hops === null || !canCarryKick(hops.endpoint)) return null
  return {
    channel: hops.channel,
    endpoint: hops.endpoint,
    prefix: hops.workerNames.map((name) => `[cancel agent ${name}] `).join('')
  }
}

/**
 * Copy `mines` with every dwarf's resolved channel stamped on it, so the
 * renderer can enable or disable the send action without a second IPC round
 * trip. A 'leaving' dwarf is skipped: its session has already finished, so its
 * pid is stale and its name no longer addressable.
 *
 * capabilities.cancel mirrors the same resolved channel wherever a kick can
 * ride it: Kick reuses whatever routing sendText would use (see
 * resolveKickDelivery), just with a raw keystroke or a fixed instruction
 * instead of the user's text. The exception is a channel that cannot interrupt
 * a turn at all — the Codex queue — which stamps a null cancel beside a working
 * sendText, through the same canCarryKick rule resolveKickDelivery enforces
 * (#97). Read off the endpoint already resolved rather than by resolving a
 * second time: the poll asks each provider once per dwarf, and it should stay
 * once. adjustEffort is always null — no provider exposes a channel for it yet.
 */
export function stampTextDelivery(mines: Mine[], targetOf: TextDeliveryLookup): Mine[] {
  return mines.map((mine) => ({
    ...mine,
    dwarfs: mine.dwarfs.map((dwarf) => {
      if (dwarf.status === 'leaving') return dwarf
      const resolved = resolveTextDelivery(dwarf.id, targetOf)
      return resolved === null
        ? dwarf
        : {
            ...dwarf,
            textDelivery: resolved.channel,
            capabilities: {
              sendText: resolved.channel,
              cancel: canCarryKick(resolved.endpoint) ? resolved.channel : null,
              adjustEffort: null
            }
          }
    })
  }))
}
