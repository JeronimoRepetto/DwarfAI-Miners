// The router table (ADR-001 item 3; 21 §1 items 1, 2, 2a): exactly one `ChannelRoute` per (channel, qualifier) for
// the release `ROUTES_RELEASE`, reviewed per cut and checked by `ipc-routing.contract.test.ts`. A hot spot (22 §5):
// after this file is created only a step's route-switch issue changes it (ISSUE-056 for cut 0, ISSUE-123 for cut 1,
// ISSUE-141 for cut 2, ISSUE-001 for step 3a, ISSUE-002 for step 3b, ISSUE-186 for step 3d, ISSUE-188 for step 3e, ISSUE-235 for step 4a, ISSUE-238 for step 4b), with the two exceptions 22 §5 names. A NEW row whose route is born in a later step is not here:
// it is listed in `src/contracts/ipc/unrouted.ts` with that step.
import { CATALOG_PROVIDER_IDS, STEP_ORDER, type HostMethod, type StepId } from '@dwarfai/contracts'
import type { ChannelRoute, IpcChannelName, LegacyBridgeAdapter } from './channelRoute'

/** The release step this table is for (a `STEP_ORDER` value); each route-switch issue sets it to its step. */
export const ROUTES_RELEASE: StepId = 'cut-4b'

/** The steps from `from` to `to`, both included, in `STEP_ORDER`. */
function span(from: StepId, to: StepId): StepId[] {
  return STEP_ORDER.slice(STEP_ORDER.indexOf(from), STEP_ORDER.indexOf(to) + 1)
}

/**
 * The legacy-bridge adapters of 21 §3 and the shape adapters of 21 §3.1, with the steps they live in ("1–4" is cut 1
 * up to the end of cut 4, that is 4b). A `legacy` + `target` route names one of the shape adapters living in the
 * table's release; none lives past cut 5. Each is built by the cut that needs it (21 §3.1), in `src/legacy-bridge/**`.
 * AMENDED for ISSUE-236, the 4a retirement (was: also `ResetFanout` and `SettingsMirrorBridge`, cuts 1–3e, and
 * `JevSettingsShapeAdapter`, 3a–4a): their lifetime ended in 4a and they left the tree after the soak (21 §3).
 * AMENDED for ISSUE-240, the 4b deletion (was: also `LegacyLaunchObservation`, cuts 1–4b, and the shape adapters
 * `PerProviderShapeAdapter` and `CatalogMergeAdapter`, 3a–4b): no provider is launched by today's runtime any more, so
 * they left the tree (21 §3, §3.1).
 * AMENDED for ISSUE-241, the end of cut 4 (was: also `LegacyDwarfIdBridge`, `LegacyAgentRegistryFeed` and
 * `LegacyAskRelay`, cuts 1–4b, `LegacyEndFirstAdapter`, cuts 0–4b, and the shape adapter `LegacyAnswerShapeAdapter`,
 * 2–4b): the bridges that joined Host and legacy dwarfs end together in one work unit (21 §2 4b "Legacy deleted"; 14
 * §5, §6.5 AMENDMENT-8).
 * AMENDED for ISSUE-242, the first cut-5 deletion (was: also `BoardFacadeAdapter`, cuts 1–4b): a test proved it had no
 * consumer, so it left the tree with A-12 and A-P2 (21 §2 cut 5 entry, §3).
 */
export const LEGACY_BRIDGE_ADAPTERS: readonly LegacyBridgeAdapter[] = [
  { name: 'LegacyRuntimeRoute', cuts: span('cut-0', 'cut-5'), shapeAdapter: false },
  { name: 'SecretMigrationBridge', cuts: ['cut-3a', 'cut-4a'], shapeAdapter: false }
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
 * The catalog ids (ISSUE-009; R12: never a hand-typed provider literal here). Step 3a moves Claude's launcher to the
 * Host (21 §2 cut 3a), step 3b Codex's (21 §2 cut 3b), step 3e Antigravity's (21 §2 cut 3e, development builds only)
 * and step 4b OpenCode's (21 §2 cut 4b), the last: from 4b no provider's launch, send or stop row is `legacy`.
 */
const [CLAUDE = '', CODEX = '', ANTIGRAVITY = '', OPENCODE = ''] = CATALOG_PROVIDER_IDS
/**
 * The "Other…" driver's provider id (15 §3 H1: `HostedCommandDriver`'s profile, `hosted-command/profile.ts`), which the
 * Host board names for an "Other…" dwarf. Outside the catalog (INV-43: never a Jev candidate, no A-36 entry); step 3d
 * moves its rows to the Host (21 §2 cut 3d).
 */
const OTHER_COMMAND = 'other'

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
 * A-13, A-23 or A-35 from 3b: the Host for Claude (3a) and Codex (3b). AMENDED for ISSUE-238 (was: and
 * `PerProviderShapeAdapter` for every other provider, an unqualified `legacy` route from 3a to 4a, 21 §3.1): from 4b
 * every provider has its qualified `host` route, so none is left for the adapter and its route is gone (the A-27, A-P3
 * and A-P4 routes qualified to the providers not yet moved went with it: retired, `RETIRED`).
 */
const perProviderCut3b = (channel: IpcChannelName): ChannelRoute[] => [
  hostCut3a(channel, CLAUDE),
  hostCut3b(channel, CODEX)
]

/**
 * A row the step-3d switch serves from the Host (21 §2 cut 3d "Rows born or moved": A-39, B-M34; the "Other…" dwarfs'
 * A-13, A-23 and A-35) with its target shape, for every caller or for the "Other…" qualifier (`provider`): `passed`
 * because its evidence is recorded in `docs/strangler/parity-cut-3d.md` (the L4 conformance of `HostedCommandDriver`,
 * C-01…C-05, C-18, C-28, C-29, `hostedCommand.test.ts` unchanged, the L2 "Other…" flows, its L6 contract suite and the
 * cut-3d E2E case; 21 §1 item 3, §2 row 3d "Parity / exit").
 */
const hostCut3d = (channel: IpcChannelName, provider?: string): ChannelRoute => ({
  channel,
  owner: 'host',
  since: 'cut-3d',
  parity: 'passed',
  ...(provider === undefined ? {} : { qualifier: { provider } }),
  shape: 'target'
})

/** A-13, A-23 or A-35 from 3d: the Host for Claude (3a), Codex (3b) and "Other…" dwarfs (3d). */
const perProviderCut3d = (channel: IpcChannelName): ChannelRoute[] => [
  ...perProviderCut3b(channel),
  hostCut3d(channel, OTHER_COMMAND)
]

/**
 * A row the step-3e switch serves from the Host for Antigravity (21 §2 cut 3e "Rows born or moved": the
 * provider-qualified rows for Antigravity, its launch row in development builds only) with its target shape: `passed`
 * because its evidence is recorded in `docs/strangler/parity-cut-3e.md` (the L4 conformance of
 * `AntigravityNdjsonDriver`, C-01…C-05, C-16, C-18, the public-build test, the L2 Antigravity flow, its L6 contract
 * suite and the cut-3e E2E case; 21 §1 item 3, §2 row 3e "Parity / exit").
 */
const hostCut3e = (channel: IpcChannelName, provider: string): ChannelRoute => ({
  channel,
  owner: 'host',
  since: 'cut-3e',
  parity: 'passed',
  qualifier: { provider },
  shape: 'target'
})

/**
 * A-13 or A-23 from 3e: the Host for Claude (3a), Codex (3b), "Other…" dwarfs (3d) and Antigravity (3e). A-35 is
 * `perProviderCut3d` in every build, and a development build adds Antigravity's (`DEVELOPMENT_BUILD_ROUTES`).
 */
const perProviderCut3e = (channel: IpcChannelName): ChannelRoute[] => [
  ...perProviderCut3d(channel),
  hostCut3e(channel, ANTIGRAVITY)
]

/**
 * A row the step-4a switch serves from the Host (21 §2 cut 4a "New core serves" H: the Settings family, the secrets and
 * the integrations, A-33 the Reset saga alone) with its target shape and no shape adapter (21 §3.1: A-47's
 * `JevSettingsShapeAdapter` and A-33's `ResetFanout` end; A-52…A-55 switch shape with their route): `passed` because its
 * evidence is recorded in `docs/strangler/parity-cut-4a.md` (the settings parity suite, the secret migration test, the
 * `SecretStore` and `ExternalConfigWriter` contracts, the first-run, plugin-ask and Reset integration suites, its L6
 * contract suite and the cut-4a E2E cases; 21 §1 item 3, §2 row 4a "Exit criteria"). A-42, A-43, A-47 and A-51 are KEEP
 * rows whose today shape is the 14 target (ISSUE-007), so they are `target` too (the router rejects `host` + `today`).
 */
const hostCut4a = (channel: IpcChannelName): ChannelRoute => ({
  channel,
  owner: 'host',
  since: 'cut-4a',
  parity: 'passed',
  shape: 'target'
})

/**
 * A row the step-4b switch serves from the Host (21 §2 cut 4b "Rows moved": the provider-qualified rows for OpenCode;
 * unqualified, the route of A-13, A-23, A-35 and A-36 for every provider, which no provider is left to reach the shape
 * adapters through) with its target shape: `passed` because its evidence is recorded in `docs/strangler/parity-cut-4b.md` (the launch-cause parity suite,
 * the L4 conformance of OpenCode's `acp` entry, C-01…C-29 with C-27 for every gate value and C-23, the L2 OpenCode flow,
 * its L6 contract suites and the cut-4b E2E cases; 21 §1 item 3, §2 row 4b "Parity / exit").
 */
const hostCut4b = (channel: IpcChannelName, provider?: string): ChannelRoute => ({
  channel,
  owner: 'host',
  since: 'cut-4b',
  parity: 'passed',
  ...(provider === undefined ? {} : { qualifier: { provider } }),
  shape: 'target'
})

/**
 * A-13 or A-23 from 4b: the Host for every provider, OpenCode's qualified route and the unqualified one born in 4b (21
 * §2 cut 4b): with every provider moved, the route of a call naming no provider the table qualifies is the Host's too
 * (where 3a…4a had `PerProviderShapeAdapter`), so the Host, which owns the catalog and its build gate (ADR-009 D5, D6),
 * answers it. A-35 is `perProviderCut3d` plus the same two in every build, and a development build adds Antigravity's
 * qualified route (`DEVELOPMENT_BUILD_ROUTES`).
 */
const perProviderCut4b = (channel: IpcChannelName): ChannelRoute[] => [
  ...perProviderCut3e(channel),
  hostCut4b(channel, OPENCODE),
  hostCut4b(channel)
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
 * Step 3d (21 §2 cut 3d; ISSUE-186): A-39 moves to the Host (`launching.launchCustom`, B-M34) with its target shape (no
 * shape adapter, 21 §3.1), so an "Other…" command runs as a Host-owned session that no longer dies with the window; the
 * "Other…" dwarfs' A-35 (its Retry path), A-23 and A-13 move to the Host, qualified by the "Other…" driver's provider id
 * (A-N29's one `host` route already serves them). "Other…" has no A-36 entry and no A-27, A-P3, A-P4 row (a legacy
 * hosted process died with the window, so none outlives the update). B-M34 is born in 3d; no NEW row is.
 *
 * Step 3e (21 §2 cut 3e; ISSUE-188): Antigravity's send, console and catalog rows move to the Host, qualified by
 * provider as 3a and 3b did (A-23, A-13, A-36; A-N29's one `host` route already serves every dwarf), in every build:
 * the Host observes Antigravity's sessions and lists its entry only where it may launch it (ADR-009 D6: a public build's
 * `suppliers.launchable` has no gated entry). Its launch row (A-35 with its Retry path) moves in development builds
 * only (R-03, OQ-15): it is `DEVELOPMENT_BUILD_ROUTES`, added by `routesForBuild` from the one build flag, never a
 * provider-id branch, so a public build has no `host` route that launches Antigravity. A-27, A-P3 and A-P4 shrink to
 * OpenCode, the one provider whose launch, send and stop rows are still `legacy`. No seam B member and no NEW row is
 * born in 3e.
 *
 * Step 4a (21 §2 cut 4a; ISSUE-235): the Settings family moves to the Host with its target shape and no shape adapter:
 * A-42, A-43 (`systemNotificationsOn`), A-47, A-51 (`JevSettings` from the Host's preferences and `SecretStatus`),
 * A-52…A-55 (`OpenCodeSettingsView`: `IntegrationState` + `consentOrigin`, the password set and cleared in the Host's
 * `SecretStore` after `SecretMigrationBridge` moved it once) and A-33 (`preferences.resetMetrics`, the saga alone).
 * `ResetFanout`, `SettingsMirrorBridge` and `JevSettingsShapeAdapter` end (the root composes none of them over this
 * table), and today's OpenCode plugin installer and its listener route are switched off (`legacyOpenCodePluginComposed`,
 * src/ui-main/index.ts): the Host is the one writer of the plugin file and, through its plugin channel, the one answerer
 * of its asks, legacy-launched sessions' included, so A-40/A-41's `legacy-ask-channel` route serves only the
 * person-launched Codex questions `LegacyAskRelay` still reads. OpenCode's launch, send, stop and console rows and A-27,
 * A-P3, A-P4 stay `legacy` until 4b. B-M14 is born in 4a; no NEW row is.
 *
 * Step 4b (21 §2 cut 4b; ISSUE-238), the last provider step: OpenCode's launch, catalog, send and console rows move to
 * the Host, qualified by provider as every provider step did (A-35 with its Retry path, A-36, A-23, A-13; A-N29's one
 * `host` route already serves every dwarf), so the Host launches OpenCode through its `acp` entry (S-031-3 failed:
 * `OpenCodeServerDriver` only attaches to a person-run server) and reads its own `opencode-permissions` state for each
 * of its asks (a card while `on-verified`, auto-denied with one chat line otherwise; one answerer, ADR-011 items 3, 7).
 * No provider is left for the shape adapters, so the unqualified route of A-13, A-23, A-35 and A-36 is the Host's too:
 * a dwarf or a launch of a provider no qualified route names (the development build's simulated provider; a public
 * build's gated one, which its Host refuses, ADR-009 D6) and a "Let Jev choose" launch reach the Host, and the
 * renderer's one A-36 call, which names no provider, reaches the Host's `suppliers.launchable` whole
 * (`listAgentProviders.host.ts`). A-27, A-P3 and A-P4 have no provider qualifier left and
 * are retired with no route (`RETIRED`; their successors B-F10, B-F19, B-F12); their handlers and the legacy OpenCode
 * launch are deleted after the soak (ISSUE-239…ISSUE-241). "Let Jev choose" reaches the Host, whose candidates are every
 * launchable provider: the narrowing of 3a…4a ends. No seam B member and no NEW row is born in 4b.
 *
 * End of cut 4 (21 §2 4b "Legacy deleted"; ISSUE-241): `LegacyDwarfIdBridge`, `LegacyEndFirstAdapter`,
 * `LegacyAgentRegistryFeed`, `LegacyAskRelay` and `LegacyAnswerShapeAdapter` end together, so A-40 and A-41 keep only
 * their unqualified `host` route (a person-launched Codex question opens no card, ADR-011 item 4) and A-N26, A-32 and
 * A-N29 reach the Host alone (a session the old app launched has no identity to end, 15 §5 `no-identity`).
 *
 * First cut-5 deletion (21 §2 cut 5 entry; ISSUE-242): A-12 and A-P2 leave with `BoardFacadeAdapter`, retired at the
 * end of its 4b lifetime (`RETIRED`, `MEMBER_REMOVED`); the renderer reads the board through A-N01/A-N02 alone.
 *
 * Every other today row of 14 §2.1 and the two legacy rows of 14 §8 I-21 stay `legacy` with today's shape. A-N33 stays
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
  ...perProviderCut4b('dwarf:activate'), // A-13, every provider's through splits/activateDwarf.ts
  hostCut1('dwarf:feed:page'), // A-15
  hostCut1('mine:history'), // A-19
  hostCut1('mine:openPath'), // A-20
  uiLocalKept('shell:openExternalLink'), // A-21
  uiLocalKept('shell:copyText'), // A-22
  ...perProviderCut4b('dwarf:sendText'), // A-23
  uiLocalKept('dwarf:attachments:choose'), // A-24
  hostCut3a('dwarf:attachments:describe'), // A-25, every provider
  uiLocalKept('app:build'), // A-28
  uiLocalKept('app:features'), // A-29
  hostCut1('mine:declare'), // A-30
  hostCut1('mine:declare-main'), // A-31
  hostCut1('mine:undeclare'), // A-32
  hostCut4a('metrics:reset'), // A-33, the Host saga alone (`ResetFanout` ended)
  hostCut1('projects:query'), // A-34
  ...perProviderCut3d('agent:launch'), // A-35 and its Retry path (Antigravity's: `DEVELOPMENT_BUILD_ROUTES`)
  hostCut4b('agent:launch', OPENCODE), // A-35 and its Retry path, OpenCode's
  hostCut4b('agent:launch'), // A-35 and its Retry path, every other provider and "Let Jev choose"
  hostCut3a('agent:providers', CLAUDE), // A-36, Claude's entry
  hostCut3b('agent:providers', CODEX), // A-36, Codex's entry
  hostCut3e('agent:providers', ANTIGRAVITY), // A-36, Antigravity's entry (the Host lists it where it may launch it)
  hostCut4b('agent:providers', OPENCODE), // A-36, OpenCode's entry
  hostCut4b('agent:providers'), // A-36, the renderer's one catalog call: the Host's entries whole
  hostCut3d('agent:launchHosted'), // A-39, every "Other…" launch and its Retry
  hostCut2('agent:answerQuestion'), // A-40, Host AskIds only since ISSUE-241
  hostCut2('agent:answerPermission'), // A-41, Host AskIds only since ISSUE-241
  hostCut4a('notifications:enabled:get'), // A-42
  hostCut4a('notifications:enabled:set'), // A-43
  uiLocalCut1Kept('presence:visibleMines'), // A-44
  uiLocalKept('typography:preferences:get'), // A-45
  uiLocalKept('typography:preferences:set'), // A-46
  hostCut4a('jev:settings:get'), // A-47, from the Host's preferences and the key's status
  hostCut3a('jev:apiKey:set'), // A-48, after the one-time key migration
  hostCut3a('jev:apiKey:clear'), // A-49, after the one-time key migration
  hostCut3a('jev:route'), // A-50
  hostCut4a('jev:preferences:set'), // A-51
  hostCut4a('opencode:settings:get'), // A-52
  hostCut4a('opencode:plugin:set'), // A-53, the Host the one writer of the plugin file
  hostCut4a('opencode:password:set'), // A-54, after the one-time password migration
  hostCut4a('opencode:password:clear'), // A-55, after the one-time password migration
  uiLocalKept('launch-view:get'), // A-56
  uiLocalKept('launch-view:set'), // A-57
  uiLocalKept('panel:visible:changed'), // A-P1
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
    channel: 'tray:stopEverything:confirm', // A-N26
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
  hostCut3a('dwarf:stop'), // A-N29
  hostCut3a('dwarf:message:retry'), // A-N06
  hostCut3a('host:recovery:retry'), // A-N10
  hostCut3a('host:recovery:dismiss') // A-N11
]

/**
 * The rows only a development build adds to `ROUTES` (21 §2 row 3e "launch rows only in development builds"; ADR-009
 * D6; R-03, OQ-15): Antigravity's launch row, A-35 with its Retry path. A public build has none, so Antigravity is
 * launched by no `host` route there, and its A-36 entry, which the public Host does not list, offers it nowhere.
 */
export const DEVELOPMENT_BUILD_ROUTES: readonly ChannelRoute[] = [
  hostCut3e('agent:launch', ANTIGRAVITY) // A-35 and its Retry path, development builds only
]

/**
 * The table a build of this release serves: `ROUTES`, plus `DEVELOPMENT_BUILD_ROUTES` in a development build. The
 * composition root passes its one build flag (a packaged build is a public one, as the Host's `isPublicBuild` reads
 * it); the choice is the flag's, never a provider id's (ADR-009 D6).
 */
export function routesForBuild(build: { publicBuild: boolean }): readonly ChannelRoute[] {
  return build.publicBuild ? ROUTES : [...ROUTES, ...DEVELOPMENT_BUILD_ROUTES]
}

/**
 * The seam B members each `host` route relays (14 §6.3), for the router test's rule that a `host` route uses only
 * members born by its release (21 §2 "Seam B members: the cut in which each is born"). AMENDED for ISSUE-242 (was:
 * also A-12 and A-P2, the facade's reading of the Host board, and A-32 through `LegacyEndFirstAdapter`): the rows a
 * cut-5 deletion removed keep their members in the tables of the releases that shipped them (`testing/cut4aRoutes.ts`).
 */
export const HOST_ROUTE_MEMBERS: Partial<Record<IpcChannelName, readonly HostMethod[]>> = {
  'tray:stopEverything:confirm': ['host.shutdown'], // A-N26 → B-M05 `host.shutdown {mode:'stop-all'}`
  'host:snapshot': ['session.snapshot'], // A-N01 → B-M04
  'host:event': ['events.subscribe'], // A-N02 → B-M03's frames
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
  'dwarf:activate': ['conversation.resolveConsole'], // A-13 → B-M29, every provider (splits/activateDwarf.ts)
  'dwarf:sendText': ['conversation.send'], // A-23 → B-M24, every provider
  'dwarf:attachments:describe': ['conversation.describeAttachments'], // A-25 → B-M28
  // A-35 → B-M33, every provider (Antigravity in development builds only)
  'agent:launch': ['launching.launch'],
  'agent:launchHosted': ['launching.launchCustom'], // A-39 → B-M34
  'agent:providers': ['suppliers.launchable'], // A-36 → B-M37, the Host's entries whole from 4b
  'notifications:enabled:get': ['preferences.get'], // A-42 → B-M12
  'notifications:enabled:set': ['preferences.set'], // A-43 → B-M13
  'jev:settings:get': ['preferences.get'], // A-47 → B-M12
  'jev:preferences:set': ['preferences.get', 'preferences.set'], // A-51 → B-M13, read and answered with B-M12
  'opencode:settings:get': ['preferences.get'], // A-52 → B-M12
  'opencode:plugin:set': ['preferences.setOpenCodePermissions'], // A-53 → B-M14
  'opencode:password:set': ['settings.secret.set', 'preferences.get'], // A-54 → B-M10, answered with B-M12
  'opencode:password:clear': ['settings.secret.clear', 'preferences.get'], // A-55 → B-M11, answered with B-M12
  'metrics:reset': ['preferences.resetMetrics'], // A-33 → B-M15, the saga alone
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
 * B-M21, B-M24, B-M25, B-M28, B-M29, B-M33 and B-M35…B-M38 at 3a; B-M34 at 3d; none at 3e; B-M14 at 4a; none at
 * 4b).
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
  'jev.suggest': 'cut-3a',
  'launching.launchCustom': 'cut-3d',
  'preferences.setOpenCodePermissions': 'cut-4a'
}
