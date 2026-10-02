// The router table (ADR-001 item 3; 21 §1 items 1, 2, 2a): exactly one `ChannelRoute` per (channel, qualifier) for
// the release `ROUTES_RELEASE`, reviewed per cut and checked by `ipc-routing.contract.test.ts`. A hot spot (22 §5):
// after this file is created only a step's route-switch issue changes it (ISSUE-056 for cut 0), with the two
// exceptions 22 §5 names. A NEW row whose route is born in a later step is not here: it is listed in
// `src/contracts/ipc/unrouted.ts` with that step.
import { STEP_ORDER, type HostMethod, type StepId } from '@dwarfai/contracts'
import type { ChannelRoute, IpcChannelName, LegacyBridgeAdapter } from './channelRoute'

/** The release step this table is for (a `STEP_ORDER` value); each route-switch issue sets it to its step. */
export const ROUTES_RELEASE: StepId = 'cut-0'

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
 * A KEEP row the cut-0 switch moved to the rebuilt window module (21 §2 cut 0 "New core serves" U). Its target shape is
 * today's (14 §2.1 KEEP), so the renderer calls it unchanged; `passed` because its L6 contract suite answers it as
 * today's handler did (TC-056-05; the evidence is listed in `docs/strangler/parity-cut-0.md`).
 */
const uiLocalKept = (channel: IpcChannelName): ChannelRoute => ({
  channel,
  owner: 'ui-local',
  since: 'cut-0',
  parity: 'passed',
  shape: 'target'
})

/** A NEW row born `ui-local` in cut 0: no legacy code exists for it, so parity does not apply. */
const uiLocalNew = (channel: IpcChannelName): ChannelRoute => ({
  channel,
  owner: 'ui-local',
  since: 'cut-0',
  parity: 'n/a',
  shape: 'target'
})

/**
 * Cut 0 (21 §2 cut 0; ISSUE-056): the window family A-01…A-11, A-21, A-22, A-24, A-28, A-29, A-45, A-46, A-56, A-57,
 * A-P1, A-P6, A-X1 is served `ui-local` by the rebuilt window module; the NEW rows A-N03…A-N05 (Host connection), A-N30
 * (renderer diagnostics), A-N25, A-N27 (the tray's confirmation) and A-N34 (owner-approved amendment 2026-10-01,
 * ISSUE-316) are born `ui-local`; A-N26 is `host`, relayed through `LegacyEndFirstAdapter` (21 §3), using only B-M05
 * (`HOST_ROUTE_MEMBERS`). Every other today row of 14 §2.1 and the two legacy rows of 14 §8 I-21 stay `legacy` with
 * today's shape, the RETIRE rows included. A-N33 stays unrouted (`unrouted.ts`, 'generation-2'). A push row is routed
 * like any other (its owner sends it); the router registers no listener for a push or for the A-X1 preload helper.
 */
export const ROUTES: readonly ChannelRoute[] = [
  uiLocalKept('panel:hide'), // A-01
  uiLocalKept('panel:raise'), // A-02
  uiLocalKept('panel:getAlwaysOnTop'), // A-03
  uiLocalKept('panel:setAlwaysOnTop'), // A-04
  uiLocalKept('panel:visible:get'), // A-05
  uiLocalKept('audio:preferences:get'), // A-06
  uiLocalKept('audio:preferences:set'), // A-07
  uiLocalKept('panel:layout:get'), // A-08
  uiLocalKept('panel:layout:set'), // A-09
  uiLocalKept('shortcut:get'), // A-10
  uiLocalKept('shortcut:set'), // A-11
  legacyToday('mines:get'), // A-12
  legacyToday('dwarf:activate'), // A-13
  legacyToday('dwarf:feed'), // A-14
  legacyToday('dwarf:feed:page'), // A-15
  legacyToday('panel:watchDwarfFeed'), // A-16
  legacyToday('dwarf:refreshTelemetry'), // A-17
  legacyToday('dwarf:setTuning'), // A-18
  legacyToday('mine:history'), // A-19
  legacyToday('mine:openPath'), // A-20
  uiLocalKept('shell:openExternalLink'), // A-21
  uiLocalKept('shell:copyText'), // A-22
  legacyToday('dwarf:sendText'), // A-23
  uiLocalKept('dwarf:attachments:choose'), // A-24
  legacyToday('dwarf:attachments:describe'), // A-25
  legacyToday('dwarf:kick'), // A-26
  legacyToday('dwarf:retire'), // A-27
  uiLocalKept('app:build'), // A-28
  uiLocalKept('app:features'), // A-29
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
  uiLocalKept('typography:preferences:get'), // A-45
  uiLocalKept('typography:preferences:set'), // A-46
  legacyToday('jev:settings:get'), // A-47
  legacyToday('jev:apiKey:set'), // A-48
  legacyToday('jev:apiKey:clear'), // A-49
  legacyToday('jev:route'), // A-50
  legacyToday('jev:preferences:set'), // A-51
  legacyToday('opencode:settings:get'), // A-52
  legacyToday('opencode:plugin:set'), // A-53
  legacyToday('opencode:password:set'), // A-54
  legacyToday('opencode:password:clear'), // A-55
  uiLocalKept('launch-view:get'), // A-56
  uiLocalKept('launch-view:set'), // A-57
  uiLocalKept('panel:visible:changed'), // A-P1
  legacyToday('mines:update'), // A-P2
  legacyToday('agent:launchFailed'), // A-P3
  legacyToday('dwarf:sendText:settled'), // A-P4
  legacyToday('panel:mine:show'), // A-P5
  uiLocalKept('typography:preferences:changed'), // A-P6
  uiLocalKept('pathForDroppedFile'), // A-X1
  legacyToday('dwarf:setName'), // 14 §8 I-21 (no §2 id)
  legacyToday('dwarf:resetName'), // 14 §8 I-21 (no §2 id)
  uiLocalNew('host:connection:get'), // A-N03
  uiLocalNew('host:connection:changed'), // A-N04
  uiLocalNew('host:connection:retry'), // A-N05
  uiLocalNew('diag:renderer:report'), // A-N30
  uiLocalNew('tray:stopEverything:requested'), // A-N25
  {
    channel: 'tray:stopEverything:confirm', // A-N26, through LegacyEndFirstAdapter (21 §3)
    owner: 'host',
    since: 'cut-0',
    parity: 'passed',
    shape: 'target'
  },
  uiLocalNew('tray:stopEverything:cancel'), // A-N27
  uiLocalNew('tray:stopEverything:request') // A-N34 (owner-approved amendment 2026-10-01)
]

/**
 * The seam B members each `host` route relays (14 §6.3), for the router test's rule that a `host` route uses only
 * members born by its release (21 §2 "Seam B members: the cut in which each is born").
 */
export const HOST_ROUTE_MEMBERS: Partial<Record<IpcChannelName, readonly HostMethod[]>> = {
  'tray:stopEverything:confirm': ['host.shutdown'] // A-N26 → B-M05 `host.shutdown {mode:'stop-all'}`
}

/** The release in which each seam B method is born in the Host (21 §2 "Seam B members", B-M02…B-M06 at cut 0). */
export const SEAM_B_METHODS_BORN: Readonly<Partial<Record<HostMethod, StepId>>> = {
  ping: 'cut-0',
  'events.subscribe': 'cut-0',
  'session.snapshot': 'cut-0',
  'host.shutdown': 'cut-0',
  'host.upgrade.request': 'cut-0'
}
