// `LegacyDwarfIdBridge` (21 §3, cuts 1–4; 14 §5; AMENDMENT-8, OQ-69): from cut 1 the renderer knows only Host
// `DwarfId`s, while the rows still routed `legacy` that carry a dwarf id (A-13, A-23, A-26, A-27, A-P3, A-P4, and A-40 /
// A-41 under their qualifier) are served by today's runtime, which knows only its own ids. The bridge maps one to the
// other by an exact join on the provider identity `{ providerId, providerSessionId, providerAgentId? }` (ADR-015
// item 7; INV-21):
//
// - The Host side is B-M41 `strangler.dwarfIdentities` (14 §2.3, §3.4), read over the `ui` connection and never relayed
//   to a renderer (14 §1.10): re-read after every snapshot and every `dwarf.arrived` / `dwarf.departed` frame, and once
//   more before a row answers "not found" (a Host-driven re-bind has no frame, 14 §2.4).
// - The legacy side is what `LegacyAgentRegistryFeed` last wrote into today's in-memory agent registry: today's
//   `ProviderSnapshot`s. A legacy dwarf's identity is its provider, its `sessionId` (a Claude subagent carries its
//   session's), and, for a dwarf whose id is its provider's session id plus one more segment, that segment: today's
//   providers build a Claude subagent's id as `claude:<session>:<agentId>` (claudeProvider.ts). An id of any other form
//   has no agent part; a dwarf observed by the panel itself (`'panel'`) has no provider identity the Host could hold.
// - The join is exact on all three parts. No match, or more than one, is "not found": the row answers its own
//   not-found shape (./rowShapes/notFound.ts), never a nearest match.
//
// Read-only toward the Host: it subscribes and calls `strangler.dwarfIdentities`, nothing else; it has no Host command
// path. Composed only by `src/ui-main/index.ts` (R16), in the releases 21 §3 lists it for (cut 1 to the end of 4b);
// deleted at the end of cut 4 together with B-M41 and `LegacyEndFirstAdapter` (later: ISSUE-241).
//
// Candidate decision (21 §6): no candidate exists; new code.
import type { ProviderIdentity, StranglerDwarfIdentity } from '@dwarfai/contracts'
import type { ProviderSnapshot } from '../main/domain/types'
import type { HostClient, HostEvent } from '../ui-main/window/ports/hostClient'
import { NOT_FOUND } from './rowShapes/notFound'

export interface LegacyDwarfIdBridge {
  /** The legacy id of the one legacy dwarf with the Host dwarf's provider identity, or `null` (not found). */
  toLegacy(dwarfId: string): Promise<string | null>
  /** The Host id of the one Host dwarf with the legacy dwarf's provider identity, or `null` (not found). */
  toHost(legacyId: string): Promise<string | null>
  /** Unsubscribes; nothing is read after. */
  dispose(): void
}

export interface LegacyDwarfIdBridgeDeps {
  /** The two HostClient members the bridge uses: the subscription and the B-M41 read. */
  client: Pick<HostClient, 'call' | 'subscribe'>
  /** The legacy side: today's sessions as `LegacyAgentRegistryFeed` last wrote them. */
  legacy: { sessions(): readonly ProviderSnapshot[] }
}

/** The frames after which the Host's present dwarfs may have changed (14 §5). */
const REREAD_FRAMES: ReadonlySet<string> = new Set(['dwarf.arrived', 'dwarf.departed'])

interface LegacyIdentity {
  legacyId: string
  identity: ProviderIdentity
}

/** Exact equality on the three parts of a provider identity (an absent agent id equals only an absent one). */
function sameIdentity(a: ProviderIdentity, b: ProviderIdentity): boolean {
  return (
    a.providerId === b.providerId &&
    a.providerSessionId === b.providerSessionId &&
    a.providerAgentId === b.providerAgentId
  )
}

/** Today's dwarfs with the provider identity each one's own facts state; one whose id says nothing is left out. */
function legacyIdentities(sessions: readonly ProviderSnapshot[]): LegacyIdentity[] {
  const found: LegacyIdentity[] = []
  for (const session of sessions) {
    for (const dwarf of session.dwarfs) {
      if (dwarf.provider === 'panel') continue
      const sessionKey = `${dwarf.provider}:${dwarf.sessionId}`
      const base = { providerId: dwarf.provider, providerSessionId: dwarf.sessionId }
      if (dwarf.id === sessionKey) {
        found.push({ legacyId: dwarf.id, identity: base })
      } else if (dwarf.id.startsWith(`${sessionKey}:`)) {
        const agent = dwarf.id.slice(sessionKey.length + 1)
        if (agent.length > 0 && !agent.includes(':')) {
          found.push({ legacyId: dwarf.id, identity: { ...base, providerAgentId: agent } })
        }
      }
    }
  }
  return found
}

/** The one element `matches` keeps, or `null` when none or several do (never a guess). */
function only<T>(items: readonly T[], matches: (item: T) => boolean): T | null {
  const kept = items.filter(matches)
  return kept.length === 1 ? (kept[0] ?? null) : null
}

export function createLegacyDwarfIdBridge(deps: LegacyDwarfIdBridgeDeps): LegacyDwarfIdBridge {
  const { client, legacy } = deps
  let hostSide: readonly StranglerDwarfIdentity[] = []
  /** Each read is numbered; an answer older than the one already applied is dropped. */
  let started = 0
  let applied = 0
  let disposed = false

  async function reread(): Promise<void> {
    if (disposed) return
    started += 1
    const mine = started
    try {
      const present = await client.call('strangler.dwarfIdentities', {})
      if (!disposed && mine > applied) {
        applied = mine
        hostSide = present
      }
    } catch {
      // The Host is not reachable or does not serve B-M41: the side read last stays, and an unmatched row is not found.
    }
  }

  const unsubscribe = client.subscribe((event: HostEvent) => {
    if (event.kind === 'snapshot' || REREAD_FRAMES.has(event.frame.name)) void reread()
  })

  function legacyIdOf(dwarfId: string): string | null {
    const host = only(hostSide, (entry) => entry.dwarfId === dwarfId)
    if (host === null) return null
    return (
      only(legacyIdentities(legacy.sessions()), (entry) =>
        sameIdentity(entry.identity, host.identity)
      )?.legacyId ?? null
    )
  }

  function hostIdOf(legacyId: string): string | null {
    const mine = only(legacyIdentities(legacy.sessions()), (entry) => entry.legacyId === legacyId)
    if (mine === null) return null
    return only(hostSide, (entry) => sameIdentity(entry.identity, mine.identity))?.dwarfId ?? null
  }

  /** Answers from the side read last, else once more after one more read (14 §5). */
  async function withReread(find: () => string | null): Promise<string | null> {
    const first = find()
    if (first !== null || disposed) return first
    await reread()
    return find()
  }

  return {
    toLegacy: (dwarfId) => withReread(() => legacyIdOf(dwarfId)),
    toHost: (legacyId) => withReread(() => hostIdOf(legacyId)),
    dispose() {
      disposed = true
      unsubscribe()
    }
  }
}

/** A target that serves a `legacy` row by its today wire name: `LegacyRuntimeRoute`. */
export interface LegacyRowTarget {
  serve(channel: string, payload: unknown): Promise<unknown>
}

/** Today's pushes of the rows a mapping serves, mapped; `null` withholds the push. */
export interface LegacyPushMap {
  readonly pushChannels: readonly string[]
  push(channel: string, payload: unknown): Promise<unknown>
}

export interface LegacyDwarfIdRows extends LegacyRowTarget, LegacyPushMap {
  /** The today wires of the request rows the bridge maps (A-13, A-23, A-26, A-27). */
  readonly requestChannels: readonly string[]
}

type IdField = 'whole' | 'dwarfId'

/** The request rows the bridge serves (today wire → where today's payload carries the dwarf id). */
const REQUEST_ROWS: Readonly<Record<string, IdField>> = {
  'dwarf:activate': 'whole', // A-13
  'dwarf:sendText': 'dwarfId', // A-23
  'dwarf:kick': 'dwarfId', // A-26
  'dwarf:retire': 'whole' // A-27
}

/** The push rows the bridge serves: A-P4 carries a legacy dwarf id; A-P3 carries none and passes unchanged. */
const SETTLED_PUSH = 'dwarf:sendText:settled' // A-P4
const LAUNCH_FAILED_PUSH = 'agent:launchFailed' // A-P3

function idIn(field: IdField, payload: unknown): string | null {
  if (field === 'whole') return typeof payload === 'string' ? payload : null
  const id = (payload as { dwarfId?: unknown } | null)?.dwarfId
  return typeof id === 'string' ? id : null
}

function withId(field: IdField, payload: unknown, id: string): unknown {
  return field === 'whole' ? id : { ...(payload as object), dwarfId: id }
}

/**
 * The bridge composed on today's runtime: the request rows reach it with the legacy id of the Host dwarf they name, or
 * answer their own not-found shape without reaching it; A-P4 leaves with the Host id of the legacy dwarf it names, or
 * is withheld (a legacy id never reaches a renderer, 14 §1.10); every other row and push passes unchanged.
 */
export function createLegacyDwarfIdRows(deps: {
  bridge: LegacyDwarfIdBridge
  legacy: LegacyRowTarget
}): LegacyDwarfIdRows {
  const { bridge, legacy } = deps
  return {
    async serve(channel, payload) {
      const field = REQUEST_ROWS[channel]
      if (field === undefined) return legacy.serve(channel, payload)
      const hostId = idIn(field, payload)
      const legacyId = hostId === null ? null : await bridge.toLegacy(hostId)
      if (legacyId === null) return NOT_FOUND[channel as keyof typeof NOT_FOUND]
      return legacy.serve(channel, withId(field, payload, legacyId))
    },
    requestChannels: Object.keys(REQUEST_ROWS),
    pushChannels: [SETTLED_PUSH, LAUNCH_FAILED_PUSH],
    async push(channel, payload) {
      if (channel !== SETTLED_PUSH) return payload
      const legacyId = idIn('dwarfId', payload)
      const hostId = legacyId === null ? null : await bridge.toHost(legacyId)
      return hostId === null ? null : withId('dwarfId', payload, hostId)
    }
  }
}

/** Today's in-memory agent registry, as `LegacyAgentRegistryFeed` writes it. */
export interface LegacyRegistry {
  replace(sessions: readonly ProviderSnapshot[]): void
}

/**
 * The legacy side of the join: the registry the feed writes, passed through unchanged, remembering what the feed
 * wrote last. Nothing else writes through it.
 */
export function createLegacyRegistryTap(registry: LegacyRegistry): {
  registry: LegacyRegistry
  sessions(): readonly ProviderSnapshot[]
} {
  let last: readonly ProviderSnapshot[] = []
  return {
    registry: {
      replace(sessions) {
        last = sessions
        registry.replace(sessions)
      }
    },
    sessions: () => last
  }
}

/**
 * Where today's runtime sends its pushes: at once, except the pushes of a mapping installed, which leave once mapped,
 * in the order they were sent (a withheld one is skipped). Built before today's runtime composes, so its pushes always
 * pass through it; the mapping is installed once the bridge is composed.
 */
export interface LegacyPushTap {
  send(
    channel: string,
    payload: unknown,
    deliver: (channel: string, payload: unknown) => void
  ): void
  /** Installs `map`; the answer uninstalls it. */
  install(map: LegacyPushMap): () => void
}

export function createLegacyPushTap(): LegacyPushTap {
  let map: LegacyPushMap | null = null
  let queue: Promise<void> = Promise.resolve()
  return {
    send(channel, payload, deliver) {
      const mapping = map
      if (mapping === null || !mapping.pushChannels.includes(channel)) {
        deliver(channel, payload)
        return
      }
      const mapped = mapping.push(channel, payload).catch(() => null)
      queue = queue.then(async () => {
        const out = await mapped
        if (out !== null) deliver(channel, out)
      })
    },
    install(next) {
      map = next
      return () => {
        if (map === next) map = null
      }
    }
  }
}
