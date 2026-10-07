// The router table's types (ADR-001 item 3, revised 2026-09-30 by 21 §12 AR-21-01) and its invariants (ADR-001
// item 3; 21 §1 items 1, 2, 2a; 14 §6.5 "Router").
import { STEP_ORDER, type ChannelKey, type ProviderId, type StepId } from '@dwarfai/contracts'

/** ADR-001 item 3 names the channel type `IpcChannelName`: a key of the channel registry. */
export type IpcChannelName = ChannelKey

// verbatim: ADR-001 item 3 — the code block with its list indentation removed; the added lines are the
// prettier-ignore directives that keep its aligned comments and one-line interface byte-identical.
export type ChannelOwner = 'legacy' | 'host' | 'ui-local'
// prettier-ignore
export interface ChannelRoute {
  channel: IpcChannelName          // key of IPC_CHANNELS (14-ipc-contract)
  owner: ChannelOwner
  since: string                    // release that moved it
  parity: 'n/a' | 'pending' | 'passed'  // host routes must be 'passed' before legacy code is deleted
  qualifier?: RouteQualifier       // a provider- or origin-qualified row; unique per (channel, qualifier) (21 §1 item 2)
  shape: 'today' | 'target'        // which shape the preload exposes in this release (21 §1 item 2a)
  shapeAdapter?: string            // the named 21 §3.1 shape adapter; required for every legacy + target route
}
// prettier-ignore
export interface RouteQualifier { provider?: ProviderId; origin?: 'legacy-launch' | 'legacy-ask-channel' }

/** A legacy-bridge adapter of 21 §3 or a shape adapter of 21 §3.1, with the release steps it lives in. */
export interface LegacyBridgeAdapter {
  name: string
  cuts: readonly StepId[]
  /** Named by 21 §3.1: a `legacy` + `target` route may name it as its `shapeAdapter`. */
  shapeAdapter: boolean
}

/** One release's routing data: the table, the unrouted NEW rows and the listed legacy-bridge adapters. */
export interface RouteTable {
  release: StepId
  routes: readonly ChannelRoute[]
  unrouted: Partial<Record<ChannelKey, StepId>>
  /** The RETIRE rows retired with no route, with the step that retired each (`RETIRED`, lead resolution H1). */
  retired?: Partial<Record<ChannelKey, StepId>>
  adapters: readonly LegacyBridgeAdapter[]
}

export type RouteTableProblemReason =
  | 'no-route'
  | 'two-routes'
  | 'two-shapes'
  | 'unknown-channel'
  | 'unrouted-not-later'
  | 'routed-and-unrouted'
  | 'retired-not-reached'
  | 'routed-and-retired'
  | 'target-without-shape-adapter'
  | 'host-with-today-shape'
  | 'host-pending-in-release'
  | 'adapter-not-listed'
  | 'adapter-after-cut-5'

export interface RouteTableProblem {
  reason: RouteTableProblemReason
  channel?: string
  adapter?: string
}

/** The qualifier fields a route sets; an absent or empty qualifier sets none (the unqualified route). */
export function qualifierFields(qualifier: RouteQualifier | undefined): [string, string][] {
  return Object.entries(qualifier ?? {}).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string'
  )
}

const stepIndex = (step: StepId): number => STEP_ORDER.indexOf(step)

/** The (channel, qualifier) pair of a route, as a comparable key; an empty qualifier is the unqualified pair. */
function pairKey(route: ChannelRoute): string {
  const fields = qualifierFields(route.qualifier)
    .map(([name, value]) => `${name}=${value}`)
    .sort()
  return `${route.channel}|${fields.join('&')}`
}

/** Every broken invariant of a release's table against the registry keys; empty when the table is valid. */
export function checkRouteTable(
  table: RouteTable,
  channels: readonly string[]
): RouteTableProblem[] {
  const { release, routes, unrouted, adapters } = table
  const retired: Partial<Record<string, StepId>> = table.retired ?? {}
  const problems: RouteTableProblem[] = []
  const known = new Set(channels)
  const unroutedSteps: Partial<Record<string, StepId>> = unrouted
  const listed = [
    ...routes.map((r) => r.channel),
    ...Object.keys(unrouted),
    ...Object.keys(retired)
  ]

  for (const channel of new Set(listed)) {
    if (!known.has(channel)) problems.push({ reason: 'unknown-channel', channel })
  }

  // One owner per (channel, qualifier) per release, or one unrouted entry naming a later step (22 §5), or one retired
  // entry naming this release or an earlier step (a RETIRE row with no route from that step, lead resolution H1).
  for (const channel of channels) {
    const own = routes.filter((r) => r.channel === channel)
    const retiredAt = retired[channel]
    if (retiredAt !== undefined) {
      if (own.length > 0 || unroutedSteps[channel] !== undefined) {
        problems.push({ reason: 'routed-and-retired', channel })
      } else if (stepIndex(retiredAt) > stepIndex(release)) {
        problems.push({ reason: 'retired-not-reached', channel })
      }
      continue
    }
    const step = unroutedSteps[channel]
    if (step !== undefined) {
      if (own.length > 0) problems.push({ reason: 'routed-and-unrouted', channel })
      else if (stepIndex(step) <= stepIndex(release)) {
        problems.push({ reason: 'unrouted-not-later', channel })
      }
      continue
    }
    if (own.length === 0) problems.push({ reason: 'no-route', channel })
    if (new Set(own.map(pairKey)).size < own.length)
      problems.push({ reason: 'two-routes', channel })
    // The preload exposes one shape per member in a release (21 §1 item 2a).
    if (new Set(own.map((r) => r.shape)).size > 1) problems.push({ reason: 'two-shapes', channel })
  }

  for (const route of routes) {
    const { channel } = route
    if (route.owner === 'legacy' && route.shape === 'target' && route.shapeAdapter === undefined) {
      problems.push({ reason: 'target-without-shape-adapter', channel })
    }
    if (route.shapeAdapter !== undefined) {
      const listed = adapters.some(
        (a) => a.name === route.shapeAdapter && a.shapeAdapter && a.cuts.includes(release)
      )
      if (!listed) problems.push({ reason: 'adapter-not-listed', adapter: route.shapeAdapter })
    }
    if (route.owner === 'host' && route.shape === 'today') {
      problems.push({ reason: 'host-with-today-shape', channel })
    }
    // Pre-cut 0 is no release (21 §2); every later step is one.
    if (route.owner === 'host' && route.parity === 'pending' && release !== 'pre-cut-0') {
      problems.push({ reason: 'host-pending-in-release', channel })
    }
  }

  // Every legacy-bridge adapter is deleted by cut 5 at the latest (21 §3; 14 §6.5).
  for (const adapter of adapters) {
    if (adapter.cuts.some((step) => stepIndex(step) > stepIndex('cut-5'))) {
      problems.push({ reason: 'adapter-after-cut-5', adapter: adapter.name })
    }
  }
  return problems
}
