// The provider qualifiers of the rows cut 3 moves one provider at a time (21 §1 item 2; 21 §2 cut 3 "provider-qualified
// rows"; 14 §8 I-11): A-13 `dwarf:activate`, A-23 `dwarf:sendText`, A-35 `agent:launch` and A-N29 `dwarf:stop`.
//
// The table routes each of them `host` qualified to the providers the Host launches by that step and, for A-13, A-23
// and A-35, unqualified `legacy` through `PerProviderShapeAdapter` for every other provider (21 §3.1). These functions
// read one call's payload and answer its qualifier; the router picks the route (`resolveRoute`: a qualified route wins,
// an unknown provider falls back to the unqualified route). Nothing here names a provider (R12): the provider comes
// from the payload or from the Host board, the table decides where it goes.
//
// - A-13, A-23, A-N29 carry a `dwarfId`: the qualifier is the provider of that dwarf on the Host board UI main already
//   holds (the `dwarfs` section and its frames, read synchronously through `providerOf`). A dwarf the board does not
//   hold, or a payload with no dwarf id string, carries no qualifier, so the unqualified route answers it and the
//   router's seam A gate refuses a malformed payload there: never a guess.
// - A-35 carries `LaunchParams.way` (14 §3.4): a supplier launch is qualified by its `providerId`. A "Let Jev choose"
//   launch names no provider until the Host chose one, and its candidates are only providers the Host launches
//   (21 §2 "Let Jev choose (each step)"; the lead decided against widening them with an adapter, 21 §11 OI-21-4), so it
//   takes the qualifier of the table's `host` A-35 route: none where an unqualified `host` route exists (every provider
//   moved), the first provider-qualified `host` route's otherwise (3a: Claude), and none where no route is `host` (a
//   rollback build), which leaves it to the unqualified route.
//
// `composeProviderQualifiers` answers the qualifier of each of these rows that the table qualifies by provider, for
// the composition root (`src/ui-main/index.ts`, ISSUE-001) to hand the router; a table with no provider-qualified route
// for a row (cut 2, a rollback build) composes none for it.
//
// Candidate decision (21 §6): no candidate exists; new code (pure, no I/O).
import type { ChannelKey, ProviderId } from '@dwarfai/contracts'
import { qualifierFields, type ChannelRoute, type RouteQualifier } from './channelRoute'

/** The rows qualified by the provider of the call's dwarf: A-13, A-23, A-N29. */
export const DWARF_PROVIDER_ROWS = [
  'dwarf:activate',
  'dwarf:sendText',
  'dwarf:stop'
] as const satisfies readonly ChannelKey[]
/** A-35, qualified by its `LaunchParams.way`. */
export const LAUNCH_ROW = 'agent:launch' satisfies ChannelKey

/** A route qualifier read from a call's payload (`RouterDeps.qualifiers`). */
export type PayloadQualifier = (payload: unknown) => RouteQualifier

/** The Host board UI main holds, as the qualifiers read it. */
export interface DwarfProviderLookup {
  /** The provider of the dwarf `dwarfId` on the Host board now, or undefined when the board does not hold it. */
  providerOf(dwarfId: string): ProviderId | undefined
}

function fieldOf(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined
}

/** A-13, A-23, A-N29: `{ provider }` of the call's dwarf on the Host board, none for a dwarf it does not hold. */
export function createDwarfProviderQualifier(board: DwarfProviderLookup): PayloadQualifier {
  return (payload) => {
    const dwarfId = fieldOf(payload, 'dwarfId')
    if (typeof dwarfId !== 'string') return {}
    const provider = board.providerOf(dwarfId)
    return provider === undefined ? {} : { provider }
  }
}

/** The qualifier a "Let Jev choose" launch takes: the table's `host` A-35 route's (see the header). */
function jevQualifierOf(routes: readonly ChannelRoute[]): RouteQualifier {
  const hosted = routes.filter((route) => route.channel === LAUNCH_ROW && route.owner === 'host')
  if (hosted.some((route) => qualifierFields(route.qualifier).length === 0)) return {}
  const provider = hosted.find((route) => route.qualifier?.provider !== undefined)?.qualifier
    ?.provider
  return provider === undefined ? {} : { provider }
}

/** A-35: `{ provider }` of a supplier launch, the `host` route's qualifier for a "Let Jev choose" launch. */
export function createLaunchQualifier(routes: readonly ChannelRoute[]): PayloadQualifier {
  const jev = jevQualifierOf(routes)
  return (payload) => {
    const way = fieldOf(payload, 'way')
    const kind = fieldOf(way, 'kind')
    if (kind === 'jev') return { ...jev }
    const provider = fieldOf(way, 'providerId')
    return kind === 'supplier' && typeof provider === 'string' ? { provider } : {}
  }
}

/** Whether the table qualifies `channel` by provider in any route. */
function qualifiedByProvider(routes: readonly ChannelRoute[], channel: ChannelKey): boolean {
  return routes.some(
    (route) => route.channel === channel && route.qualifier?.provider !== undefined
  )
}

/** The qualifier of each provider-qualified row of the table (A-13, A-23, A-35, A-N29), for the router. */
export function composeProviderQualifiers(deps: {
  routes: readonly ChannelRoute[]
  board: DwarfProviderLookup
}): Partial<Record<ChannelKey, PayloadQualifier>> {
  const qualifiers: Partial<Record<ChannelKey, PayloadQualifier>> = {}
  const byDwarf = createDwarfProviderQualifier(deps.board)
  for (const channel of DWARF_PROVIDER_ROWS) {
    if (qualifiedByProvider(deps.routes, channel)) qualifiers[channel] = byDwarf
  }
  if (qualifiedByProvider(deps.routes, LAUNCH_ROW)) {
    qualifiers[LAUNCH_ROW] = createLaunchQualifier(deps.routes)
  }
  return qualifiers
}
