// The router table (ADR-001 item 3; 21 §1 items 1, 2, 2a): exactly one `ChannelRoute` per (channel, qualifier) for
// the release `ROUTES_RELEASE`, reviewed per cut and checked by `ipc-routing.contract.test.ts`. A hot spot (22 §5):
// after this file is created only a step's route-switch issue changes it (ISSUE-056 for cut 0), with the two
// exceptions 22 §5 names. A NEW row whose route is born in a later step is not here: it is listed in
// `src/contracts/ipc/unrouted.ts` with that step.
import { STEP_ORDER, type StepId } from '@dwarfai/contracts'
import type { ChannelRoute, IpcChannelName, LegacyBridgeAdapter } from './channelRoute'

/** The release step this table is for (a `STEP_ORDER` value); each route-switch issue sets it to its step. */
export const ROUTES_RELEASE: StepId = 'pre-cut-0'

/** The steps from `from` to `to`, both included, in `STEP_ORDER`. */
function span(from: StepId, to: StepId): StepId[] {
  return STEP_ORDER.slice(STEP_ORDER.indexOf(from), STEP_ORDER.indexOf(to) + 1)
}

/**
 * The legacy-bridge adapters of 21 §3 and the shape adapters of 21 §3.1, with the steps they live in ("1–4" is cut 1
 * up to the end of cut 4, that is 4b). A `legacy` + `target` route names one of the shape adapters living in the
 * table's release; none lives past cut 5. Each is built by the cut that needs it (21 §3.1), in `src/legacy-bridge/**`.
 */
export const LEGACY_BRIDGE_ADAPTERS: readonly LegacyBridgeAdapter[] = [
  { name: 'LegacyRuntimeRoute', cuts: span('cut-0', 'cut-5'), shapeAdapter: false },
  { name: 'BoardFacadeAdapter', cuts: span('cut-1', 'cut-4b'), shapeAdapter: false },
  { name: 'LegacyDwarfIdBridge', cuts: span('cut-1', 'cut-4b'), shapeAdapter: false },
  { name: 'LegacyLaunchObservation', cuts: span('cut-1', 'cut-4b'), shapeAdapter: false },
  { name: 'SecretMigrationBridge', cuts: ['cut-3a', 'cut-4a'], shapeAdapter: false },
  { name: 'ResetFanout', cuts: span('cut-1', 'cut-3e'), shapeAdapter: true },
  { name: 'LegacyAgentRegistryFeed', cuts: span('cut-1', 'cut-4b'), shapeAdapter: false },
  { name: 'SettingsMirrorBridge', cuts: span('cut-1', 'cut-3e'), shapeAdapter: false },
  { name: 'LegacyAskRelay', cuts: span('cut-1', 'cut-4b'), shapeAdapter: false },
  { name: 'LegacyEndFirstAdapter', cuts: span('cut-0', 'cut-4b'), shapeAdapter: false },
  { name: 'PerProviderShapeAdapter', cuts: span('cut-3a', 'cut-4b'), shapeAdapter: true },
  { name: 'CatalogMergeAdapter', cuts: span('cut-3a', 'cut-4b'), shapeAdapter: true },
  { name: 'LegacyAnswerShapeAdapter', cuts: span('cut-2', 'cut-4b'), shapeAdapter: true },
  { name: 'JevSettingsShapeAdapter', cuts: span('cut-3a', 'cut-4a'), shapeAdapter: true }
]

/** A row served by today's runtime through `LegacyRuntimeRoute` with today's shape, unmoved since before cut 0. */
const legacyToday = (channel: IpcChannelName): ChannelRoute => ({
  channel,
  owner: 'legacy',
  since: 'pre-cut-0',
  parity: 'n/a',
  shape: 'today'
})

/**
 * Pre-cut 0: every today row of 14 §2.1 (A-01…A-57, A-P1…A-P6, A-X1) and the two legacy rows of 14 §8 I-21 are
 * `legacy` with today's shape (21 §2 "Pre-cut 0"; cut 0's switch of the window family to `ui-local` is ISSUE-056).
 * A push row is routed like any other (its owner sends it); the router registers no listener for a push or for the
 * A-X1 preload helper.
 */
export const ROUTES: readonly ChannelRoute[] = [
  legacyToday('panel:hide'), // A-01
  legacyToday('panel:raise'), // A-02
  legacyToday('panel:getAlwaysOnTop'), // A-03
  legacyToday('panel:setAlwaysOnTop'), // A-04
  legacyToday('panel:visible:get'), // A-05
  legacyToday('audio:preferences:get'), // A-06
  legacyToday('audio:preferences:set'), // A-07
  legacyToday('panel:layout:get'), // A-08
  legacyToday('panel:layout:set'), // A-09
  legacyToday('shortcut:get'), // A-10
  legacyToday('shortcut:set'), // A-11
  legacyToday('mines:get'), // A-12
  legacyToday('dwarf:activate'), // A-13
  legacyToday('dwarf:feed'), // A-14
  legacyToday('dwarf:feed:page'), // A-15
  legacyToday('panel:watchDwarfFeed'), // A-16
  legacyToday('dwarf:refreshTelemetry'), // A-17
  legacyToday('dwarf:setTuning'), // A-18
  legacyToday('mine:history'), // A-19
  legacyToday('mine:openPath'), // A-20
  legacyToday('shell:openExternalLink'), // A-21
  legacyToday('shell:copyText'), // A-22
  legacyToday('dwarf:sendText'), // A-23
  legacyToday('dwarf:attachments:choose'), // A-24
  legacyToday('dwarf:attachments:describe'), // A-25
  legacyToday('dwarf:kick'), // A-26
  legacyToday('dwarf:retire'), // A-27
  legacyToday('app:build'), // A-28
  legacyToday('app:features'), // A-29
  legacyToday('mine:declare'), // A-30
  legacyToday('mine:declare-main'), // A-31
  legacyToday('mine:undeclare'), // A-32
  legacyToday('metrics:reset'), // A-33
  legacyToday('projects:query'), // A-34
  legacyToday('agent:launch'), // A-35
  legacyToday('agent:providers'), // A-36
  legacyToday('agent:models'), // A-37
  legacyToday('agent:launchHeld'), // A-38
  legacyToday('agent:launchHosted'), // A-39
  legacyToday('agent:answerQuestion'), // A-40
  legacyToday('agent:answerPermission'), // A-41
  legacyToday('notifications:enabled:get'), // A-42
  legacyToday('notifications:enabled:set'), // A-43
  legacyToday('presence:visibleMines'), // A-44
  legacyToday('typography:preferences:get'), // A-45
  legacyToday('typography:preferences:set'), // A-46
  legacyToday('jev:settings:get'), // A-47
  legacyToday('jev:apiKey:set'), // A-48
  legacyToday('jev:apiKey:clear'), // A-49
  legacyToday('jev:route'), // A-50
  legacyToday('jev:preferences:set'), // A-51
  legacyToday('opencode:settings:get'), // A-52
  legacyToday('opencode:plugin:set'), // A-53
  legacyToday('opencode:password:set'), // A-54
  legacyToday('opencode:password:clear'), // A-55
  legacyToday('launch-view:get'), // A-56
  legacyToday('launch-view:set'), // A-57
  legacyToday('panel:visible:changed'), // A-P1
  legacyToday('mines:update'), // A-P2
  legacyToday('agent:launchFailed'), // A-P3
  legacyToday('dwarf:sendText:settled'), // A-P4
  legacyToday('panel:mine:show'), // A-P5
  legacyToday('typography:preferences:changed'), // A-P6
  legacyToday('pathForDroppedFile'), // A-X1
  legacyToday('dwarf:setName'), // 14 §8 I-21 (no §2 id)
  legacyToday('dwarf:resetName') // 14 §8 I-21 (no §2 id)
]
