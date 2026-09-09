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
  /**
   * The relay this send may fall back to, when the console paste above it could
   * not be delivered at all (#319, reversing #308). Absent wherever there is no
   * second tier — which is every endpoint but a console reached off a session
   * that is also addressable by registry name.
   *
   * A session name rather than an endpoint, mirroring what #308's
   * `consoleFallbackPid` was: the fallback is not a channel the panel may
   * advertise — `channel` is what the bar reads, and it names the console. See
   * `sendRouteOf` for the rule, and `TextDeliveryOutcome.neverStarted` for the
   * single condition under which the runtime is allowed to use this (a paste
   * whose window would not come forward, so nothing was pasted).
   */
  relayFallbackSessionName?: string
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
 * The channel and endpoint one resolved chain answers a MESSAGE with, or null
 * when it has none — the mirror of `kickEndpointOf` below, and the third place
 * send and kick routing part company (#308).
 *
 * The rule it adds: a session that owns a console AND is addressable by
 * registry name is written to by PASTING at its console, on the platform that
 * has one (Windows), with the relay kept only as the tier a paste that could
 * not focus falls back to.
 *
 * #308 chose the opposite order — the relay primary — to escape the console
 * tier's letter-by-letter typing, which took ~16 s for a 441-char message and
 * wrote the remainder into whatever window a mid-typing focus change gave the
 * foreground. #319 reverses it because the defect was HOW the console wrote,
 * not that it wrote: a PASTE lands the whole message at once in under a second,
 * so the focus-steal window nearly disappears — and the message arrives as the
 * person's own prompt rather than labelled as another session, which a relayed
 * message cannot be. The relay stays the fallback for a paste that cannot
 * focus (and the only channel for a session with no console at all).
 *
 * Kick's order was never the question — it stays at the console (#24), which is
 * why this rule lives here and not in `deliveryTargetOf`: an interrupt IS a
 * keystroke, and Esc at the wrong window costs a cancelled turn, not a leaked
 * message.
 *
 * `channel` follows the endpoint so that the capability the bar reads is the
 * channel the send will actually use — 'terminal' for a direct send now that
 * the console is primary again. A worker's chain keeps 'foreman-relay', because
 * what the panel is describing there is still the hop and not the tier under it.
 */
function sendRouteOf(hops: ForemanHops): Omit<ResolvedTextDelivery, 'prefix'> | null {
  if (!canCarryText(hops.endpoint)) return null
  const endpoint = hops.endpoint
  if (endpoint.kind !== 'terminal' || endpoint.sessionName === undefined) {
    return { channel: hops.channel, endpoint }
  }
  // The name moves off the endpoint to the fallback slot, the mirror of what
  // #308 did with the pid: the endpoint is the plain console the paste writes
  // to, and the relay address it may fall back to is not a channel the bar
  // advertises. `hops.channel` is already 'terminal' for a direct send and
  // 'foreman-relay' for a worker's chain, and neither changes here.
  return {
    channel: hops.channel,
    endpoint: { kind: 'terminal', pid: endpoint.pid },
    relayFallbackSessionName: endpoint.sessionName
  }
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
  const route = sendRouteOf(hops)
  if (route === null) return null
  return {
    ...route,
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
 * Whether a kick would reach anything on a held session (#237, step 5).
 *
 * The second protocol-shaped refusal beside the queue's, and the same rule in
 * one place for the same reason: a held Antigravity session takes MESSAGES on
 * the stream this panel holds and its documented input side carries no cancel
 * event, so its kick has to be refused rather than reported. Read off the
 * endpoint, which carries the answer from the handle that actually knows it —
 * see TextDeliveryTarget's own `interruptible`.
 */
function canInterrupt(endpoint: TextDeliveryEndpoint): boolean {
  return endpoint.kind !== 'held-session' || endpoint.interruptible
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
 *
 * 'hosted-stdin' ends a whole process too (#194) and gets no matching guard,
 * because it cannot reach one: the hop rule above exists for a launched CLI
 * whose own transcript reports subagents, and nothing observes children for a
 * hosted process — no provider reads it, so no worker of its can be on the
 * board to relay through it. A guard here would be an unreachable branch
 * claiming a case exists.
 */
function kickEndpointOf(hops: ForemanHops): KickEndpoint | null {
  if (!canCarryKick(hops.endpoint)) return null
  if (!canInterrupt(hops.endpoint)) return null
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
 * kick, both read off the same routing functions resolveTextDelivery and
 * resolveKickDelivery enforce (#97, #217) rather than re-derived here — a
 * second copy of either rule is how the panel and the runtime would start
 * refusing different dwarfs, or start describing a send main will not make.
 *
 * Two channels are asymmetric: the Codex queue delivers and cannot interrupt,
 * and a process this panel launched can be ended and takes no messages. Both
 * are facts about a session TYPE. A named observed Claude session used to be a
 * third, one-session asymmetry (#308: relay for a message, console for a kick),
 * but #319 pastes the message at its console too, so both halves are 'terminal'
 * again and it is symmetric once more. `sendChannel` still comes off
 * sendRouteOf rather than the shared walk, because the two asymmetric types
 * above still make send and kick disagree. `textDelivery` mirrors sendText
 * only, because it is the field the composer reads — stamping a channel that
 * cannot carry text there would enable a box whose message main is bound to
 * refuse.
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
      const sendChannel = sendRouteOf(hops)?.channel ?? null
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
