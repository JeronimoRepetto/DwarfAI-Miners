# Rollback procedure — every cut

How a maintainer rolls back a cut of the strangler rebuild (`21-migration-plan.md` §2.1, items 1–4; ADR-002 D8; UC-026
"Host upgrade handshake"). Written down and tested before anyone needs it (ISSUE-057).

The DwarfAI Host is detached and never exits on its own (OQ-63). A rollback must therefore always say what happens to
the Host that is already running. There are two paths: the default one, and an older-artifact path that only cut 0 may
use.

## 1. Default path: a new internal build

A rollback is a **new internal build**, never an older artifact (`21` §2.1 item 1).

| The rollback build carries                                           | Why                                                                                                  |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| An app version higher than the faulty build's                        | It names a new versioned copy of the Host (ADR-002 D5), so the running Host can be upgraded to it    |
| A `protocolVersion` higher than the faulty build's                   | D8 item 2: a different `protocolVersion` of the same generation attaches in compat mode and upgrades |
| The same `endpointGeneration`                                        | A different generation would take the D8 item 4 path (blocking notice), which a rollback never needs |
| The cut's router rows flipped back to `legacy` with `shape: 'today'` | The legacy code is still in the tree until the cut's retirement step (§4)                            |

**Package inconsistency (recorded by ISSUE-057).** `21` §2.1 item 1 asks the rollback build for "a higher version" and
says the running Host "is upgraded to it by the ordinary ADR-002 D8 handshake". The app version alone does not do that:
the D8 table compares `protocolVersion`, never app versions, and with an equal `protocolVersion` item 1 attaches the
rollback build normally to the faulty build's Host, which keeps running (`upgradeDecision.ts`). The rehearsal shows it:
a rollback build one patch version above but with the same `protocolVersion` stayed attached to the faulty Host
(`hostVersion` still the faulty build's). So a rollback build also raises `protocolVersion`, as the table above says;
`21` §2.1 item 1 should name it.

Steps:

1. Build the rollback table from the faulty cut's table with `rollbackOf(table, cut)`
   (`src/ui-main/ipc/rollbackTable.ts`). It flips each row the cut moved off legacy code back to the pre-cut row
   (`legacy`, today's shape, no shape adapter). It keeps:
   - the NEW rows the cut created, because no legacy code serves them (at cut 0 these are the Host connection rows and
     the tray's Stop everything and quit, which the rollback build still needs to reach and stop its Host);
   - every row of an earlier cut, because that cut's retirement already deleted its legacy code.
2. Put that table in `src/ui-main/ipc/routes.ts` on the rollback branch. The router test
   (`src/ui-main/ipc/ipc-routing.contract.test.ts`, `describe('rollback')`) checks that the rollback table of the cut
   has one owner per channel and never gives a row back to legacy code an earlier retirement deleted.
3. Raise the app version and `protocolVersion` above the faulty build's, keep `endpointGeneration`, and build the
   internal build.
4. Install it. When it starts, it meets the running Host of the faulty build:
   - it attaches in **compat mode** and sends `host.upgrade.request` (ADR-002 D8 item 2, UC-026);
   - the Host drains at the first moment nothing is open or in flight, sends `host.closing {reason:'upgrade'}` and
     exits; no "stopped unexpectedly" toast is raised (the stop is DwarfAI's own);
   - the rollback build starts its Host from its own versioned copy.

What happens to the data: the new Host keeps `dwarfai.db`. Migrations are forward-only (`21` §5.1, ADR-005): a
rollback never deletes, rewrites or downgrades the database, and the rollback build's Host reads the schema the faulty
build left. No older UI ever meets a newer Host on this path.

**Cut 1 note.** Rolling back cut 1 also needs the cut-1 rollback setting that stops the Host observer's writes and its
level-3 notifications, so that the legacy observer is never composed together with the Host observer's writes. That
setting is EPIC-07's; it is referenced here, not specified (later: ISSUE-122).

**Cut 2 note (ISSUE-141).** `rollbackOf` folds A-40's and A-41's qualified routes back into one `legacy` row each,
with today's shape, so today's Claude hook half is composed again (`legacyClaudeHooksComposed`). It also withdraws the
cut's NEW rows that turn the Host's Claude hook entry on, A-N31 and A-N32 (`WRITES_A_FOREIGN_ENTRY`, recorded in the
table's `withdrawn`): they have no route in the rollback build, so the entry keeps one writer (`21` §1 item 4, §4).
Before that build starts, run the newer build's `--revert-integrations` so the entry the Host wrote is removed (`21` §2
cut 2 "Rollback"). The build also sets the cut-2 rollback setting, `CUT_2_ROLLBACK` in
`src/contracts/strangler/rollback.ts` (read in the Host only by `src/host/wiring/cut2Rollback.ts`; the router contract
test pins it on exactly when the table withdrew A-N31 and A-N32): on, the Host offers no first-run option, so the step
is not due (`07` S41.09; its one answer has no route there), and its config writer refuses every install, so the Host
writes no Claude hook entry while today's installer is composed again. Its Claude hooks target also leaves the old
app's entry alone (`keepOldAppEntries`): a Reset or the boot settlement of a row a crash left unverified removes the
Host's own entry only, never the one today's installer wrote. A-40 and A-41 fold into one unqualified `legacy` row that
keeps the target shape through `LegacyAnswerShapeAdapter`, because the rollback build's preload and renderer still
send the 14 shapes.

`--revert-integrations` builds its own `ClaudeHooksConfigWriter` without `keepOldAppEntries`
(`src/host/wiring/revertIntegrations.ts`), so it also removes today's installer's (the old app's) Claude hook entry.
That fits its purpose: it removes everything before an uninstall or a rollback.

An observed session outlives the Host (`07` S6.17), so an ask the cut-2 build opened can still be `open` when the
rollback build's Host boots, but no route answers a Host `AskId` in that build (the asking rows route `legacy`,
`INVALID_PARAMS`). On, the cut-2 rollback setting settles each ask the cut-2 build left `open` or `answering` at boot
as a request the Host no longer holds: it closes answered elsewhere (`07` S6.11, S6.20), its card disappears with no
notice, and the person answers in the provider's own terminal (#1293).

**Step 3a note (ISSUE-001).** A 3a rollback build exists only before the 3a deletion commit merges (ISSUE-184, after the
soak); after it, 3a rolls forward (`21` §2 cut 3 "Rollback (each step)"). `rollbackOf(table, 'cut-3a')` decides each
row as follows (`src/ui-main/ipc/rollbackTable.test.ts`, the 3a case):

| Rows                                                                       | In the 3a rollback build                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A-13, A-23, A-35 (`PerProviderShapeAdapter`), A-36 (`CatalogMergeAdapter`) | The Claude-qualified `host` route goes; the one unqualified `legacy` row with `shape: 'target'` and the row's shape adapter serves every provider, Claude included, because the build keeps this tree's preload and renderer, which send the 14 shapes. `CatalogMergeAdapter` asks the Host nothing when no provider moved                                                                                                                |
| A-25 (a KEEP row, every provider), A-27, A-P3, A-P4                        | The pre-cut row: today's runtime, today's shape, every provider                                                                                                                                                                                                                                                                                                                                                                           |
| A-26, A-37, A-38 (retired in 3a)                                           | The pre-cut row again (lead resolution H1). This tree's renderer no longer calls them (A-26 has no preload member from 3a, `MEMBER_REMOVED`), so the routes serve nothing                                                                                                                                                                                                                                                                 |
| A-48, A-49, A-50, A-47                                                     | Kept as 3a routed them (`KEPT_WITH_THE_MIGRATED_SECRET`): `SecretMigrationBridge` moved the Jev key into the Host's `SecretStore` on the first attach and deleted today's file, so today's runtime no longer holds it and a rollback build never moves a secret back (ADR-017 items 1, 8; the same rule as `21` §2 cut 4a "Rollback"). A-50 suggests with that key; A-47 reads its status from the Host through `JevSettingsShapeAdapter` |
| A-N06, A-N10, A-N11, A-N29 (NEW in 3a)                                     | Kept: no legacy code serves them. A-N29 still ends a legacy-launched session through `LegacyEndFirstAdapter`                                                                                                                                                                                                                                                                                                                              |

With no provider-qualified `host` route left, the root composes no provider qualifier, today's agent discovery runs for
Claude again (`legacyFeedModesOf` answers the cut-1 modes) and Claude's launches settle on A-P3/A-P4 under their
`LaunchId`/`MessageId` through the settlement join, as every other provider's do in 3a. Sessions the faulty build's Host
launched are left running and are re-observed by the Host (`21` §2 cut 3 "Rollback (each step)").

Known limit of a 3a rollback build: a "Let Jev choose" launch has no `host` route, so it reaches
`PerProviderShapeAdapter`, which refuses it (`INVALID_PARAMS`, "a Jev launch is served by the Host only"); the person
picks a supplier on the pickers. Widening Jev's candidates with an adapter was decided against (`21` §11 OI-21-4).

**Step 3b note (ISSUE-002).** A 3b rollback build exists only before the 3b deletion commit merges (ISSUE-185, after the
soak); after it, 3b rolls forward. 3b moves one more provider beside the shape-adapter routes 3a created, so
`rollbackOf(table, 'cut-3b')` gives back exactly the 3a table (`src/ui-main/ipc/rollbackTable.test.ts` and
`ipc-routing.contract.test.ts`, the 3b rollback cases):

| Rows                                     | In the 3b rollback build                                                                                                                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A-13, A-23, A-35, A-36 (Codex-qualified) | The Codex-qualified `host` route goes; Codex reaches the unqualified 3a route again (`PerProviderShapeAdapter`, `CatalogMergeAdapter`), with the 14 shapes the build's renderer sends. Claude's 3a routes stay |
| A-27, A-P3, A-P4                         | Codex's `legacy` row with today's shape comes back beside Antigravity's and OpenCode's, as 3a had it                                                                                                           |
| Every other row                          | As the 3b table routes it (3b moved no other row and bore no NEW row)                                                                                                                                          |

With Codex no longer moved, `legacyFeedModesOf` composes Codex's whole discovery again (the 3a modes), a Codex launch
settles on A-P3/A-P4 through the settlement join, and "Let Jev choose" chooses among Claude only. Codex sessions the
faulty build's Host launched are left running and are re-observed by the Host (`21` §2 cut 3 "Rollback (each step)").

## 2. Older artifact (maintainers only, last resort)

Only **cut 0 may roll back to an older artifact**: the pre-cut build, which knows no Host (`21` §2 cut 0 "Rollback").
From cut 1 on, the older Host copy would open a `dwarfai.db` of a newer schema read-only (`09` "future file"), so an
older artifact is usable only for cut 0 → pre-cut, or with a maintainer-chosen data directory (`21` §2.1 item 2).

Do these steps in this order:

1. **The tray's Stop everything and quit** (available from cut 0). It ends the owned and the legacy-launched sessions
   and stops the Host. Skipping it leaves the detached Host running forever (OQ-63).
2. From cut 2: run the newer build's `--revert-integrations`, which removes the entries the Host wrote into Claude's
   and OpenCode's configs (ADR-016 item 7; later: ISSUE-225).
3. From cut 1: turn "Start with the system" off (or remove the login entry), so the login entry does not start the
   newer Host again.
4. Install the older build. The pre-cut build ignores the Host's versioned copies and `dwarfai.db`.

## 3. Older UI meets a newer Host

If step 1 of §2 was skipped, the older UI meets the newer Host still running. The older UI's `protocolVersion` is lower
than the Host's (ADR-002 D8 item 5, `21` §2.1 item 3):

- it never sends `host.upgrade.request`: an upgrade never goes towards an older version;
- it shows the Host connection as incompatible (`unavailable {reason:'incompatible'}`);
- it offers only **Stop everything and quit** (`host.shutdown {mode:'stop-all'}`, a generation-level member);
- once that Host has exited, it starts its own Host copy.

## 4. Deletion commits roll forward

A rollback build flips rows back to legacy code that is still in the tree. After a cut's retirement step the legacy
code or data is gone, and the only fix is a forward build (`21` §2.1 item 4):

| Step                      | A rollback build is possible only before                                         |
| ------------------------- | -------------------------------------------------------------------------------- |
| cut 0, cut 1, cut 2       | the step's retirement issue (merged after the soak: 7 days of normal use, OQ-71) |
| cut 3a, 3b, 3d, 3e and 4b | the provider step's deletion commit                                              |
| cut 4a                    | its retirement, and the deletion of the legacy OpenCode password file            |
| cut 5                     | each deletion issue; after one, that legacy area is gone                         |

This is why `rollbackOf` only rolls back the cut whose table it is given: an earlier cut is already past its
retirement once a later cut ships.

## 5. Where it is tested

| Check                                                                                          | Test                                                                        |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| The cut-0 rollback table flips every cut-0 row that replaced legacy code and stays valid       | `src/ui-main/ipc/rollbackTable.test.ts` (L1)                                |
| The 3a rollback table folds the provider-qualified rows and keeps the Jev key rows (ISSUE-001) | `src/ui-main/ipc/rollbackTable.test.ts` (L1)                                |
| The rollback table passes the router test and never reaches deleted legacy code                | `src/ui-main/ipc/ipc-routing.contract.test.ts`, `describe('rollback')` (L6) |
| The D8 handshake between two builds, and the older-UI rule, over real processes                | `src/ui-main/hostLauncher/upgrade.os.test.ts` (L8, ISSUE-032)               |
| The cut-0 rollback rehearsed with the built app                                                | `e2e/cut-0/rollback-rehearsal.e2e.ts` (L9, release lane)                    |

The rehearsal (TC-057-02, TC-057-03) runs two builds of the tree against one profile: the repository's own `pnpm build`
as the faulty (or older) build, and a rollback build made for the run by `scripts/e2e/build-rehearsal-app.mjs`, one
patch version and one `protocolVersion` above, built into its own folder under `test-results/`. The override is an
electron-vite plugin passed inline by that script only (`scripts/e2e/rehearsalBuild.mjs`); no build config or package
script names it, so a release build keeps the real `PROTOCOL_VERSION` (`scripts/e2e/rehearsalBuild.test.mjs`).
