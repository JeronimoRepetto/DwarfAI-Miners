import type { Mine, TextDeliveryChannel } from '../domain/types'
import type { TextDeliveryEndpoint, TextDeliveryTarget } from './port'

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

/**
 * Bound on foreman hops. One hop is all a real crew needs (a worker's parent is
 * a session, never another worker); the bound exists so a malformed or circular
 * provider answer can never spin here.
 */
const MAX_FOREMAN_HOPS = 4

export type TextDeliveryLookup = (dwarfId: string) => TextDeliveryTarget | null

/**
 * Follow `dwarfId` to a writable endpoint, or null when no channel exists.
 * A worker contributes an `[for agent <name>] ` prefix so the foreman reading
 * the message knows who it was meant for.
 */
export function resolveTextDelivery(
  dwarfId: string,
  targetOf: TextDeliveryLookup
): ResolvedTextDelivery | null {
  const prefixes: string[] = []
  const visited = new Set<string>()
  let currentId = dwarfId

  for (let hop = 0; hop <= MAX_FOREMAN_HOPS; hop++) {
    if (visited.has(currentId)) return null
    visited.add(currentId)

    const target = targetOf(currentId)
    if (target === null) return null
    if (target.kind !== 'foreman-relay') {
      return {
        channel: prefixes.length === 0 ? target.kind : 'foreman-relay',
        endpoint: target,
        prefix: prefixes.join('')
      }
    }
    prefixes.push(`[for agent ${target.workerName}] `)
    currentId = target.foremanDwarfId
  }
  return null
}

/**
 * Copy `mines` with every dwarf's resolved channel stamped on it, so the
 * renderer can enable or disable the send action without a second IPC round
 * trip. A 'leaving' dwarf is skipped: its session has already finished, so its
 * pid is stale and its name no longer addressable.
 */
export function stampTextDelivery(mines: Mine[], targetOf: TextDeliveryLookup): Mine[] {
  return mines.map((mine) => ({
    ...mine,
    dwarfs: mine.dwarfs.map((dwarf) => {
      if (dwarf.status === 'leaving') return dwarf
      const resolved = resolveTextDelivery(dwarf.id, targetOf)
      return resolved === null ? dwarf : { ...dwarf, textDelivery: resolved.channel }
    })
  }))
}
