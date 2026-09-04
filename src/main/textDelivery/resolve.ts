import type { Mine, TextDeliveryChannel } from '../domain/types'
import type { KickEndpoint, SendEndpoint, TextDeliveryEndpoint, TextDeliveryTarget } from './port'

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
  /** Narrower than a kick's: a process this panel launched takes no messages (see SendEndpoint). */
  endpoint: SendEndpoint
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
 * Bound on foreman hops.
 *
 * This used to say one hop was all a real crew needed, because a worker's
 * parent was a session and never another worker. #157 is the day that stopped
 * being true: a worker2 is a subagent OF a subagent, so it relays to the worker
 * that launched it and that worker relays on to the session — the second hop
 * this bound was written to allow, finally used. The trees observed on this
 * machine reach depth 3, so a four-hop bound has room to spare, and a chain
 * deeper than it resolves to NO channel rather than a truncated one: refusing
 * the send is honest, and delivering it to the wrong ancestor is not.
 *
 * The bound itself is unchanged and its real job never was the depth: it is
 * what stops a malformed or circular provider answer spinning here.
 */
const MAX_FOREMAN_HOPS = 4

export type TextDeliveryLookup = (dwarfId: string) => TextDeliveryTarget | null

/** A target followed all the way to a writable endpoint, before either caller's prefix is applied. */
interface ForemanHops {
  channel: TextDeliveryChannel
  endpoint: TextDeliveryEndpoint
  /**
   * Worker names crossed while following foreman-relay hops, OUTERMOST FIRST —
   * nearest the writable endpoint, furthest from the dwarf being addressed.
   *
   * The walk below goes the other way, from the dwarf upwards, so it unshifts
   * rather than pushes. That order was unobservable until #157: nothing had
   * ever produced a chain longer than one hop, and one name reads the same in
   * either direction. It matters the moment there are two, because the prefix
   * is an instruction to the session at the top — "pass this to Explorer, who
   * should pass it to Scout" — and reversing it addresses an agent the session
   * has never heard of and asks it to forward to the one it launched.
   */
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
    // Unshift, not push: the walk climbs from the dwarf toward the endpoint and
    // the prefix is read from the endpoint down. See ForemanHops.workerNames.
    workerNames.unshift(target.workerName)
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
  if (hops === null || !canCarryText(hops.endpoint)) return null
  return {
    channel: hops.channel,
    endpoint: hops.endpoint,
    prefix: hops.workerNames.map((name) => `[for agent ${name}] `).join('')
  }
}

/**
 * Whether a resolved endpoint can carry a MESSAGE — the mirror of canCarryKick
 * below, and the second place send and kick routing part company (#217).
 *
 * See SendEndpoint in port.ts for why a launched process is excluded: it has
 * read its one prompt and exited, so there is nothing left to hand text to.
 * One rule in one place, for the reason canCarryKick is: the panel and the
 * runtime must refuse the same dwarf, or the composer accepts text main will
 * not take.
 */
function canCarryText(endpoint: TextDeliveryEndpoint): endpoint is SendEndpoint {
  return endpoint.kind !== 'launched-process'
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
 * The kick endpoint one resolved chain answers with, or null when it has none.
 *
 * Two refusals, and the second is about the hops rather than the endpoint:
 * ending a launched process ends the WHOLE session, so it may only ever answer
 * a kick aimed at that session itself. A worker's cancel that landed here
 * would kill its foreman's process — the user asked for one agent to stop, not
 * for everything running in that folder to be ended.
 *
 * Both callers read this one function, exactly as they read canCarryKick:
 * duplicating the rule is how the panel and the runtime start disagreeing
 * about the same dwarf (#97).
 */
function kickEndpointOf(hops: ForemanHops): KickEndpoint | null {
  if (!canCarryKick(hops.endpoint)) return null
  if (hops.endpoint.kind === 'launched-process' && hops.workerNames.length > 0) return null
  return hops.endpoint
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
  if (hops === null) return null
  const endpoint = kickEndpointOf(hops)
  if (endpoint === null) return null
  return {
    channel: hops.channel,
    endpoint,
    prefix: hops.workerNames.map((name) => `[cancel agent ${name}] `).join('')
  }
}

/**
 * Copy `mines` with every dwarf's resolved channel stamped on it, so the
 * renderer can enable or disable the send action without a second IPC round
 * trip. A 'leaving' dwarf is skipped: its session has already finished, so its
 * pid is stale and its name no longer addressable.
 *
 * The two halves of the matrix are resolved from ONE walk and can disagree,
 * which is the whole reason it is a matrix. `sendText` is null wherever the
 * endpoint cannot take text and `cancel` is null wherever it cannot take a
 * kick, both read off the same predicates resolveTextDelivery and
 * resolveKickDelivery enforce (#97, #217) rather than re-derived here — a
 * second copy of either rule is how the panel and the runtime would start
 * refusing different dwarfs.
 *
 * Two channels are asymmetric today, in opposite directions: the Codex queue
 * delivers and cannot interrupt, and a process this panel launched can be
 * ended and takes no messages. `textDelivery` mirrors sendText only, because
 * it is the field the composer reads — stamping a channel that cannot carry
 * text there would enable a box whose message main is bound to refuse.
 *
 * One walk per dwarf, which is why both halves come off `followForemanHops`
 * here rather than from two resolve calls: the poll asks each provider once
 * per dwarf, and it should stay once. adjustEffort is always null; no provider
 * exposes a channel for it yet.
 */
export function stampTextDelivery(mines: Mine[], targetOf: TextDeliveryLookup): Mine[] {
  return mines.map((mine) => ({
    ...mine,
    dwarfs: mine.dwarfs.map((dwarf) => {
      if (dwarf.status === 'leaving') return dwarf
      const hops = followForemanHops(dwarf.id, targetOf)
      if (hops === null) return dwarf
      const sendChannel = canCarryText(hops.endpoint) ? hops.channel : null
      const kickChannel = kickEndpointOf(hops) === null ? null : hops.channel
      return {
        ...dwarf,
        ...(sendChannel === null ? {} : { textDelivery: sendChannel }),
        capabilities: {
          sendText: sendChannel,
          cancel: kickChannel,
          adjustEffort: null
        }
      }
    })
  }))
}
