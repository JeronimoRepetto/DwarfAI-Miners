// The production `LegacyRuntimeSurface` (21 §3 `LegacyRuntimeRoute` and `LegacyAgentRegistryFeed`, cuts 1–4; ISSUE-123
// stage (a), lead resolution H2): today's runtime as `LegacyAgentRegistryFeed` is handed it, so the rows still `legacy`
// from cut 1 (send, console, stop, asks; 21 §2 cut 1 "Legacy still serves") find their dwarf, and `LegacyAskRelay`
// shows today's open asks exactly as today's board showed them.
//
// What the feed's discovery lists is today's BOARD as one tick of today's poll leaves it (`AgentRuntime.refresh`, then
// `AgentRuntime.getMines`), regrouped into one snapshot per provider session. That board carries today's per-poll
// stamps, applied by today's runtime itself with its own registries (runtime.ts, the poll callback): `stampHeldQuestions`
// (a held session's live question and permission supersede, and clear, what its transcript tail shows) and
// `stampPermissionPrompts` (an observed session Claude Code's hook says has a dialog open waits for `approval`), and its
// providers read a permission off a tail only when the hook confirmed it. So a held ask shows as a card, a hook-confirmed
// prompt shows with today's reason, and a permission candidate the stamps cleared does not. The stamps are not
// re-implemented here: their lookups are the runtime's own held and hook registries, and a second copy would be a second
// reading of one fact.
//
// The registry the rows still `legacy` look their dwarf up in is that same board: today's answer handlers read it
// (`answerDwarfQuestion`, `answerDwarfPermission`: `this.mines`), and so do send, console and stop. The tick the feed
// runs is what writes it, so `registry.replace` has nothing left to write: the sessions it is handed were read off the
// board the tick just wrote. That holds whether or not today's own poll timer runs (`runtime.start()`): from the cut-1
// switch (stage b) the feed's cycles are the ticks that keep the board, and so the handlers, current.
//
// A tick runs today's whole poll callback, so what it publishes, credits, records and notifies is whatever today's
// runtime composition gives it. In the cut-0 table nothing is composed over this surface (`LEGACY_BRIDGE_ADAPTERS`), so
// nothing changes; the cut-1 switch (stage b) gates those sinks in `LegacyRuntimeRoute.ts` on the route table in the
// same change that routes the cut-1 rows, so no cut-1 build ticks them.
//
// One tick serves every provider of one feed cycle (the feed scans its providers together); a tick that fails rejects
// every provider's scan of that cycle, and the feed keeps what each listed last.
//
// The parts of today's observer the feed must never compose (the board publish, the crediting, the projects store, the
// notifier) are not reachable through this surface: they are composed, or switched off, by today's runtime composition
// (`LegacyRuntimeRoute.ts`; the cut-1 switch, stage b), never through the feed, so calling one here throws.
//
// Candidate decision (21 §6): today's poll pipeline (`src/main/runtime/runtime.ts`, `poller.ts`) is KEPT unchanged as
// the source; this binding is new code. Composed only by `src/ui-main/index.ts` through `LegacyRuntimeRoute` (R16);
// deleted with `LegacyAgentRegistryFeed` at the end of cut 4 (21 §2 cut 4b).
import type { AgentRuntime } from '../main/runtime/runtime'
import type { Dwarf, DwarfProvider, Mine, ProviderSnapshot } from '../main/domain/types'
import { DWARF_PROVIDERS, isDwarfProvider } from '../shared/contracts'
import type { LegacyRuntimeSurface } from './LegacyAgentRegistryFeed'

/** Today's board as one tick of today's poll leaves it. */
export interface LegacyBoardSource {
  /** Today's poll interval (`pollIntervalMs` of the legacy config). */
  readonly pollIntervalMs: number
  /** One tick of today's poll: scan, aggregate, stamp, publish as today's composition composes it. */
  refresh(): Promise<void>
  /** Today's board as the last tick left it: what today's legacy handlers read. */
  current(): readonly Mine[]
}

/** Whether a dwarf reads as working: the board's own reading of its session. */
const working = (dwarf: Dwarf): boolean => dwarf.status === 'working'

/**
 * Today's board regrouped into one snapshot per provider session and mine, dwarfs in board order. A dwarf this panel
 * hosts (`'panel'`) belongs to no provider's session and is left out. A session reads `busy` while one of its dwarfs is
 * working, else `waiting` (today's provider reading: `busy` is the only state that proves work).
 */
export function boardSessions(board: readonly Mine[]): ProviderSnapshot[] {
  const sessions: ProviderSnapshot[] = []
  for (const mine of board) {
    const inMine = new Map<string, ProviderSnapshot>()
    for (const dwarf of mine.dwarfs) {
      const provider = dwarf.provider
      if (!isDwarfProvider(provider)) continue
      const key = `${provider}:${dwarf.sessionId}`
      const session = inMine.get(key)
      if (session === undefined) {
        const created: ProviderSnapshot = {
          provider,
          sessionId: dwarf.sessionId,
          cwd: mine.path,
          status: working(dwarf) ? 'busy' : 'waiting',
          dwarfs: [dwarf],
          updatedAt: mine.updatedAt
        }
        inMine.set(key, created)
        sessions.push(created)
      } else {
        session.dwarfs.push(dwarf)
        if (working(dwarf)) session.status = 'busy'
      }
    }
  }
  return sessions
}

/**
 * Today's composed runtime as a board source: `runtime` answers today's runtime, or `null` before it is composed and
 * after the quit teardown released it (then a tick does nothing and the board is empty).
 */
export function legacyBoardOf(
  runtime: () => Pick<AgentRuntime, 'refresh' | 'getMines'> | null,
  pollIntervalMs: number
): LegacyBoardSource {
  return {
    pollIntervalMs,
    refresh: async () => {
      await runtime()?.refresh()
    },
    current: () => runtime()?.getMines() ?? []
  }
}

/** A part of today's observer the feed never composes (21 §1 item 4): reaching it is a composition defect. */
function neverComposed(part: string): () => never {
  return () => {
    throw new Error(
      `LegacyRuntimeSurface: today's ${part} is never composed through the feed (21 §1 item 4)`
    )
  }
}

export function createLegacyRuntimeSurface(board: LegacyBoardSource): LegacyRuntimeSurface {
  /** The tick of the feed cycle in flight, shared by its providers' scans. */
  let reading: Promise<ProviderSnapshot[]> | null = null
  const read = (): Promise<ProviderSnapshot[]> =>
    (reading ??= board
      .refresh()
      .then(() => boardSessions(board.current()))
      .finally(() => {
        reading = null
      }))
  const discover = (kind: DwarfProvider) => ({
    kind,
    scan: async () => (await read()).filter((session) => session.provider === kind)
  })
  return {
    get pollIntervalMs() {
      return board.pollIntervalMs
    },
    discovery: DWARF_PROVIDERS.map(discover),
    // The tick that listed the sessions already wrote the board today's rows read (see the header).
    registry: { replace() {} },
    board: { publish: neverComposed('board publish') },
    ledger: { credit: neverComposed('ledger crediting') },
    projects: { record: neverComposed('projects-store write') },
    notifier: { update: neverComposed('notifier') }
  }
}
