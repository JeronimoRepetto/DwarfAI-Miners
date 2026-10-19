# Registry re-inventory (pre-cut 0, P-3)

- **Found tree:** `1da74e8135da4e2844717b7c040aedec4b2dc19b` (main, 2026-09-30).
- **Scan date:** 2026-09-30.
- **Scanner:** `node scripts/checks/ipc-reinventory.mjs` (static, reads the files as text).
- **Checked by:** `pnpm vitest run scripts/checks/ipc-reinventory.test.mjs`.
- **Updated for ISSUE-042:** today's composition also lives in `src/legacy-bridge/LegacyRuntimeRoute.ts`
  (`21` §3), so the six pushes list that file too. It registers nothing on `ipcMain`; no channel changed.
- **Updated for ISSUE-055:** A-N30 `reportRendererDiagnostic` (`diag:renderer:report`, NEW) is declared in the
  registry and now has a generated preload member, so its row moved to the found table. The router registers its
  `ipcMain` listener from the registry, not by a literal, so the preload is the only file the scanner finds.
- **Updated for ISSUE-053:** A-N25 `onStopEverythingRequested`, A-N26 `confirmStopEverything` and A-N27
  `cancelStopEverything` (`tray:stopEverything:*`, NEW) are declared in the registry and now have generated preload
  members, so their rows moved to the found table, as A-N30 did.
- **Updated for ISSUE-052:** A-N03 `getHostConnection`, A-N04 `onHostConnection`, A-N05 `retryHostConnection` and
  A-N33 `confirmHostRestart` (NEW) are declared in the registry and have generated preload members, so their rows
  moved to the found table, the same way as A-N30.
- **Updated for ISSUE-316:** A-N34 `requestStopEverything` (`tray:stopEverything:request`, NEW, amendment
  owner-approved 2026-10-01) is declared in the registry and has a generated preload member, so its row is in the
  found table, as A-N25…A-N27 are.
- **Updated for ISSUE-059:** A-N17 `getUiSession`, A-N18 `patchUiSession` and A-N19 `onUiSessionChanged`
  (`ui:session:*`, NEW) are declared in the registry and have generated preload members, so their rows moved to the
  found table, as A-N30 did. The counts below also take in A-N34, which the ISSUE-316 update left out of them.
- **Updated for ISSUE-060:** A-N20 `getUiPreferences` and A-N21 `setUiPreference` (`ui:preferences:get`, `:set`,
  NEW) are declared in the registry and have generated preload members, so their rows moved to the found table.
- **Updated for ISSUE-061:** A-N12 `onUiPreferencesReset` (`ui:preferences:reset`, NEW) is declared in the registry and
  has a generated preload member, so its row moved to the found table.
- **Updated for ISSUE-082:** A-N01 `getHostSnapshot` (`host:snapshot`) and A-N02 `onHostEvent` (`host:event`), NEW,
  are declared in the registry and have generated preload members, so their rows moved to the found table, as A-N30
  did.
- **Updated for ISSUE-114:** A-N16 `onRevealDwarfChat` (`mode:revealDwarfChat`, NEW) is declared in the registry and
  has a generated preload member, so its row moved to the found table.
- **Updated for ISSUE-221:** A-N31 `setClaudeHooksEnabled` (`claude:hooks:set`, NEW, AMENDMENT-7) is declared in the
  registry and has a generated preload member, so its row moved to the found table.
- **Updated for ISSUE-129:** A-N07 `setAskStep` (`ask:step:set`, NEW) is declared in the registry and has a generated
  preload member, so its row moved to the found table.
- **Updated for ISSUE-223:** A-N32 `answerWelcome` (`welcome:answer`, NEW, AMENDMENT-7) is declared in the registry and
  has a generated preload member, so its row moved to the found table.
- **Updated for ISSUE-171:** A-N29 `stopDwarf` (`dwarf:stop`, NEW, AMENDMENT-2) is declared in the registry and has a
  generated preload member, so its row moved to the found table.
- **Updated for ISSUE-168:** A-N06 `retryDwarfMessage` (`dwarf:message:retry`, NEW) is declared in the registry and
  has a generated preload member, so its row moved to the found table.
- **Updated for ISSUE-172:** A-N08 `renameDwarf` (`dwarf:rename`) and A-N09 `resetDwarfName` (`dwarf:name:reset`), NEW,
  are declared in the registry with generated preload members, so their rows moved to the found table; today's
  `dwarf:resetName` member is renamed `resetDwarfNameToday`, so the two never share a member name.
- **Updated for ISSUE-174:** A-N10 `retryRecovery` (`host:recovery:retry`, NEW) and A-N11 `dismissRecovery`
  (`host:recovery:dismiss`, NEW) are declared in the registry and have generated preload members, so their rows moved
  to the found table.
- **Updated for ISSUE-123:** A-44 is renamed by the cut-1 switch (14 §2.1 CHANGE): the generated preload member
  `reportVisibleMines` sends `presence:visibleMines`, so it has its own row under the same id, and the `panel:openMine`
  row lost its preload location. Today's `setOpenMine` registration and constant stay until cut 5.
- **Updated for ISSUE-246:** `src/shared/` is deleted (21 §2 cut 5); today's `IPC_CHANNELS` constants moved unchanged
  with the rest of `contracts.ts` to `src/contracts/wire/today.ts`, so each row that listed the old file lists the new
  one. No channel changed.
- **Compared with:** `14-ipc-contract.md` §2.1, §2.2, §7 and §8 I-21 of the architecture package. `14` is frozen
  and lives in the package, not in this repository.
- **For the registry issue (ISSUE-007):** `dwarf:setName` and `dwarf:resetName` have no `14` §2 id. Their
  rows name `§8 I-21`, so ISSUE-007 must declare them from `14` §8 I-21 (AMENDMENT-12).

This table records every `ipcMain` registration, preload member, main → renderer push and `IPC_CHANNELS`
constant of the found tree once, with the id and status `14` gives it (migration plan `21` §2, pre-cut 0 item P-3; `14` §6.5 "Registry completeness"). A channel that `14` does not list would be `UNLISTED` with an amendment-request id `AR-P3-nn`, raised with the owner, and nothing would be added for it anywhere. The found tree has none.

## How to read it

- One row per channel, keyed by its wire name. The one preload helper with no wire is keyed by its member name.
- **Kind:** `invoke` (`ipcMain.handle`), `send` (`ipcMain.on`), `push` (`webContents.send`, preload `onX`) or
  `helper` (a preload member that makes no IPC call).
- **Found at:** every `file:line` where the channel appears (registration or push, preload member,
  `IPC_CHANNELS` constant). Line numbers are dated evidence of the found tree, like the counts of `14` §7. The
  test checks the wire name, member, kind and files of each row, not its line numbers.
- **14 id** and **Status:** as `14` §2.1 or §2.2 gives them (`KEEP`, `CHANGE`, `NEW`, `RETIRE`). The two legacy channels that `14` classifies only in §8 I-21 name `§8 I-21` instead of an id. `UNLISTED` would mark a channel `14` does not list.
- The second table lists the `14` §2.2 rows that the found tree does not have yet. All of them are `NEW`.

## Candidate decision

No candidate: the scanner, its test and this table are new code. The found registrations, preload members and
pushes were evaluated against `14` §2 and none of them was changed.

## Counts

| Found in the tree                                 | KEEP | CHANGE | NEW | RETIRE | UNLISTED | Total |
| ------------------------------------------------- | ---- | ------ | --- | ------ | -------- | ----- |
| Request / one-way channels (`ipcMain` handlers)   | 32   | 17     | 15  | 11     | 0        | 75    |
| Pushes                                            | 2    | 0      | 6   | 4      | 0        | 12    |
| Preload helper without IPC                        | 1    | 0      | 0   | 0      | 0        | 1     |
| **Found total**                                   | 35   | 17     | 21  | 15     | 0        | 88    |
| `14` §2.2 NEW members not in the tree (2nd table) | —    | —      | 13  | —      | —        | 13    |

Against the dated `0bfd108` counts of `14` §7: the found tree has 59 registrations (57 + 2), 65 `IPC_CHANNELS`
constants (63 + 2) and 66 preload members (64 + 2). The two extra channels are `dwarf:setName` and
`dwarf:resetName`, the legacy rows of `14` §8 I-21 (RETIRE, counted in the RETIRE column above). Every one of the 64 `14` §2.1 rows is found, with the member name and
kind `14` gives it.

## Notes

- **The two §8 I-21 rows.** `dwarf:resetName` (`resetDwarfName`) and `dwarf:setName` (`setDwarfName`), added by
  `93b7177`, have no `14` §2 row. `14` §8 I-21 (AMENDMENT-12, OQ-82) maps them as legacy rows, RETIRE at cut 5, with
  the successors A-N09 and A-N08. No channel of the found tree is `UNLISTED`.
- **A member name used twice.** The found preload member `resetDwarfName` sends `dwarf:resetName`, while `14`
  A-N09 is `resetDwarfName` / `dwarf:name:reset`. Same member name, different wire name and different row.
- **Veta and Valle.** The found tree has no Veta or Valle channel. The Veta/Valle members of `14` §2.2
  (A-N13…A-N16, A-N20…A-N24, A-N28) are `NEW`, born `ui-local`, and may never be routed `legacy` (`21` §7,
  ADR-034); their rows in the second table say so.
- **Later use.** The registry completeness test (ISSUE-007) reads this table as its source of found channels,
  through `readReinventoryTable` in `scripts/checks/ipc-reinventory.mjs`.

## Tables

<!-- reinventory-table:start -->

### Found in the tree

| Wire name                         | Member                        | Kind   | Found at                                                     | 14 id   | Status | Amendment request | Notes                                                                                                                                     |
| --------------------------------- | ----------------------------- | ------ | ------------------------------------------------------------ | ------- | ------ | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `agent:answerPermission`          | `answerDwarfPermission`       | invoke | src/contracts/wire/today.ts:5375<br>src/preload/index.ts:375 | A-41    | CHANGE | —                 |                                                                                                                                           |
| `agent:answerQuestion`            | `answerDwarfQuestion`         | invoke | src/contracts/wire/today.ts:5367<br>src/preload/index.ts:373 | A-40    | CHANGE | —                 |                                                                                                                                           |
| `agent:launch`                    | `launchAgent`                 | invoke | src/contracts/wire/today.ts:5318<br>src/preload/index.ts:732 | A-35    | CHANGE | —                 |                                                                                                                                           |
| `agent:launchFailed`              | `launchFailed`                | —      | src/contracts/wire/today.ts:5326                             | A-P3    | RETIRE | —                 |                                                                                                                                           |
| `agent:launchHeld`                | `launchHeldSession`           | invoke | src/contracts/wire/today.ts:5366<br>src/preload/index.ts:797 | A-38    | RETIRE | —                 |                                                                                                                                           |
| `agent:launchHosted`              | `launchHostedProcess`         | invoke | src/contracts/wire/today.ts:5389<br>src/preload/index.ts:819 | A-39    | CHANGE | —                 |                                                                                                                                           |
| `agent:models`                    | `listAgentModels`             | invoke | src/contracts/wire/today.ts:5350<br>src/preload/index.ts:368 | A-37    | RETIRE | —                 |                                                                                                                                           |
| `agent:providers`                 | `listAgentProviders`          | invoke | src/contracts/wire/today.ts:5337<br>src/preload/index.ts:366 | A-36    | CHANGE | —                 |                                                                                                                                           |
| `app:build`                       | `getAppBuild`                 | invoke | src/contracts/wire/today.ts:5258<br>src/preload/index.ts:357 | A-28    | KEEP   | —                 |                                                                                                                                           |
| `app:features`                    | `getFeatureFlags`             | invoke | src/contracts/wire/today.ts:5263<br>src/preload/index.ts:358 | A-29    | KEEP   | —                 |                                                                                                                                           |
| `ask:step:set`                    | `setAskStep`                  | invoke | src/preload/index.ts:585                                     | A-N07   | NEW    | —                 | Declared by ISSUE-129; its preload member is generated (ISSUE-045); unrouted until cut 2                                                  |
| `audio:preferences:get`           | `getAudioPreferences`         | invoke | src/contracts/wire/today.ts:5083<br>src/preload/index.ts:311 | A-06    | KEEP   | —                 |                                                                                                                                           |
| `audio:preferences:set`           | `setAudioPreferences`         | invoke | src/contracts/wire/today.ts:5084<br>src/preload/index.ts:312 | A-07    | KEEP   | —                 |                                                                                                                                           |
| `claude:hooks:set`                | `setClaudeHooksEnabled`       | invoke | src/preload/index.ts:581                                     | A-N31   | NEW    | —                 | Declared by ISSUE-221 (AMENDMENT-7); its preload member is generated (ISSUE-045); unrouted until cut 2                                    |
| `diag:renderer:report`            | `reportRendererDiagnostic`    | send   | src/preload/index.ts:437                                     | A-N30   | NEW    | —                 | Declared by ISSUE-055; its preload member is generated (ISSUE-045); main registers it by the router's registry loop, unrouted until cut 0 |
| `dwarf:activate`                  | `activateDwarf`               | invoke | src/contracts/wire/today.ts:5095<br>src/preload/index.ts:326 | A-13    | CHANGE | —                 |                                                                                                                                           |
| `dwarf:attachments:choose`        | `chooseDwarfAttachments`      | invoke | src/contracts/wire/today.ts:5232<br>src/preload/index.ts:714 | A-24    | KEEP   | —                 |                                                                                                                                           |
| `dwarf:attachments:describe`      | `describeDwarfAttachments`    | invoke | src/contracts/wire/today.ts:5244<br>src/preload/index.ts:350 | A-25    | KEEP   | —                 |                                                                                                                                           |
| `dwarf:feed`                      | `getDwarfFeed`                | invoke | src/contracts/wire/today.ts:5102<br>src/preload/index.ts:327 | A-14    | RETIRE | —                 |                                                                                                                                           |
| `dwarf:feed:page`                 | `getDwarfFeedPage`            | invoke | src/contracts/wire/today.ts:5115<br>src/preload/index.ts:328 | A-15    | CHANGE | —                 |                                                                                                                                           |
| `dwarf:kick`                      | `kickDwarf`                   | —      | src/contracts/wire/today.ts:5245                             | A-26    | RETIRE | —                 |                                                                                                                                           |
| `dwarf:message:retry`             | `retryDwarfMessage`           | invoke | src/preload/index.ts:576                                     | A-N06   | NEW    | —                 | Declared by ISSUE-168 (US-MSG-003, ADR-022 item 5); its preload member is generated (ISSUE-045); unrouted until cut 3a                    |
| `dwarf:refreshTelemetry`          | `refreshDwarfTelemetry`       | send   | src/contracts/wire/today.ts:5134<br>src/preload/index.ts:331 | A-17    | RETIRE | —                 |                                                                                                                                           |
| `dwarf:rename`                    | `renameDwarf`                 | invoke | src/preload/index.ts:579                                     | A-N08   | NEW    | —                 | Declared by ISSUE-172; successor of `dwarf:setName` (§8 I-21); generated member; routed `host` from cut 2 (lead decision)                 |
| `dwarf:name:reset`                | `resetDwarfName`              | invoke | src/preload/index.ts:581                                     | A-N09   | NEW    | —                 | Declared by ISSUE-172; successor of `dwarf:resetName` (§8 I-21); generated member; routed `host` from cut 2 (lead decision)               |
| `dwarf:resetName`                 | `resetDwarfName`              | —      | src/contracts/wire/today.ts:5162                             | §8 I-21 | RETIRE | —                 | Legacy row of 14 §8 I-21 (AMENDMENT-12, OQ-82); member renamed by ISSUE-172 (A-N09 owns `resetDwarfName`); RETIRE at cut 5                |
| `dwarf:retire`                    | `retireDwarf`                 | —      | src/contracts/wire/today.ts:5252                             | A-27    | RETIRE | —                 |                                                                                                                                           |
| `dwarf:sendText`                  | `sendDwarfText`               | invoke | src/contracts/wire/today.ts:5211<br>src/preload/index.ts:692 | A-23    | CHANGE | —                 |                                                                                                                                           |
| `dwarf:sendText:settled`          | `dwarfSendSettled`            | —      | src/contracts/wire/today.ts:5221                             | A-P4    | RETIRE | —                 |                                                                                                                                           |
| `dwarf:setName`                   | `setDwarfName`                | —      | src/contracts/wire/today.ts:5161                             | §8 I-21 | RETIRE | —                 | Legacy row of 14 §8 I-21 (AMENDMENT-12, OQ-82), no §2 id; successor A-N08 `renameDwarf` / `dwarf:rename`; RETIRE at cut 5                 |
| `dwarf:setTuning`                 | `setDwarfTuning`              | invoke | src/contracts/wire/today.ts:5151<br>src/preload/index.ts:333 | A-18    | RETIRE | —                 |                                                                                                                                           |
| `dwarf:stop`                      | `stopDwarf`                   | invoke | src/preload/index.ts:564                                     | A-N29   | NEW    | —                 | Declared by ISSUE-171 (AMENDMENT-2, OQ-54); its preload member is generated (ISSUE-045); unrouted until cut 3a                            |
| `host:connection:changed`         | `onHostConnection`            | push   | src/preload/index.ts:534                                     | A-N04   | NEW    | —                 | Declared by ISSUE-052; its preload member is generated (ISSUE-045); unrouted until cut 0                                                  |
| `host:connection:confirm-restart` | `confirmHostRestart`          | invoke | src/preload/index.ts:542                                     | A-N33   | NEW    | —                 | Declared by ISSUE-052 (AMENDMENT-11); its preload member is generated (ISSUE-045); unrouted until generation-2, no handler in v1          |
| `host:connection:get`             | `getHostConnection`           | invoke | src/preload/index.ts:533                                     | A-N03   | NEW    | —                 | Declared by ISSUE-052; its preload member is generated (ISSUE-045); unrouted until cut 0                                                  |
| `host:connection:retry`           | `retryHostConnection`         | invoke | src/preload/index.ts:541                                     | A-N05   | NEW    | —                 | Declared by ISSUE-052; its preload member is generated (ISSUE-045); unrouted until cut 0                                                  |
| `host:event`                      | `onHostEvent`                 | push   | src/preload/index.ts:596                                     | A-N02   | NEW    | —                 | Declared by ISSUE-082; its preload member is generated (ISSUE-045); UI main pushes it, unrouted until cut 1                               |
| `host:recovery:dismiss`           | `dismissRecovery`             | invoke | src/preload/index.ts:585                                     | A-N11   | NEW    | —                 | Declared by ISSUE-174 (PO #90; OQ-43); its preload member is generated (ISSUE-045); unrouted until cut 3a                                 |
| `host:recovery:retry`             | `retryRecovery`               | invoke | src/preload/index.ts:583                                     | A-N10   | NEW    | —                 | Declared by ISSUE-174 (PO #90; OQ-41 A); its preload member is generated (ISSUE-045); unrouted until cut 3a                               |
| `host:snapshot`                   | `getHostSnapshot`             | invoke | src/preload/index.ts:595                                     | A-N01   | NEW    | —                 | Declared by ISSUE-082; its preload member is generated (ISSUE-045); unrouted until cut 1                                                  |
| —                                 | `pathForDroppedFile`          | helper | src/preload/index.ts:707                                     | A-X1    | KEEP   | —                 |                                                                                                                                           |
| `jev:apiKey:clear`                | `clearJevApiKey`              | invoke | src/contracts/wire/today.ts:5460<br>src/preload/index.ts:932 | A-49    | KEEP   | —                 |                                                                                                                                           |
| `jev:apiKey:set`                  | `setJevApiKey`                | invoke | src/contracts/wire/today.ts:5459<br>src/preload/index.ts:925 | A-48    | KEEP   | —                 |                                                                                                                                           |
| `jev:preferences:set`             | `setJevPreferences`           | invoke | src/contracts/wire/today.ts:5482<br>src/preload/index.ts:954 | A-51    | KEEP   | —                 |                                                                                                                                           |
| `jev:route`                       | `routeJevLaunch`              | invoke | src/contracts/wire/today.ts:5473<br>src/preload/index.ts:942 | A-50    | CHANGE | —                 |                                                                                                                                           |
| `jev:settings:get`                | `getJevSettings`              | invoke | src/contracts/wire/today.ts:5458<br>src/preload/index.ts:917 | A-47    | KEEP   | —                 |                                                                                                                                           |
| `launch-view:get`                 | `getLaunchView`               | invoke | src/contracts/wire/today.ts:5503<br>src/preload/index.ts:400 | A-56    | KEEP   | —                 |                                                                                                                                           |
| `launch-view:set`                 | `setLaunchView`               | send   | src/contracts/wire/today.ts:5504<br>src/preload/index.ts:401 | A-57    | KEEP   | —                 |                                                                                                                                           |
| `metrics:reset`                   | `resetMetrics`                | invoke | src/contracts/wire/today.ts:5301<br>src/preload/index.ts:785 | A-33    | CHANGE | —                 |                                                                                                                                           |
| `mine:declare`                    | `declareMine`                 | invoke | src/contracts/wire/today.ts:5280<br>src/preload/index.ts:359 | A-30    | KEEP   | —                 |                                                                                                                                           |
| `mine:declare-main`               | `declareMainProject`          | invoke | src/contracts/wire/today.ts:5292<br>src/preload/index.ts:360 | A-31    | KEEP   | —                 |                                                                                                                                           |
| `mine:history`                    | `getMineHistory`              | invoke | src/contracts/wire/today.ts:5173<br>src/preload/index.ts:334 | A-19    | CHANGE | —                 |                                                                                                                                           |
| `mine:openPath`                   | `openMinePath`                | invoke | src/contracts/wire/today.ts:5186<br>src/preload/index.ts:335 | A-20    | KEEP   | —                 |                                                                                                                                           |
| `mine:undeclare`                  | `undeclareMine`               | invoke | src/contracts/wire/today.ts:5293<br>src/preload/index.ts:361 | A-32    | KEEP   | —                 |                                                                                                                                           |
| `mines:get`                       | `getMines`                    | —      | src/contracts/wire/today.ts:5093                             | A-12    | RETIRE | —                 |                                                                                                                                           |
| `mines:update`                    | `minesUpdated`                | —      | src/contracts/wire/today.ts:5094                             | A-P2    | RETIRE | —                 |                                                                                                                                           |
| `mode:revealDwarfChat`            | `onRevealDwarfChat`           | push   | src/preload/index.ts:607                                     | A-N16   | NEW    | —                 | Declared by ISSUE-114; its preload member is generated (ISSUE-045); UI main pushes it, unrouted until cut 1                               |
| `notifications:enabled:get`       | `getNotificationsEnabled`     | invoke | src/contracts/wire/today.ts:5398<br>src/preload/index.ts:873 | A-42    | KEEP   | —                 |                                                                                                                                           |
| `notifications:enabled:set`       | `setNotificationsEnabled`     | invoke | src/contracts/wire/today.ts:5399<br>src/preload/index.ts:877 | A-43    | KEEP   | —                 |                                                                                                                                           |
| `opencode:password:clear`         | `clearOpenCodeServerPassword` | invoke | src/contracts/wire/today.ts:5494<br>src/preload/index.ts:973 | A-55    | CHANGE | —                 |                                                                                                                                           |
| `opencode:password:set`           | `setOpenCodeServerPassword`   | invoke | src/contracts/wire/today.ts:5493<br>src/preload/index.ts:963 | A-54    | CHANGE | —                 |                                                                                                                                           |
| `opencode:plugin:set`             | `setOpenCodePluginEnabled`    | invoke | src/contracts/wire/today.ts:5492<br>src/preload/index.ts:959 | A-53    | CHANGE | —                 |                                                                                                                                           |
| `opencode:settings:get`           | `getOpenCodeSettings`         | invoke | src/contracts/wire/today.ts:5491<br>src/preload/index.ts:958 | A-52    | CHANGE | —                 |                                                                                                                                           |
| `panel:getAlwaysOnTop`            | `getAlwaysOnTop`              | invoke | src/contracts/wire/today.ts:5041<br>src/preload/index.ts:566 | A-03    | KEEP   | —                 |                                                                                                                                           |
| `panel:hide`                      | `hidePanel`                   | send   | src/contracts/wire/today.ts:5023<br>src/preload/index.ts:564 | A-01    | KEEP   | —                 |                                                                                                                                           |
| `panel:layout:get`                | `getPanelLayout`              | invoke | src/contracts/wire/today.ts:5049<br>src/preload/index.ts:585 | A-08    | KEEP   | —                 |                                                                                                                                           |
| `panel:layout:set`                | `setPanelLayout`              | invoke | src/contracts/wire/today.ts:5050<br>src/preload/index.ts:593 | A-09    | KEEP   | —                 |                                                                                                                                           |
| `panel:mine:show`                 | `onShowMine`                  | push   | src/contracts/wire/today.ts:5425<br>src/preload/index.ts:409 | A-P5    | RETIRE | —                 |                                                                                                                                           |
| `panel:openMine`                  | `setOpenMine`                 | —      | src/contracts/wire/today.ts:5413                             | A-44    | CHANGE | —                 | 14 renames it to `reportVisibleMines` / `presence:visibleMines` within this CHANGE row                                                    |
| `panel:raise`                     | `raisePanel`                  | send   | src/contracts/wire/today.ts:5035<br>src/preload/index.ts:565 | A-02    | KEEP   | —                 |                                                                                                                                           |
| `panel:setAlwaysOnTop`            | `setAlwaysOnTop`              | invoke | src/contracts/wire/today.ts:5042<br>src/preload/index.ts:569 | A-04    | KEEP   | —                 |                                                                                                                                           |
| `panel:visible:changed`           | `onPanelVisibility`           | push   | src/contracts/wire/today.ts:5074<br>src/preload/index.ts:571 | A-P1    | KEEP   | —                 |                                                                                                                                           |
| `panel:visible:get`               | `getPanelVisible`             | invoke | src/contracts/wire/today.ts:5073<br>src/preload/index.ts:570 | A-05    | KEEP   | —                 |                                                                                                                                           |
| `panel:watchDwarfFeed`            | `setWatchedDwarf`             | send   | src/contracts/wire/today.ts:5124<br>src/preload/index.ts:330 | A-16    | RETIRE | —                 |                                                                                                                                           |
| `presence:visibleMines`           | `reportVisibleMines`          | send   | src/preload/index.ts:438                                     | A-44    | CHANGE | —                 | The new name of A-44; its preload member is generated (ISSUE-045); `ui-local` from cut 1 (ISSUE-123)                                      |
| `projects:query`                  | `queryProjects`               | invoke | src/contracts/wire/today.ts:5312<br>src/preload/index.ts:364 | A-34    | KEEP   | —                 |                                                                                                                                           |
| `shell:copyText`                  | `copyText`                    | invoke | src/contracts/wire/today.ts:5210<br>src/preload/index.ts:345 | A-22    | KEEP   | —                 |                                                                                                                                           |
| `shell:openExternalLink`          | `openExternalLink`            | invoke | src/contracts/wire/today.ts:5203<br>src/preload/index.ts:343 | A-21    | KEEP   | —                 |                                                                                                                                           |
| `shortcut:get`                    | `getToggleShortcut`           | invoke | src/contracts/wire/today.ts:5091<br>src/preload/index.ts:599 | A-10    | KEEP   | —                 |                                                                                                                                           |
| `shortcut:set`                    | `setToggleShortcut`           | invoke | src/contracts/wire/today.ts:5092<br>src/preload/index.ts:603 | A-11    | KEEP   | —                 |                                                                                                                                           |
| `tray:stopEverything:cancel`      | `cancelStopEverything`        | send   | src/preload/index.ts:521                                     | A-N27   | NEW    | —                 | Declared by ISSUE-053; its preload member is generated (ISSUE-045); main registers it by the router's registry loop, unrouted until cut 0 |
| `tray:stopEverything:confirm`     | `confirmStopEverything`       | invoke | src/preload/index.ts:519                                     | A-N26   | NEW    | —                 | Declared by ISSUE-053; its preload member is generated (ISSUE-045); main registers it by the router's registry loop, unrouted until cut 0 |
| `tray:stopEverything:request`     | `requestStopEverything`       | send   | src/preload/index.ts:535                                     | A-N34   | NEW    | —                 | Declared by ISSUE-316; its preload member is generated (ISSUE-045); main registers it by the router's registry loop, unrouted until cut 0 |
| `tray:stopEverything:requested`   | `onStopEverythingRequested`   | push   | src/preload/index.ts:512                                     | A-N25   | NEW    | —                 | Declared by ISSUE-053; its preload member is generated (ISSUE-045); UI main pushes it, unrouted until cut 0                               |
| `typography:preferences:changed`  | `onTypographyPreferences`     | push   | src/contracts/wire/today.ts:5446<br>src/preload/index.ts:416 | A-P6    | KEEP   | —                 |                                                                                                                                           |
| `typography:preferences:get`      | `getTypographyPreferences`    | invoke | src/contracts/wire/today.ts:5444<br>src/preload/index.ts:383 | A-45    | KEEP   | —                 |                                                                                                                                           |
| `typography:preferences:set`      | `setTypographyPreferences`    | invoke | src/contracts/wire/today.ts:5445<br>src/preload/index.ts:385 | A-46    | KEEP   | —                 |                                                                                                                                           |
| `ui:preferences:get`              | `getUiPreferences`            | invoke | src/preload/index.ts:584                                     | A-N20   | NEW    | —                 | Declared by ISSUE-060; its preload member is generated (ISSUE-045); unrouted until cut 1                                                  |
| `ui:preferences:reset`            | `onUiPreferencesReset`        | push   | src/preload/index.ts:588                                     | A-N12   | NEW    | —                 | Declared by ISSUE-061; its preload member is generated (ISSUE-045); UI main pushes it, unrouted until cut 1                               |
| `ui:preferences:set`              | `setUiPreference`             | invoke | src/preload/index.ts:586                                     | A-N21   | NEW    | —                 | Declared by ISSUE-060; its preload member is generated (ISSUE-045); unrouted until cut 1                                                  |
| `ui:session:changed`              | `onUiSessionChanged`          | push   | src/preload/index.ts:310                                     | A-N19   | NEW    | —                 | Declared by ISSUE-059; its preload member is generated (ISSUE-045); UI main pushes it, unrouted until cut 1                               |
| `ui:session:get`                  | `getUiSession`                | invoke | src/preload/index.ts:306                                     | A-N17   | NEW    | —                 | Declared by ISSUE-059; its preload member is generated (ISSUE-045); unrouted until cut 1                                                  |
| `ui:session:patch`                | `patchUiSession`              | send   | src/preload/index.ts:308                                     | A-N18   | NEW    | —                 | Declared by ISSUE-059; its preload member is generated (ISSUE-045); unrouted until cut 1                                                  |
| `welcome:answer`                  | `answerWelcome`               | invoke | src/preload/index.ts:590                                     | A-N32   | NEW    | —                 | Declared by ISSUE-223 (AMENDMENT-7); its preload member is generated (ISSUE-045); unrouted until cut 2                                    |

### 14 §2.2 rows not in the tree

| Wire name              | Member                | Kind   | Found at  | 14 id | Status | Amendment request | Notes                                                                    |
| ---------------------- | --------------------- | ------ | --------- | ----- | ------ | ----------------- | ------------------------------------------------------------------------ |
| `mode:move`            | `moveToMode`          | invoke | not found | A-N13 | NEW    | —                 | Veta/Valle member, born `ui-local`; may never be routed `legacy` (21 §7) |
| `mode:transition`      | `onModeTransition`    | push   | not found | A-N14 | NEW    | —                 | Veta/Valle member, born `ui-local`; may never be routed `legacy` (21 §7) |
| `mode:transition:done` | `modeTransitionDone`  | send   | not found | A-N15 | NEW    | —                 | Veta/Valle member, born `ui-local`; may never be routed `legacy` (21 §7) |
| `veta:clickThrough`    | `setVetaClickThrough` | send   | not found | A-N22 | NEW    | —                 | Veta/Valle member, born `ui-local`; may never be routed `legacy` (21 §7) |
| `veta:layout`          | `layoutVeta`          | invoke | not found | A-N23 | NEW    | —                 | Veta/Valle member, born `ui-local`; may never be routed `legacy` (21 §7) |
| `window:limits`        | `getWindowingLimits`  | invoke | not found | A-N24 | NEW    | —                 | Veta/Valle member, born `ui-local`; may never be routed `legacy` (21 §7) |
| `veta:dock:changed`    | `onVetaDockChanged`   | push   | not found | A-N28 | NEW    | —                 | Veta/Valle member, born `ui-local`; may never be routed `legacy` (21 §7) |

<!-- reinventory-table:end -->
