# Parity exceptions — step cut-1

The parity record of cut 1 (`21-migration-plan.md` §1 item 3, §2 cut 1; ISSUE-123). Append-only: one entry per PR
(`22-roadmap.md` §5).

## Step and internal build

| Field              | Value                                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| Step               | `cut-1`                                                                                                        |
| Internal build     | branch `feat/issue-123-cut1-route-switch` (ISSUE-123); the internal build artifact is recorded when it is made |
| Route-switch issue | ISSUE-123                                                                                                      |
| Pre-cut build      | `origin/main` at `4f4d82ab`, the cut-0 table (`src/ui-main/ipc/testing/cut0Routes.ts` pins it)                 |

## Parity suite and run evidence

The suites `21` §2 names for this step (cut 1 "Exit criteria"): **observer parity** and **board parity**, with the
legacy-row parity through the bridges, the router case, L4 observer conformance, the L2 flows of `11`, the
`invariants.test.ts` pins and the cut-1 L9 cases.

- **Observer parity** (`src/legacy-bridge/parity/observerParity.cut-1.test.ts`): for every fixture session observed
  from its first record, the tokens the Host ledger credits equal what today's `src/main/domain/ledger.ts` (`accrue`)
  reports for the same records, except the rows of "Intended differences" below. The suite reads each difference it
  measures out of this file.
- **Board parity** (`src/legacy-bridge/parity/boardParity.cut-1.test.ts`): `BoardFacadeAdapter`'s `MinesSnapshot`
  validates against today's schema and is fact-equal to today's board of the same fixture world (mines, present dwarfs,
  ore per material and the open ask cards: a legacy Claude permission and a legacy Codex pending question), each dwarf
  compared through `LegacyDwarfIdBridge`'s join and each relayed ask through its `legacy:` namespace. The ask cards are
  also pinned by `src/legacy-bridge/LegacyAskRelay.test.ts` (ISSUE-089).
- **Legacy-row parity through the bridges** (same file): send (A-23), open console (A-13), answer an observed Codex
  question (A-40, through `LegacyAskRelay`) and stop a legacy-launched dwarf (A-26, A-27) reach today's runtime with
  exactly the payloads the pre-cut build sent, and answer today's results unchanged.
- **Router** (`src/ui-main/ipc/ipc-routing.contract.test.ts`, `describe('release cut 1 (21 §2 cut 1)')`): one route per
  row with its shape, the retired rows with no handler, no legacy publish, crediting or notifier composed, the rollback
  table composing them again and never beside the Host observer's writes, and only seam-B members born by cut 1.
- **L4 observer conformance** (C-11, C-16, C-19, C-20, C-21): `src/host/modules/observation/adapters/*/`
  `*ObservationAdapter.conformance.test.ts` (Claude, Codex, Antigravity, OpenCode) and `providerErrors.conformance.test.ts`.
- **L9** (`e2e/cut-1/`): `observation.e2e.ts` and `stub-observed.e2e.ts` (a stub CLI session observed through the Host,
  and again after a reopen).
- **Deferred cases.** `e2e/cut-1/notifications-window-closed.e2e.ts` is not added in cut 1: S-018-1 is partial, so
  level-3 notifications are window-only (row S-018-1 below), and observed asks arrive in cut 2 (ISSUE-140). The S-018-1
  row covers it. Decided by: lead decision 2026-10-07. `e2e/cut-1/remove-mine-legacy-first.e2e.ts` waits for a separate
  Host fix of an observed Claude session's presence.
- **L2 flows of `11`**: F1 (observed session appears) `src/host/wiring/flows/observedSessionAppears.test.ts` and
  `observation.flow.test.ts`; F2 (usage → ledger → ore) `ledger.flow.test.ts` and `conversationReadSide.flow.test.ts`;
  F10 (coal backfill from the install moment) `ledger.flow.test.ts` ("[S19.02] …", "[S19.04] …") with
  `src/host/modules/ledger/application/coalBackfill.test.ts` and `mineCoalBackfill.test.ts`; F12 (UI attach and reopen)
  `offlineActivity.test.ts`, `conversationReadSide.flow.test.ts` (a reconnecting `ui` snapshot) and the renderer's
  `src/renderer/src/composables/readModel.test.ts`. They pass, so no `cut-1.flow.test.ts` was added.
- **Invariant pins** (`src/host/invariants.test.ts`): "[ADR-029] the ended-agent, #45 and coal-only-via-backfill tests
  exist and keep their statements".

| Suite | Command | Internal build | OS  | Result | Date |
| ----- | ------- | -------------- | --- | ------ | ---- |

## Intended differences

| Behaviour                                                         | Legacy build                                                                                                                                                       | This step                                                                                                                                                                                                                                      | Decided by                                                                         |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Offline credit (ADR-006 item 7)                                   | a session seen for the first time only sets a baseline, so one that started and ended while the app was closed earns nothing                                       | the Host reads every transcript from its cursor at the next start and credits the units produced while the app was closed, by the same rules, so such a session is credited in full                                                            | ADR-006 item 7; OQ-14                                                              |
| Coal                                                              | live observation and the historical pass both fed today's vault                                                                                                    | coal is credited only by the coal backfill, once, for units before the install moment; live observation never credits coal                                                                                                                     | ADR-029 (coal-only-via-backfill); ADR-006 item 8; INV-95                           |
| Once only per `unitKey`                                           | today's ledger credits the growth of a session's running counter between polls                                                                                     | each accounting unit is credited once by its `unitKey`, whichever path or re-read meets it; a re-read or a replay credits nothing more                                                                                                         | ADR-006 items 4 and 8; SP-06 (one authoritative usage path per session)            |
| Antigravity ore                                                   | an observed Antigravity session earned no ore                                                                                                                      | an observed Antigravity mine earns ore from Antigravity's local conversations database, read through the read-only snapshot                                                                                                                    | AMENDMENT-13; `15` §5                                                              |
| Remove mine on an observed Codex, Antigravity or OpenCode session | today's runtime removed the mine                                                                                                                                   | the mine is kept and A-32 reports `dwarf-could-not-be-ended`: the Host has no process identity for a session somebody else launched, so nothing is signalled (a legacy-launched session is ended first through `LegacyEndFirstAdapter`)        | `15` §5 `failed: 'no-identity'`; ADR-014 item 2; S-014-1 (partial, below); OQ-11 A |
| A-18 `setDwarfTuning`                                             | a held session's model and effort could be changed from the session strip                                                                                          | retired with no route: the renderer no longer holds the legacy dwarf id it targets, and no story asks for it                                                                                                                                   | `21` §2 cut 1 "Retired rows"; `14` §2.1 A-18 (RETIRE)                              |
| History                                                           | the mines, ore, names and conversations of today's stores                                                                                                          | not carried over: the Host's database is born empty, and mines, ore and names fill from observation and the coal backfill                                                                                                                      | `21` §2 cut 1 "User-visible guarantee", §5.1, §5.3; NFR-PERS-15                    |
| Activity lines in a chat (#279)                                   | a read or edit step's own path in the chat and the history could be pressed to open the file                                                                       | not clickable from cut 1: the chat and the history are the Host's message log, whose rows carry no activity step                                                                                                                               | owner answer 2026-10-07                                                            |
| A-34 `queryProjects` sort and fields                              | a browse could sort by `addedAt` or by last opened, and each row carried its real `addedAt`, whether it was declared, and `folderMissing` when the folder was gone | `sortBy: 'addedAt'` is refused; every row answers `addedAt: 0` and `declared: false` and omits `folderMissing`. The UI sorts only by last opened                                                                                               | owner answer 2026-10-07                                                            |
| A-32 removing an unknown mine                                     | —                                                                                                                                                                  | removing an unknown or already removed mine id answers ok and changes nothing (`RemoveMineResult` has no `'unknown'`)                                                                                                                          | owner answer 2026-10-07                                                            |
| A departed dwarf on the board                                     | a dwarf left the board when today's lifecycle grace window let it go                                                                                               | a departed dwarf is dropped from the board after a fixed 720 ms, the length of the walk-out animation                                                                                                                                          | owner answer 2026-10-07                                                            |
| A legacy ask with no single Host dwarf                            | today's board drew each held ask on the legacy dwarf that held it                                                                                                  | a legacy ask relayed by `LegacyAskRelay` that matches no Host dwarf, or more than one, shows no card                                                                                                                                           | owner answer 2026-10-07                                                            |
| A-P4 with no matched Host dwarf                                   | today's push carried the legacy dwarf id the renderer held                                                                                                         | a legacy A-P4 whose dwarf matches no Host dwarf is withheld                                                                                                                                                                                    | owner answer 2026-10-07                                                            |
| Feed role and time mapping (A-15, A-19)                           | today's feed carried its own speaker kinds and the time the poller read                                                                                            | the person's messages and the answers record map to `user`; the dwarf's messages and system lines map to `assistant`; each row's time is `providerTime ?? createdAt`                                                                           | owner answer 2026-10-07                                                            |
| A-40, A-41 answer naming a non-relayed ask id                     | an answer naming a dwarf that had left answered "That dwarf has left the mine."                                                                                    | an ask id outside `LegacyAskRelay`'s `legacy:` namespace is stale and dropped before today's runtime, with today's "no longer open" answer, whatever its dwarf; the seam-A replay leaves these two rows out (`e2e/cut-0/seam-a-replay.e2e.ts`) | `21` §3 (`LegacyAskRelay` namespace); ADR-010 item 5                               |

## Routes moved in this step

Rows of `src/ui-main/ipc/routes.ts` this step changes (ids of `14-ipc-contract.md` §2). Every other row keeps its cut-0
route: the window family `ui-local`, A-N26 `host`, and every other today row `legacy` with today's shape, A-13, A-23,
A-26, A-27, A-P3 and A-P4 through `LegacyDwarfIdBridge` and A-40, A-41 through `LegacyAskRelay`. A-N33 stays unrouted
(`'generation-2'`).

| Row                                                                                                                          | Qualifier | Route before                           | Route after                                                                                                                            | Shape    |
| ---------------------------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| A-N01 `getHostSnapshot`, A-N02 `onHostEvent` (NEW)                                                                           | none      | unrouted (`unrouted.ts`, step `cut-1`) | `host`, `since: 'cut-1'`, `parity: 'passed'` (B-M04, B-M03)                                                                            | `target` |
| A-15 `getDwarfFeedPage`, A-19 `getMineHistory` (CHANGE)                                                                      | none      | `legacy`                               | `host` over the Host message log, `parity: 'passed'` (B-M26, B-M27)                                                                    | `target` |
| A-20 `openMinePath`, A-30 `declareMine` (KEEP)                                                                               | none      | `legacy`                               | `host`, each split: the UI-main half (the file opener, the folder picker) inside its `host` handler, `parity: 'passed'` (B-M20, B-M16) | `target` |
| A-31 `declareMainProject`, A-34 `queryProjects` (KEEP)                                                                       | none      | `legacy`                               | `host`, `parity: 'passed'` (B-M17, B-M19)                                                                                              | `target` |
| A-32 `undeclareMine` (KEEP)                                                                                                  | none      | `legacy`                               | `host` through `LegacyEndFirstAdapter` (legacy-launched sessions ended first), `parity: 'passed'` (B-M18)                              | `target` |
| A-12 `getMines`, A-P2 `onMinesUpdated` (RETIRE)                                                                              | none      | `legacy`                               | `host` through `BoardFacadeAdapter`, `parity: 'passed'`; the target shape of a RETIRE row is today's `MinesSnapshot`                   | `target` |
| A-33 `resetMetrics` (CHANGE)                                                                                                 | none      | `legacy` (`today`)                     | `legacy` through its shape adapter `ResetFanout` (today's reset, then B-M15)                                                           | `target` |
| A-44 `reportVisibleMines` (CHANGE, was `setOpenMine`)                                                                        | none      | `legacy`                               | `ui-local`, feeding the PresenceTracker (B-M07), `parity: 'passed'`                                                                    | `target` |
| A-N16 `onRevealDwarfChat`, A-N17…A-N21, A-N12 (NEW)                                                                          | none      | unrouted (`unrouted.ts`, step `cut-1`) | `ui-local`, `since: 'cut-1'`, `parity: 'n/a'`                                                                                          | `target` |
| A-14 `getDwarfFeed`, A-16 `setWatchedDwarf`, A-17 `refreshDwarfTelemetry`, A-18 `setDwarfTuning`, A-P5 `onShowMine` (RETIRE) | none      | `legacy`                               | no route and no handler (`RETIRED` in `unrouted.ts`, step `cut-1`; a rollback build routes them `legacy` again)                        | —        |

What `21` §2 lists as "Switched off in legacy" is switched off in today's composition (`LegacyRuntimeRoute.ts`, through
`src/legacy-bridge/legacyObserverSwitch.ts`) while the table routes the cut-1 board and read rows away from `legacy`:
no board push, no notifier, ledger crediting over a store that remembers nothing and no coal backfill, the projects
store's observer writes dropped, and no poll timer. Today's poll tick still runs, driven by `LegacyAgentRegistryFeed`'s
cycles, so the rows still `legacy` find their dwarf. `CUT_1_ROLLBACK` is `false` in this build.

Kept in this step: the renderer's echo merging (INV-60). Send (A-23) still routes `legacy`, so the Host writes no
"sending" row, and the echo of a sent message stands until the Host observes its words. It is removed when send moves to
the Host. Decided by: lead decision 2026-10-07.

## Spikes and variant recorded

| Spike   | Record                     | Outcome                                                                                                                                                                                                                                                                                                |
| ------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S-030-1 | `spike-results/S-030-1.md` | passed: a mine key is folded only where the detection says its folder folds (cut-1 entry gate met)                                                                                                                                                                                                     |
| S-018-1 | `spike-results/S-018-1.md` | partial: no OS has passed, so level-3 notifications are window-only on every OS (Windows, macOS, Linux) and R-16 lists the limit; a notification is drawn only while a window is shown; the `notifications-window-closed` L9 case is deferred ("Deferred cases" above)                                 |
| S-027-4 | `spike-results/S-027-4.md` | partial: no OS has passed (macOS's real login started and removed the entry, but the person's switch read-back failed; Windows and Linux have only the scripted half), so `LOGIN_ENTRY_PASSED` stays false everywhere and today's candidate autostart stays the one writer of the login entry until v1 |
| SP-06   | `spike-results/SP-06.md`   | partial: exactly one authoritative usage path per session, kept for its whole life (ADR-006 item 5)                                                                                                                                                                                                    |
| S-014-1 | `spike-results/S-014-1.md` | partial: no provider has passed on any OS, so an observed session ends `failed: 'no-identity'`: nothing is signalled and the mine is kept (row "Remove mine…" above)                                                                                                                                   |
| S-021-1 | `spike-results/S-021-1.md` | partial: an observed Claude session's turn ends are `inferred` (transcript only): no finished cue, no level-3 notification, no "Turn finished" wording                                                                                                                                                 |
| S-021-2 | `spike-results/S-021-2.md` | partial: an OpenCode session's turn ends are `inferred`, with the same consequences                                                                                                                                                                                                                    |
| S-032-1 | `spike-results/S-032-1.md` | partial: every adapter in scope keeps the documented inferred-end rule (no new record for 30 s and the last one is the assistant's)                                                                                                                                                                    |
| S-018-2 | `spike-results/S-018-2.md` | partial: a notification click follows FM-049: the chat is revealed and the window is asked to the front; where Windows refuses, the taskbar flashes                                                                                                                                                    |

Variant: the cut-1 build ships no driver: the Host observes every provider and launches nothing; every launch, send,
console, stop and ask row stays `legacy` through the bridges listed above.

## Soak record for the deletion

The step's retirement work units (ISSUE-124, ISSUE-125) merge only after this internal build met the step's exit
criteria on the three OSes and then ran for 7 days of normal use with no blocking problem (the soak, OQ-71).

| Field                        | Value                    |
| ---------------------------- | ------------------------ |
| Exit criteria met on Windows | pending (the runs above) |
| Exit criteria met on macOS   | pending (CI)             |
| Exit criteria met on Linux   | pending (CI)             |
| Soak build                   | pending                  |
| Soak start                   | pending                  |
| Soak end                     | pending                  |
| Blocking problems            | pending                  |
| Retirement or deletion issue | ISSUE-124, ISSUE-125     |
