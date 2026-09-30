// Picks the one route of a (channel, qualifier) pair (ADR-001 item 3; 21 §1 item 2). Pure: used by the router and
// by the router contract test.
import type { ChannelKey } from '@dwarfai/contracts'
import { qualifierFields, type ChannelRoute, type RouteQualifier } from './channelRoute'

/**
 * The route that serves `channel` for a call carrying `qualifier`: among the channel's routes whose every qualifier
 * field equals the call's, the one setting the most fields, so a qualified route wins over the unqualified one and
 * an unknown qualifier falls back to the unqualified route. No candidate, or two equally specific candidates, is no
 * route: the router refuses the call, never guesses.
 */
export function resolveRoute(
  routes: readonly ChannelRoute[],
  channel: ChannelKey,
  qualifier: RouteQualifier = {}
): ChannelRoute | undefined {
  const call = new Map(qualifierFields(qualifier))
  let best: ChannelRoute | undefined
  let bestFields = -1
  let tied = false
  for (const route of routes) {
    if (route.channel !== channel) continue
    const fields = qualifierFields(route.qualifier)
    if (!fields.every(([name, value]) => call.get(name) === value)) continue
    if (fields.length > bestFields) {
      best = route
      bestFields = fields.length
      tied = false
    } else if (fields.length === bestFields) {
      tied = true
    }
  }
  return tied ? undefined : best
}
