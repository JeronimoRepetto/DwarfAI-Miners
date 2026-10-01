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
  'diag:renderer:report': 'cut-0', // A-N30, routed ui-local by ISSUE-056 (21 §2 cut 0)
  // A-N25, A-N27 routed ui-local and A-N26 host (through LegacyEndFirstAdapter, ISSUE-054) by ISSUE-056 (21 §2 cut 0)
  'tray:stopEverything:requested': 'cut-0',
  'tray:stopEverything:confirm': 'cut-0',
  'tray:stopEverything:cancel': 'cut-0',
  // A-N34 (amendment 2026-10-01, ISSUE-316), routed ui-local by ISSUE-056 (21 §2 cut 0)
  'tray:stopEverything:request': 'cut-0',
  'host:connection:get': 'cut-0', // A-N03, routed ui-local by ISSUE-056 (21 §2 cut 0)
  'host:connection:changed': 'cut-0', // A-N04, routed ui-local by ISSUE-056 (21 §2 cut 0)
  'host:connection:retry': 'cut-0', // A-N05, routed ui-local by ISSUE-056 (21 §2 cut 0)
  // A-N33, born with the first release that bumps `endpointGeneration` (AMENDMENT-11; 21 "Different-generation
  // restart"); no handler in v1 (review R8B-06)
  'host:connection:confirm-restart': 'generation-2'
}
