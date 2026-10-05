// `LegacyAgentRegistryFeed` (21 §3, cuts 1–4; ADR-001 Consequences, IR-21-07; 21 §1 item 4): from cut 1 the Host
// observer is the only observer and writer, yet the rows still routed `legacy` (send, console, stop, asks) must find
// their dwarf in today's runtime. This bridge composes, of today's observer, only the legacy providers' session
// discovery (each provider's `scan()`, which lists the live sessions with their provider identity and, for Codex,
// reads the pending questions `LegacyAskRelay` answers) and writes what it finds only into the legacy runtime's
// in-memory agent registry. It composes no board publish, no ledger crediting, no projects-store write and no
// notifier: those parts of `LegacyRuntimeSurface` are never called, so nothing the Host writes is written twice and
// no session is counted twice (FM-094). It is not an observer in ADR-001's double-counting sense.
//
// Candidate decision (21 §6): the legacy discovery is KEPT, unchanged, in the legacy tree (`src/main/providers/**`,
// `Provider.scan()`), and only its composition is new: today's poller (`src/main/runtime/poller.ts`) is not a
// candidate, because its one callback runs the board publish, the crediting, the projects store and the notifier
// together with the registry write, so it cannot be composed registry-only.
//
// The per-provider switch shrinks the feed step by step (21 §3): a provider whose rows moved to the Host is `off`;
// Codex keeps `pending-questions` (its pending questions only) for `LegacyAskRelay` until the end of cut 4, when the
// bridge is deleted with `LegacyDwarfIdBridge` (21 §2 cut 4b).
import type { DwarfProvider, ProviderSnapshot } from '../main/domain/types'
import type { Provider } from '../main/providers/provider'

/**
 * What the feed composes of one legacy provider: its whole discovery, only the sessions blocked on a pending question
 * (Codex, for `LegacyAskRelay`, 21 §2 cut 4a), or nothing once its rows left the legacy runtime.
 */
export type LegacyFeedMode = 'discover' | 'pending-questions' | 'off'

/** The feed's per-provider switch: every legacy provider has a mode, so a new one cannot be left out by omission. */
export type LegacyFeedModes = Readonly<Record<DwarfProvider, LegacyFeedMode>>

/** Cut 1 (21 §2 cut 1): every legacy provider's rows are still `legacy`, so every discovery is composed. */
export const LEGACY_FEED_PROVIDERS_CUT_1: LegacyFeedModes = {
  claude: 'discover',
  codex: 'discover',
  antigravity: 'discover',
  opencode: 'discover'
}

/**
 * Today's runtime as the feed is handed it: its providers' discovery, its in-memory agent registry, and the parts of
 * today's observer the feed must never compose (they are on the surface so that the router test and this bridge's
 * own test can prove nothing reaches them). Bound inside `src/legacy-bridge/**` only (R16).
 */
export interface LegacyRuntimeSurface {
  /** Today's poll interval (`pollIntervalMs` of the legacy config): the registry is as fresh as today's board was. */
  pollIntervalMs: number
  /** Each legacy provider's session discovery: `scan()` lists its live sessions (Codex: with pending questions). */
  discovery: readonly Pick<Provider, 'kind' | 'scan'>[]
  /** The legacy runtime's in-memory agent registry, where the rows still `legacy` look their dwarf up. */
  registry: { replace(sessions: readonly ProviderSnapshot[]): void }
  /** Today's poller → `publishGate` → board path (switched off from cut 1). Never composed by the feed. */
  board: { publish(sessions: readonly ProviderSnapshot[]): void }
  /** Today's ledger crediting (`materialLedger`). Never composed by the feed. */
  ledger: { credit(sessions: readonly ProviderSnapshot[]): void }
  /** Today's projects-store write. Never composed by the feed. */
  projects: { record(sessions: readonly ProviderSnapshot[]): void }
  /** Today's notifier (`notifyDecision` → Electron `Notification`). Never composed by the feed. */
  notifier: { update(sessions: readonly ProviderSnapshot[]): void }
}

export interface LegacyFeedTimers {
  /** Runs `run` every `ms`; the answer cancels it. */
  every(ms: number, run: () => void): () => void
}

export interface LegacyAgentRegistryFeed {
  /** Discovers once at once, then every `pollIntervalMs`; a second start is a no-op. */
  start(): void
  /** One discovery cycle; a cycle already running is joined rather than overlapped. */
  refresh(): Promise<void>
  /** Settles once the cycle in flight, if any, has written the registry. */
  whenIdle(): Promise<void>
  /** Stops the cycles; the registry keeps what it last held. */
  stop(): void
}

/** What one provider's sessions put in the registry under `mode`. */
function composed(mode: LegacyFeedMode, sessions: readonly ProviderSnapshot[]): ProviderSnapshot[] {
  if (mode === 'off') return []
  if (mode === 'discover') return [...sessions]
  return sessions.filter((session) => session.dwarfs.some((d) => d.pendingQuestion !== undefined))
}

export function createLegacyAgentRegistryFeed(deps: {
  legacy: LegacyRuntimeSurface
  modes: LegacyFeedModes
  timers: LegacyFeedTimers
}): LegacyAgentRegistryFeed {
  const { legacy, modes, timers } = deps
  const composedDiscovery = legacy.discovery.filter((provider) => modes[provider.kind] !== 'off')
  // What each provider last listed: a provider whose scan fails keeps its sessions for that cycle, so a transient
  // read error never makes a live dwarf unreachable for the rows still `legacy` (today's poller: one provider failing
  // never kills the loop).
  const lastListed = new Map<DwarfProvider, ProviderSnapshot[]>()
  let inFlight: Promise<void> | null = null
  let cancel: (() => void) | null = null

  async function cycle(): Promise<void> {
    const results = await Promise.allSettled(composedDiscovery.map((provider) => provider.scan()))
    results.forEach((result, index) => {
      const provider = composedDiscovery[index]
      if (provider === undefined || result.status === 'rejected') return
      lastListed.set(provider.kind, composed(modes[provider.kind], result.value))
    })
    legacy.registry.replace(composedDiscovery.flatMap((p) => lastListed.get(p.kind) ?? []))
  }

  function refresh(): Promise<void> {
    inFlight ??= cycle().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  return {
    start() {
      if (cancel !== null) return
      void refresh()
      cancel = timers.every(legacy.pollIntervalMs, () => void refresh())
    },
    refresh,
    whenIdle: () => inFlight ?? Promise.resolve(),
    stop() {
      cancel?.()
      cancel = null
    }
  }
}
