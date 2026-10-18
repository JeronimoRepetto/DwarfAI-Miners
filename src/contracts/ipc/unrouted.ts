// Registry-declared but unrouted rows (22 §5 `src/contracts/ipc/**` row; ISSUE-043). A NEW row whose handler lands
// before the step that routes it is declared in CHANNELS by its handler issue and listed here, in the same PR, with
// the step that will route it; the router test accepts it only while that step is later than the release of
// `src/ui-main/ipc/routes.ts`, the router refuses a call to it like a channel with no route, and the step's switch
// issue removes the entry when it adds the route. A pure data list: it imports types only (05 R9).
import type { CHANNELS } from './channels'

/** A key of the channel registry (ADR-001 item 3 `IpcChannelName`). */
export type ChannelKey = keyof typeof CHANNELS

/**
 * The release steps of 21 §2, in order. `'generation-2'` is the first release that bumps `endpointGeneration`
 * (after v1): the step that routes A-N33 `confirmHostRestart` (AMENDMENT-11; 21 §2 "Different-generation restart").
 */
export type StepId =
  | 'pre-cut-0'
  | 'cut-0'
  | 'cut-1'
  | 'cut-2'
  | 'cut-3a'
  | 'cut-3b'
  | 'cut-3d'
  | 'cut-3e'
  | 'cut-4a'
  | 'cut-4b'
  | 'cut-5'
  | 'v1'
  | 'generation-2'

/** "Later than" between two steps is their order here. */
export const STEP_ORDER: readonly StepId[] = [
  'pre-cut-0',
  'cut-0',
  'cut-1',
  'cut-2',
  'cut-3a',
  'cut-3b',
  'cut-3d',
  'cut-3e',
  'cut-4a',
  'cut-4b',
  'cut-5',
  'v1',
  'generation-2'
]

/** Each registry-declared but unrouted NEW row, with the step that will route it. */
export const UNROUTED: Partial<Record<ChannelKey, StepId>> = {
  // The cut-0 entries (A-N03…A-N05, A-N25…A-N27, A-N30, A-N34) were routed by the cut-0 switch (ISSUE-056), the
  // cut-1 entries (A-N01, A-N02, A-N12, A-N16…A-N21) by the cut-1 switch (ISSUE-123), and the cut-2 entries (A-N07,
  // A-N31, A-N32) by the cut-2 switch (ISSUE-141), and the 3a entries (A-N06, A-N10, A-N11, A-N29) by the step-3a
  // switch (ISSUE-001). A-N08 and A-N09 are routed `host` in cut 2 by the ISSUE-172 lead decision (2026-10-17), never
  // listed here.
  // A-N33, born with the first release that bumps `endpointGeneration` (AMENDMENT-11; 21 "Different-generation
  // restart"); no handler in v1 (review R8B-06)
  'host:connection:confirm-restart': 'generation-2'
}

/**
 * Each RETIRE row a step retired with no successor route (21 §2 "Retired rows"), with that step. Its registry row
 * stays (the preload member and the schemas outlive the route until the step's deletion issue), but from that step on
 * it has no route and no handler: the router refuses a call to it like a channel with no route. The router test
 * accepts an entry only while its step is not later than the release, and a rollback build of that step routes the row
 * `legacy` again with today's shape (`rollbackTable.ts`). Lead resolution H1 (ISSUE-123): `ChannelRoute` is ADR-001
 * item 3's, not frozen, and the table check demands a route or an entry for every registry key.
 */
export const RETIRED: Partial<Record<ChannelKey, StepId>> = {
  // A-14, A-16, A-17 (no handler from cut 1), A-18 (RETIRE, no story) and A-P5 (successor A-N16): 21 §2 cut 1
  'dwarf:feed': 'cut-1',
  'panel:watchDwarfFeed': 'cut-1',
  'dwarf:refreshTelemetry': 'cut-1',
  'dwarf:setTuning': 'cut-1',
  'panel:mine:show': 'cut-1',
  // A-26 (kick: the action is removed, "Stop dwarf…" A-N29 is the only stop), A-37 and A-38 (merged into A-35/A-36):
  // 21 §2 cut 3a
  'dwarf:kick': 'cut-3a',
  'agent:models': 'cut-3a',
  'agent:launchHeld': 'cut-3a',
  // A-27 (successor `dwarf.departed` B-F10), A-P3 (`launch.failed` B-F19) and A-P4 (`message.delivery` B-F12): from 3a
  // `legacy` qualified to the providers not yet moved, none left once OpenCode moves (21 §2 cut 3 common rules, cut 4b)
  'dwarf:retire': 'cut-4b',
  'agent:launchFailed': 'cut-4b',
  'dwarf:sendText:settled': 'cut-4b'
}

/**
 * The RETIRE rows whose preload member leaves with their route, with that step (ISSUE-183): the action itself is removed
 * for every provider and nothing replaces it (14 §2.1 A-26 "RETIRE: the action is removed; not a rename"; "Stop
 * dwarf…" is the different, NEW A-N29), so the generated facade and the fake `window.api` drop the member from that
 * step on. Every other retired row keeps its member until its step's deletion issue (21 §2 "Retired rows").
 */
export const MEMBER_REMOVED: Partial<Record<ChannelKey, StepId>> = {
  'dwarf:kick': 'cut-3a'
}
