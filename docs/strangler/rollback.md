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

| Check                                                                                    | Test                                                                        |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| The cut-0 rollback table flips every cut-0 row that replaced legacy code and stays valid | `src/ui-main/ipc/rollbackTable.test.ts` (L1)                                |
| The rollback table passes the router test and never reaches deleted legacy code          | `src/ui-main/ipc/ipc-routing.contract.test.ts`, `describe('rollback')` (L6) |
| The D8 handshake between two builds, and the older-UI rule, over real processes          | `src/ui-main/hostLauncher/upgrade.os.test.ts` (L8, ISSUE-032)               |
| The cut-0 rollback rehearsed with the built app                                          | `e2e/cut-0/rollback-rehearsal.e2e.ts` (L9, release lane)                    |

The rehearsal (TC-057-02, TC-057-03) runs two builds of the tree against one profile: the repository's own `pnpm build`
as the faulty (or older) build, and a rollback build made for the run by `scripts/e2e/build-rehearsal-app.mjs`, one
patch version and one `protocolVersion` above, built into its own folder under `test-results/`. The override is an
electron-vite plugin passed inline by that script only (`scripts/e2e/rehearsalBuild.mjs`); no build config or package
script names it, so a release build keeps the real `PROTOCOL_VERSION` (`scripts/e2e/rehearsalBuild.test.mjs`).
