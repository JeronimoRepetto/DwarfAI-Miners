// The router table (ADR-001 item 3; 21 §1 items 1, 2, 2a): exactly one `ChannelRoute` per (channel, qualifier) for
// the release `ROUTES_RELEASE`, reviewed per cut and checked by `ipc-routing.contract.test.ts`. A hot spot (22 §5):
// after this file is created only a step's route-switch issue changes it (ISSUE-056 for cut 0, ISSUE-123 for cut 1,
// ISSUE-141 for cut 2, ISSUE-001 for step 3a, ISSUE-002 for step 3b), with the two exceptions 22 §5 names. A NEW row whose route is born in a later step is not here:
// it is listed in `src/contracts/ipc/unrouted.ts` with that step.
import { CATALOG_PROVIDER_IDS, STEP_ORDER, type HostMethod, type StepId } from '@dwarfai/contracts'
import type { ChannelRoute, IpcChannelName, LegacyBridgeAdapter } from './channelRoute'

/** The release step this table is for (a `STEP_ORDER` value); each route-switch issue sets it to its step. */
export const ROUTES_RELEASE: StepId = 'cut-3b'

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
 * A row the cut-1 switch moved to the Host (21 §2 cut 1 "New core serves" H) with its target shape: `passed` because
 * its parity evidence is recorded in `docs/strangler/parity-cut-1.md` (the observer and board parity suites, the
 * legacy-row parity through the bridges, its L6 contract suite and the cut-1 E2E cases; 21 §1 item 3).
 */
const hostCut1 = (channel: IpcChannelName): ChannelRoute => ({
  channel,
  owner: 'host',
  since: 'cut-1',
  parity: 'passed',
  shape: 'target'
})

/** A-44, the one today row the cut-1 switch moved to UI main (renamed `reportVisibleMines`, 14 §2.1 CHANGE). */
const uiLocalCut1Kept = (channel: IpcChannelName): ChannelRoute => ({
  channel,
  owner: 'ui-local',
  since: 'cut-1',
  parity: 'passed',
  shape: 'target'
})

/** A NEW row born `ui-local` in cut 1: no legacy code exists for it, so parity does not apply. */
const uiLocalCut1New = (channel: IpcChannelName): ChannelRoute => ({
  channel,
  owner: 'ui-local',
  since: 'cut-1',
  parity: 'n/a',
  shape: 'target'
})

/**
 * A row the cut-2 switch serves from the Host (21 §2 cut 2 "New core serves" H) with its target shape: `passed`
 * because its evidence is recorded in `docs/strangler/parity-cut-2.md` (the ask parity suite, the L1/L2 broker suites,
 * its L6 contract suite and the cut-2 E2E cases; 21 §1 item 3).
 */
const hostCut2 = (channel: IpcChannelName): ChannelRoute => ({
  channel,
  owner: 'host',
  since: 'cut-2',
  parity: 'passed',
  shape: 'target'
})

/**
 * A-40 or A-41 in cut 2 (21 §2 cut 2 "Qualified routes"; §1 items 2, 2a; 14 §8 I-11): the Host answers its own AskIds
 * (the unqualified route), and each origin of `LegacyAskRelay`'s `legacy:` namespace stays today's runtime's, reached
 * through the shape adapter `LegacyAnswerShapeAdapter` (21 §3.1). One owner per (channel, qualifier); the qualifier
 * is the relay's, read from the answer's AskId by the root (never a guess).
 */
const askAnswerCut2 = (channel: IpcChannelName): ChannelRoute[] => [
  hostCut2(channel),
  ...(['legacy-launch', 'legacy-ask-channel'] as const).map((origin): ChannelRoute => ({
    channel,
    owner: 'legacy',
    since: 'cut-2',
    parity: 'n/a',
    qualifier: { origin },
    shape: 'target',
    shapeAdapter: 'LegacyAnswerShapeAdapter'
  }))
]

/**
 * The catalog ids (ISSUE-009; R12: never a hand-typed provider literal here). Step 3a moves Claude's launcher to the
 * Host (21 §2 cut 3a), step 3b Codex's (21 §2 cut 3b); Antigravity and OpenCode move in 3e and 4b.
 */
const [CLAUDE = '', CODEX = '', ANTIGRAVITY = '', OPENCODE = ''] = CATALOG_PROVIDER_IDS
/** The providers whose launch, send and stop rows are still served by today's runtime in 3b. */
const NOT_MOVED_IN_3B: readonly string[] = [ANTIGRAVITY, OPENCODE]

/**
 * A row the step-3a switch serves from the Host (21 §2 cut 3a "Rows born or moved") with its target shape, for every
 * provider or for the moved one (`provider`): `passed` because its evidence is recorded in
 * `docs/strangler/parity-cut-3a.md` (the launch-cause parity suite, the L2 flows and the L4 driver conformance of the
 * Claude drivers, its L6 contract suite and the cut-3a E2E cases; 21 §1 item 3, §2 row 3a "Parity / exit").
 */
const hostCut3a = (channel: IpcChannelName, provider?: string): ChannelRoute => ({
  channel,
  owner: 'host',
  since: 'cut-3a',
  parity: 'passed',
  ...(provider === undefined ? {} : { qualifier: { provider } }),
  shape: 'target'
})

/**
 * A row the step-3b switch serves from the Host for Codex (21 §2 cut 3b "Rows born or moved": the provider-qualified
 * rows for Codex) with its target shape: `passed` because its evidence is recorded in `docs/strangler/parity-cut-3b.md`
 * (the launch-cause parity suite, the L2 Codex flow and the L4 conformance of the Codex drivers, C-23 included, its L6
 * contract suite and the cut-3b E2E case; 21 §1 item 3, §2 row 3b "Parity / exit").
 */
const hostCut3b = (channel: IpcChannelName, provider: string): ChannelRoute => ({
  channel,
  owner: 'host',
  since: 'cut-3b',
  parity: 'passed',
  qualifier: { provider },
  shape: 'target'
})

/**
 * A row of a provider not yet moved from 3a (21 §2 cut 3 common rules, §3.1): today's runtime behind the named shape
 * adapter, with the renderer's target shape; unqualified, so every provider without a qualified route reaches it.
 */
const legacyThroughCut3a = (channel: IpcChannelName, shapeAdapter: string): ChannelRoute => ({
  channel,
  owner: 'legacy',
  since: 'cut-3a',
  parity: 'n/a',
  shape: 'target',
  shapeAdapter
})

/**
 * A-27, A-P3 or A-P4 from 3a (21 §2 cut 3 common rules): today's runtime with today's shape, qualified to each provider
 * not yet moved; a moved provider has no route (its successors are B-F10, B-F19 and B-F12). Retired at the end of 4b.
 * The step-3b switch removed Codex's route; the others are unchanged since 3a.
 */
const legacyNotMovedCut3a = (channel: IpcChannelName): ChannelRoute[] =>
  NOT_MOVED_IN_3B.map((provider) => ({
    channel,
    owner: 'legacy',
    since: 'cut-3a',
    parity: 'n/a',
    qualifier: { provider },
    shape: 'today'
  }))

/**
 * A-13, A-23 or A-35 from 3b: the Host for Claude (3a) and Codex (3b), `PerProviderShapeAdapter` for every other
 * provider (21 §3.1).
 */
const perProviderCut3b = (channel: IpcChannelName): ChannelRoute[] => [
  hostCut3a(channel, CLAUDE),
  legacyThroughCut3a(channel, 'PerProviderShapeAdapter'),
  hostCut3b(channel, CODEX)
]

/**
 * Cut 0 (21 §2 cut 0; ISSUE-056): the window family A-01…A-11, A-21, A-22, A-24, A-28, A-29, A-45, A-46, A-56, A-57,
 * A-P1, A-P6, A-X1 is served `ui-local` by the rebuilt window module; the NEW rows A-N03…A-N05 (Host connection), A-N30
 * (renderer diagnostics), A-N25, A-N27 (the tray's confirmation) and A-N34 (owner-approved amendment 2026-10-01,
 * ISSUE-316) are born `ui-local`; A-N26 is `host`, relayed through `LegacyEndFirstAdapter` (21 §3), using only B-M05
 * (`HOST_ROUTE_MEMBERS`).
 *
 * Cut 1 (21 §2 cut 1; ISSUE-123): A-N01, A-N02 (snapshot and frames), A-15, A-19 (the Host message log), the mines
 * admin rows A-20, A-30 (each split: the UI-main half, the folder picker or the file opener, inside its `host`
 * handler), A-31, A-34 and A-32 (through `LegacyEndFirstAdapter` for legacy-launched sessions), and A-12, A-P2 (through
 * `BoardFacadeAdapter`, today's `MinesSnapshot`) are `host`; A-44 (renamed `reportVisibleMines`, feeding `presence`),
 * A-N16 (replacing A-P5), A-N17…A-N21 and A-N12 are `ui-local`; A-33 stays `legacy` through its shape adapter
 * `ResetFanout`. A-14, A-16, A-17, A-18 and A-P5 are retired with no route (`RETIRED` in `unrouted.ts`).
 *
 * Cut 2 (21 §2 cut 2; ISSUE-141): A-40 and A-41 are `host` with their target shape for Host AskIds and `legacy`
 * through `LegacyAnswerShapeAdapter` for the relay's `legacy:` AskIds, one route per origin (`askAnswerCut2`); the NEW
 * rows A-N07 (`setAskStep`), A-N31 (`setClaudeHooksEnabled`) and A-N32 (`answerWelcome`) are born `host`. Lead decision
 * (ISSUE-172, 2026-10-17): the NEW rows A-N08 (`renameDwarf`) and A-N09 (`resetDwarfName`), which have no legacy owner,
 * are born `host` here too rather than at step 3a, since the renderer's board is the Host's once its first snapshot is
 * read; the legacy rows of 14 §8 I-21 stay `legacy` for a board still fed by today's feed.
 *
 * Step 3a (21 §2 cut 3a; ISSUE-001): Claude's launch, send, console and stop rows move to the Host, qualified by
 * provider (A-35 with its Retry path, A-23, A-13), and from 3a the renderer calls A-13, A-23, A-35 and A-36 with the 14
 * shapes for every provider: the providers not yet moved through `PerProviderShapeAdapter` (A-13, A-23, A-35) and
 * `CatalogMergeAdapter` (A-36, whose Claude-qualified `host` route names the moved provider, 21 §3.1). A-25 moves to
 * the Host for every provider; A-48, A-49 (the Jev key moved once, `SecretMigrationBridge`) and A-50 (`jev.suggest`)
 * are `host`, A-47 goes through `JevSettingsShapeAdapter`. The NEW rows A-N06, A-N10, A-N11 and A-N29 are born `host`;
 * A-N29 ends a legacy-launched session through `LegacyEndFirstAdapter` first (21 §3), so its one route serves every
 * dwarf. A-26 (kick), A-37 and A-38 are retired with no route (`RETIRED`). A-27, A-P3 and A-P4 stay `legacy` with
 * today's shape, qualified to the providers not yet moved.
 *
 * Step 3b (21 §2 cut 3b; ISSUE-002): Codex's launch, send, console and stop rows move to the Host, qualified by
 * provider exactly as 3a did for Claude (A-35 with its Retry path, A-36, A-23, A-13; A-N29's one `host` route already
 * serves every dwarf). The shape adapters keep serving the providers still not moved (Antigravity, OpenCode, and
 * "Other…", which no qualified route names), and A-27, A-P3 and A-P4 shrink to Antigravity and OpenCode. No seam B
 * member and no NEW row is born in 3b.
 *
 * Every other today row of 14 §2.1 and the two legacy rows of 14 §8 I-21 stay `legacy` with today's shape; the rows
 * still `legacy` that carry a dwarf id reach today's runtime through `LegacyDwarfIdBridge` (21 §3). A-N33 stays
 * unrouted (`unrouted.ts`, 'generation-2'). A push row is routed like any other (its owner sends it); the router
 * registers no listener for a push or for the A-X1 preload helper.
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
  hostCut1('mines:get'), // A-12, through BoardFacadeAdapter
  ...perProviderCut3b('dwarf:activate'), // A-13, Claude's through splits/activateDwarf.ts
  hostCut1('dwarf:feed:page'), // A-15
  hostCut1('mine:history'), // A-19
  hostCut1('mine:openPath'), // A-20
  uiLocalKept('shell:openExternalLink'), // A-21
  uiLocalKept('shell:copyText'), // A-22
  ...perProviderCut3b('dwarf:sendText'), // A-23
  uiLocalKept('dwarf:attachments:choose'), // A-24
  hostCut3a('dwarf:attachments:describe'), // A-25, every provider
  ...legacyNotMovedCut3a('dwarf:retire'), // A-27
  uiLocalKept('app:build'), // A-28
  uiLocalKept('app:features'), // A-29
  hostCut1('mine:declare'), // A-30
  hostCut1('mine:declare-main'), // A-31
  hostCut1('mine:undeclare'), // A-32, through LegacyEndFirstAdapter
  {
    channel: 'metrics:reset', // A-33, through its shape adapter ResetFanout (21 §3.1)
    owner: 'legacy',
    since: 'cut-1',
    parity: 'n/a',
    shape: 'target',
    shapeAdapter: 'ResetFanout'
  },
  hostCut1('projects:query'), // A-34
  ...perProviderCut3b('agent:launch'), // A-35 and its Retry path
  hostCut3a('agent:providers', CLAUDE), // A-36, Claude's entry (a moved provider of the catalog merge)
  legacyThroughCut3a('agent:providers', 'CatalogMergeAdapter'), // A-36, the renderer's one catalog call
  hostCut3b('agent:providers', CODEX), // A-36, Codex's entry (a moved provider of the catalog merge)
  legacyToday('agent:launchHosted'), // A-39
  ...askAnswerCut2('agent:answerQuestion'), // A-40
  ...askAnswerCut2('agent:answerPermission'), // A-41
  legacyToday('notifications:enabled:get'), // A-42
  legacyToday('notifications:enabled:set'), // A-43
  uiLocalCut1Kept('presence:visibleMines'), // A-44
  uiLocalKept('typography:preferences:get'), // A-45
  uiLocalKept('typography:preferences:set'), // A-46
  legacyThroughCut3a('jev:settings:get', 'JevSettingsShapeAdapter'), // A-47, the key's status from the Host
  hostCut3a('jev:apiKey:set'), // A-48, after the one-time key migration
  hostCut3a('jev:apiKey:clear'), // A-49, after the one-time key migration
  hostCut3a('jev:route'), // A-50
  legacyToday('jev:preferences:set'), // A-51
  legacyToday('opencode:settings:get'), // A-52
  legacyToday('opencode:plugin:set'), // A-53
  legacyToday('opencode:password:set'), // A-54
  legacyToday('opencode:password:clear'), // A-55
  uiLocalKept('launch-view:get'), // A-56
  uiLocalKept('launch-view:set'), // A-57
  uiLocalKept('panel:visible:changed'), // A-P1
  hostCut1('mines:update'), // A-P2, through BoardFacadeAdapter
  ...legacyNotMovedCut3a('agent:launchFailed'), // A-P3
  ...legacyNotMovedCut3a('dwarf:sendText:settled'), // A-P4
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
  uiLocalNew('tray:stopEverything:request'), // A-N34 (owner-approved amendment 2026-10-01)
  hostCut1('host:snapshot'), // A-N01
  hostCut1('host:event'), // A-N02
  uiLocalCut1New('mode:revealDwarfChat'), // A-N16, replacing A-P5
  uiLocalCut1New('ui:session:get'), // A-N17
  uiLocalCut1New('ui:session:patch'), // A-N18
  uiLocalCut1New('ui:session:changed'), // A-N19
  uiLocalCut1New('ui:preferences:get'), // A-N20
  uiLocalCut1New('ui:preferences:set'), // A-N21
  uiLocalCut1New('ui:preferences:reset'), // A-N12
  hostCut2('ask:step:set'), // A-N07
  hostCut2('claude:hooks:set'), // A-N31 (AMENDMENT-7)
  hostCut2('welcome:answer'), // A-N32 (AMENDMENT-7)
  hostCut2('dwarf:rename'), // A-N08 (ISSUE-172 lead decision)
  hostCut2('dwarf:name:reset'), // A-N09 (ISSUE-172 lead decision)
  hostCut3a('dwarf:stop'), // A-N29, through LegacyEndFirstAdapter for a legacy-launched session
  hostCut3a('dwarf:message:retry'), // A-N06
  hostCut3a('host:recovery:retry'), // A-N10
  hostCut3a('host:recovery:dismiss') // A-N11
]

/**
 * The seam B members each `host` route relays (14 §6.3), for the router test's rule that a `host` route uses only
 * members born by its release (21 §2 "Seam B members: the cut in which each is born"). A-12 and A-P2 are the facade's
 * reading of the Host board (the snapshot, then the frames); A-32's `LegacyEndFirstAdapter` reads the Host board too
 * and relays only `mines.remove`.
 */
export const HOST_ROUTE_MEMBERS: Partial<Record<IpcChannelName, readonly HostMethod[]>> = {
  'tray:stopEverything:confirm': ['host.shutdown'], // A-N26 → B-M05 `host.shutdown {mode:'stop-all'}`
  'host:snapshot': ['session.snapshot'], // A-N01 → B-M04
  'host:event': ['events.subscribe'], // A-N02 → B-M03's frames
  'mines:get': ['session.snapshot', 'events.subscribe'], // A-12 through BoardFacadeAdapter
  'mines:update': ['session.snapshot', 'events.subscribe'], // A-P2 through BoardFacadeAdapter
  'dwarf:feed:page': ['conversation.feed'], // A-15 → B-M26
  'mine:history': ['conversation.mineHistory'], // A-19 → B-M27
  'mine:openPath': ['mines.resolveFile'], // A-20 → B-M20
  'mine:declare': ['mines.declare'], // A-30 → B-M16
  'mine:declare-main': ['mines.adoptMainProject'], // A-31 → B-M17
  'mine:undeclare': ['mines.remove'], // A-32 → B-M18
  'projects:query': ['mines.list'], // A-34 → B-M19
  'agent:answerQuestion': ['asking.answerQuestion'], // A-40 → B-M30, Host AskIds
  'agent:answerPermission': ['asking.answerPermission'], // A-41 → B-M31, Host AskIds
  'ask:step:set': ['asking.setStep'], // A-N07 → B-M32
  'claude:hooks:set': ['preferences.setClaudeHooks'], // A-N31 → B-M39
  'welcome:answer': ['preferences.answerWelcome'], // A-N32 → B-M40
  'dwarf:rename': ['crew.rename'], // A-N08 → B-M22
  'dwarf:name:reset': ['crew.resetName'], // A-N09 → B-M23
  'dwarf:activate': ['conversation.resolveConsole'], // A-13 → B-M29, Claude and Codex (splits/activateDwarf.ts)
  'dwarf:sendText': ['conversation.send'], // A-23 → B-M24, Claude and Codex
  'dwarf:attachments:describe': ['conversation.describeAttachments'], // A-25 → B-M28
  'agent:launch': ['launching.launch'], // A-35 → B-M33, Claude and Codex
  // A-36 → B-M37: Claude's and Codex's entries, read by `CatalogMergeAdapter` for the renderer's one catalog call
  'agent:providers': ['suppliers.launchable'],
  'jev:apiKey:set': ['settings.secret.set', 'preferences.get'], // A-48 → B-M10, answered with B-M12
  'jev:apiKey:clear': ['settings.secret.clear', 'preferences.get'], // A-49 → B-M11, answered with B-M12
  'jev:route': ['jev.suggest'], // A-50 → B-M38
  'dwarf:stop': ['crew.stop'], // A-N29 → B-M21
  'dwarf:message:retry': ['conversation.retry'], // A-N06 → B-M25
  'host:recovery:retry': ['launching.retryRecovery'], // A-N10 → B-M35
  'host:recovery:dismiss': ['launching.dismissRecovery'] // A-N11 → B-M36
}

/**
 * The release in which each seam B method is born in the Host (21 §2 "Seam B members", B-M02…B-M06 at cut 0; B-M07,
 * B-M08, B-M09, B-M12, B-M13, B-M15, B-M16…B-M20, B-M26, B-M27 and B-M41 at cut 1; B-M30…B-M32, B-M39 and B-M40 at
 * cut 2; B-M22 and B-M23 at cut 2 too, by the ISSUE-172 lead decision, where 21 §2 has them at 3a; B-M10, B-M11,
 * B-M21, B-M24, B-M25, B-M28, B-M29, B-M33 and B-M35…B-M38 at 3a).
 */
export const SEAM_B_METHODS_BORN: Readonly<Partial<Record<HostMethod, StepId>>> = {
  ping: 'cut-0',
  'events.subscribe': 'cut-0',
  'session.snapshot': 'cut-0',
  'host.shutdown': 'cut-0',
  'host.upgrade.request': 'cut-0',
  presence: 'cut-1',
  'attention.clicked': 'cut-1',
  'ui.resetPreferences.ack': 'cut-1',
  'preferences.get': 'cut-1',
  'preferences.set': 'cut-1',
  'preferences.resetMetrics': 'cut-1',
  'mines.declare': 'cut-1',
  'mines.adoptMainProject': 'cut-1',
  'mines.remove': 'cut-1',
  'mines.list': 'cut-1',
  'mines.resolveFile': 'cut-1',
  'conversation.feed': 'cut-1',
  'conversation.mineHistory': 'cut-1',
  'strangler.dwarfIdentities': 'cut-1',
  'asking.answerQuestion': 'cut-2',
  'asking.answerPermission': 'cut-2',
  'asking.setStep': 'cut-2',
  'preferences.setClaudeHooks': 'cut-2',
  'preferences.answerWelcome': 'cut-2',
  'crew.rename': 'cut-2',
  'crew.resetName': 'cut-2',
  'settings.secret.set': 'cut-3a',
  'settings.secret.clear': 'cut-3a',
  'crew.stop': 'cut-3a',
  'conversation.send': 'cut-3a',
  'conversation.retry': 'cut-3a',
  'conversation.describeAttachments': 'cut-3a',
  'conversation.resolveConsole': 'cut-3a',
  'launching.launch': 'cut-3a',
  'launching.retryRecovery': 'cut-3a',
  'launching.dismissRecovery': 'cut-3a',
  'suppliers.launchable': 'cut-3a',
  'jev.suggest': 'cut-3a'
}
