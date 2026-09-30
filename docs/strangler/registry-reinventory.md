# Registry re-inventory (pre-cut 0, P-3)

- **Found tree:** `1da74e8135da4e2844717b7c040aedec4b2dc19b` (main, 2026-09-30).
- **Scan date:** 2026-09-30.
- **Scanner:** `node scripts/checks/ipc-reinventory.mjs` (static, reads the files as text).
- **Checked by:** `pnpm vitest run scripts/checks/ipc-reinventory.test.mjs`.
- **Compared with:** `14-ipc-contract.md` §2.1, §2.2 and §7 of the architecture package. `14` is frozen and
  lives in the package, not in this repository.

This table records every `ipcMain` registration, preload member, main → renderer push and `IPC_CHANNELS`
constant of the found tree once, with the id and status `14` gives it (migration plan `21` §2, pre-cut 0 item
P-3; `14` §6.5 "Registry completeness"). A channel that `14` §2 does not list is `UNLISTED` with an
amendment-request id `AR-P3-nn`: it is raised with the owner and nothing is added for it anywhere.

## How to read it

- One row per channel, keyed by its wire name. The one preload helper with no wire is keyed by its member name.
- **Kind:** `invoke` (`ipcMain.handle`), `send` (`ipcMain.on`), `push` (`webContents.send`, preload `onX`) or
  `helper` (a preload member that makes no IPC call).
- **Found at:** every `file:line` where the channel appears (registration or push, preload member,
  `IPC_CHANNELS` constant). Line numbers are dated evidence of the found tree, like the counts of `14` §7. The
  test checks the wire name, member, kind and files of each row, not its line numbers.
- **14 id** and **Status:** as `14` §2.1 or §2.2 gives them (`KEEP`, `CHANGE`, `NEW`, `RETIRE`), or `UNLISTED`.
- The second table lists the `14` §2.2 rows that the found tree does not have yet. All of them are `NEW`.

## Candidate decision

No candidate: the scanner, its test and this table are new code. The found registrations, preload members and
pushes were evaluated against `14` §2 and none of them was changed.

## Counts

| Found in the tree                                 | KEEP | CHANGE | NEW | RETIRE | UNLISTED | Total |
| ------------------------------------------------- | ---- | ------ | --- | ------ | -------- | ----- |
| Request / one-way channels (`ipcMain` handlers)   | 32   | 16     | 0   | 9      | 2        | 59    |
| Pushes                                            | 2    | 0      | 0   | 4      | 0        | 6     |
| Preload helper without IPC                        | 1    | 0      | 0   | 0      | 0        | 1     |
| **Found total**                                   | 35   | 16     | 0   | 13     | 2        | 66    |
| `14` §2.2 NEW members not in the tree (2nd table) | —    | —      | 33  | —      | —        | 33    |

Against the dated `0bfd108` counts of `14` §7: the found tree has 59 registrations (57 + 2), 65 `IPC_CHANNELS`
constants (63 + 2) and 66 preload members (64 + 2). The two extra channels are `dwarf:setName` and
`dwarf:resetName`, the two `UNLISTED` rows. Every one of the 64 `14` §2.1 rows is found, with the member name and
kind `14` gives it.

## Notes

- **UNLISTED (AR-P3-01, AR-P3-02).** `dwarf:resetName` (`resetDwarfName`) and `dwarf:setName` (`setDwarfName`)
  have no `14` §2 row. `14` §8 I-21 records them (added by `93b7177`) but gives them no id or status, so they are
  raised as amendment requests. Nothing was added for them in any registry, handler or preload member.
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

| Wire name                        | Member                        | Kind   | Found at                                                                           | 14 id | Status   | Amendment request | Notes                                                                                             |
| -------------------------------- | ----------------------------- | ------ | ---------------------------------------------------------------------------------- | ----- | -------- | ----------------- | ------------------------------------------------------------------------------------------------- |
| `agent:answerPermission`         | `answerDwarfPermission`       | invoke | src/main/index.ts:1959<br>src/preload/index.ts:866<br>src/shared/contracts.ts:5371 | A-41  | CHANGE   | —                 |                                                                                                   |
| `agent:answerQuestion`           | `answerDwarfQuestion`         | invoke | src/main/index.ts:1954<br>src/preload/index.ts:830<br>src/shared/contracts.ts:5363 | A-40  | CHANGE   | —                 |                                                                                                   |
| `agent:launch`                   | `launchAgent`                 | invoke | src/main/index.ts:1852<br>src/preload/index.ts:732<br>src/shared/contracts.ts:5314 | A-35  | CHANGE   | —                 |                                                                                                   |
| `agent:launchFailed`             | `onLaunchFailed`              | push   | src/main/index.ts:1141<br>src/preload/index.ts:759<br>src/shared/contracts.ts:5322 | A-P3  | RETIRE   | —                 |                                                                                                   |
| `agent:launchHeld`               | `launchHeldSession`           | invoke | src/main/index.ts:1949<br>src/preload/index.ts:797<br>src/shared/contracts.ts:5362 | A-38  | RETIRE   | —                 |                                                                                                   |
| `agent:launchHosted`             | `launchHostedProcess`         | invoke | src/main/index.ts:1972<br>src/preload/index.ts:819<br>src/shared/contracts.ts:5385 | A-39  | CHANGE   | —                 |                                                                                                   |
| `agent:models`                   | `listAgentModels`             | invoke | src/main/index.ts:1873<br>src/preload/index.ts:778<br>src/shared/contracts.ts:5346 | A-37  | RETIRE   | —                 |                                                                                                   |
| `agent:providers`                | `listAgentProviders`          | invoke | src/main/index.ts:1863<br>src/preload/index.ts:775<br>src/shared/contracts.ts:5333 | A-36  | CHANGE   | —                 |                                                                                                   |
| `app:build`                      | `getAppBuild`                 | invoke | src/main/index.ts:1317<br>src/preload/index.ts:768<br>src/shared/contracts.ts:5254 | A-28  | KEEP     | —                 |                                                                                                   |
| `app:features`                   | `getFeatureFlags`             | invoke | src/main/index.ts:1322<br>src/preload/index.ts:769<br>src/shared/contracts.ts:5259 | A-29  | KEEP     | —                 |                                                                                                   |
| `audio:preferences:get`          | `getAudioPreferences`         | invoke | src/main/index.ts:1371<br>src/preload/index.ts:577<br>src/shared/contracts.ts:5079 | A-06  | KEEP     | —                 |                                                                                                   |
| `audio:preferences:set`          | `setAudioPreferences`         | invoke | src/main/index.ts:1372<br>src/preload/index.ts:583<br>src/shared/contracts.ts:5080 | A-07  | KEEP     | —                 |                                                                                                   |
| `dwarf:activate`                 | `activateDwarf`               | invoke | src/main/index.ts:1680<br>src/preload/index.ts:615<br>src/shared/contracts.ts:5091 | A-13  | CHANGE   | —                 |                                                                                                   |
| `dwarf:attachments:choose`       | `chooseDwarfAttachments`      | invoke | src/main/index.ts:1824<br>src/preload/index.ts:714<br>src/shared/contracts.ts:5228 | A-24  | KEEP     | —                 |                                                                                                   |
| `dwarf:attachments:describe`     | `describeDwarfAttachments`    | invoke | src/main/index.ts:1826<br>src/preload/index.ts:718<br>src/shared/contracts.ts:5240 | A-25  | KEEP     | —                 |                                                                                                   |
| `dwarf:feed`                     | `getDwarfFeed`                | invoke | src/main/index.ts:1684<br>src/preload/index.ts:618<br>src/shared/contracts.ts:5098 | A-14  | RETIRE   | —                 |                                                                                                   |
| `dwarf:feed:page`                | `getDwarfFeedPage`            | invoke | src/main/index.ts:1693<br>src/preload/index.ts:624<br>src/shared/contracts.ts:5111 | A-15  | CHANGE   | —                 |                                                                                                   |
| `dwarf:kick`                     | `kickDwarf`                   | invoke | src/main/index.ts:1841<br>src/preload/index.ts:723<br>src/shared/contracts.ts:5241 | A-26  | RETIRE   | —                 |                                                                                                   |
| `dwarf:refreshTelemetry`         | `refreshDwarfTelemetry`       | send   | src/main/index.ts:1711<br>src/preload/index.ts:639<br>src/shared/contracts.ts:5130 | A-17  | RETIRE   | —                 |                                                                                                   |
| `dwarf:resetName`                | `resetDwarfName`              | invoke | src/main/index.ts:1736<br>src/preload/index.ts:668<br>src/shared/contracts.ts:5158 | —     | UNLISTED | AR-P3-01          | Not in 14 §2 (named only in 14 §8 I-21); nothing added for it, it waits for the owner's amendment |
| `dwarf:retire`                   | `retireDwarf`                 | send   | src/main/index.ts:1980<br>src/preload/index.ts:766<br>src/shared/contracts.ts:5248 | A-27  | RETIRE   | —                 |                                                                                                   |
| `dwarf:sendText`                 | `sendDwarfText`               | invoke | src/main/index.ts:1818<br>src/preload/index.ts:692<br>src/shared/contracts.ts:5207 | A-23  | CHANGE   | —                 |                                                                                                   |
| `dwarf:sendText:settled`         | `onDwarfSendSettled`          | push   | src/main/index.ts:1150<br>src/preload/index.ts:695<br>src/shared/contracts.ts:5217 | A-P4  | RETIRE   | —                 |                                                                                                   |
| `dwarf:setName`                  | `setDwarfName`                | invoke | src/main/index.ts:1731<br>src/preload/index.ts:663<br>src/shared/contracts.ts:5157 | —     | UNLISTED | AR-P3-02          | Not in 14 §2 (named only in 14 §8 I-21); nothing added for it, it waits for the owner's amendment |
| `dwarf:setTuning`                | `setDwarfTuning`              | invoke | src/main/index.ts:1722<br>src/preload/index.ts:654<br>src/shared/contracts.ts:5147 | A-18  | RETIRE   | —                 |                                                                                                   |
| —                                | `pathForDroppedFile`          | helper | src/preload/index.ts:707                                                           | A-X1  | KEEP     | —                 |                                                                                                   |
| `jev:apiKey:clear`               | `clearJevApiKey`              | invoke | src/main/index.ts:1498<br>src/preload/index.ts:932<br>src/shared/contracts.ts:5456 | A-49  | KEEP     | —                 |                                                                                                   |
| `jev:apiKey:set`                 | `setJevApiKey`                | invoke | src/main/index.ts:1476<br>src/preload/index.ts:925<br>src/shared/contracts.ts:5455 | A-48  | KEEP     | —                 |                                                                                                   |
| `jev:preferences:set`            | `setJevPreferences`           | invoke | src/main/index.ts:1535<br>src/preload/index.ts:954<br>src/shared/contracts.ts:5478 | A-51  | KEEP     | —                 |                                                                                                   |
| `jev:route`                      | `routeJevLaunch`              | invoke | src/main/index.ts:1515<br>src/preload/index.ts:942<br>src/shared/contracts.ts:5469 | A-50  | CHANGE   | —                 |                                                                                                   |
| `jev:settings:get`               | `getJevSettings`              | invoke | src/main/index.ts:1473<br>src/preload/index.ts:917<br>src/shared/contracts.ts:5454 | A-47  | KEEP     | —                 |                                                                                                   |
| `launch-view:get`                | `getLaunchView`               | invoke | src/main/index.ts:1450<br>src/preload/index.ts:976<br>src/shared/contracts.ts:5499 | A-56  | KEEP     | —                 |                                                                                                   |
| `launch-view:set`                | `setLaunchView`               | send   | src/main/index.ts:1451<br>src/preload/index.ts:979<br>src/shared/contracts.ts:5500 | A-57  | KEEP     | —                 |                                                                                                   |
| `metrics:reset`                  | `resetMetrics`                | invoke | src/main/index.ts:1917<br>src/preload/index.ts:785<br>src/shared/contracts.ts:5297 | A-33  | CHANGE   | —                 |                                                                                                   |
| `mine:declare`                   | `declareMine`                 | invoke | src/main/index.ts:1892<br>src/preload/index.ts:770<br>src/shared/contracts.ts:5276 | A-30  | KEEP     | —                 |                                                                                                   |
| `mine:declare-main`              | `declareMainProject`          | invoke | src/main/index.ts:1896<br>src/preload/index.ts:772<br>src/shared/contracts.ts:5288 | A-31  | KEEP     | —                 |                                                                                                   |
| `mine:history`                   | `getMineHistory`              | invoke | src/main/index.ts:1743<br>src/preload/index.ts:672<br>src/shared/contracts.ts:5169 | A-19  | CHANGE   | —                 |                                                                                                   |
| `mine:openPath`                  | `openMinePath`                | invoke | src/main/index.ts:1754<br>src/preload/index.ts:677<br>src/shared/contracts.ts:5182 | A-20  | KEEP     | —                 |                                                                                                   |
| `mine:undeclare`                 | `undeclareMine`               | invoke | src/main/index.ts:1900<br>src/preload/index.ts:781<br>src/shared/contracts.ts:5289 | A-32  | KEEP     | —                 |                                                                                                   |
| `mines:get`                      | `getMines`                    | invoke | src/main/index.ts:1677<br>src/preload/index.ts:608<br>src/shared/contracts.ts:5089 | A-12  | RETIRE   | —                 |                                                                                                   |
| `mines:update`                   | `onMinesUpdated`              | push   | src/main/index.ts:1121<br>src/preload/index.ts:609<br>src/shared/contracts.ts:5090 | A-P2  | RETIRE   | —                 |                                                                                                   |
| `notifications:enabled:get`      | `getNotificationsEnabled`     | invoke | src/main/index.ts:1425<br>src/preload/index.ts:873<br>src/shared/contracts.ts:5394 | A-42  | KEEP     | —                 |                                                                                                   |
| `notifications:enabled:set`      | `setNotificationsEnabled`     | invoke | src/main/index.ts:1426<br>src/preload/index.ts:877<br>src/shared/contracts.ts:5395 | A-43  | KEEP     | —                 |                                                                                                   |
| `opencode:password:clear`        | `clearOpenCodeServerPassword` | invoke | src/main/index.ts:1609<br>src/preload/index.ts:973<br>src/shared/contracts.ts:5490 | A-55  | CHANGE   | —                 |                                                                                                   |
| `opencode:password:set`          | `setOpenCodeServerPassword`   | invoke | src/main/index.ts:1597<br>src/preload/index.ts:963<br>src/shared/contracts.ts:5489 | A-54  | CHANGE   | —                 |                                                                                                   |
| `opencode:plugin:set`            | `setOpenCodePluginEnabled`    | invoke | src/main/index.ts:1579<br>src/preload/index.ts:959<br>src/shared/contracts.ts:5488 | A-53  | CHANGE   | —                 |                                                                                                   |
| `opencode:settings:get`          | `getOpenCodeSettings`         | invoke | src/main/index.ts:1578<br>src/preload/index.ts:958<br>src/shared/contracts.ts:5487 | A-52  | CHANGE   | —                 |                                                                                                   |
| `panel:getAlwaysOnTop`           | `getAlwaysOnTop`              | invoke | src/main/index.ts:1340<br>src/preload/index.ts:566<br>src/shared/contracts.ts:5037 | A-03  | KEEP     | —                 |                                                                                                   |
| `panel:hide`                     | `hidePanel`                   | send   | src/main/index.ts:1333<br>src/preload/index.ts:564<br>src/shared/contracts.ts:5019 | A-01  | KEEP     | —                 |                                                                                                   |
| `panel:layout:get`               | `getPanelLayout`              | invoke | src/main/index.ts:1623<br>src/preload/index.ts:585<br>src/shared/contracts.ts:5045 | A-08  | KEEP     | —                 |                                                                                                   |
| `panel:layout:set`               | `setPanelLayout`              | invoke | src/main/index.ts:1624<br>src/preload/index.ts:593<br>src/shared/contracts.ts:5046 | A-09  | KEEP     | —                 |                                                                                                   |
| `panel:mine:show`                | `onShowMine`                  | push   | src/main/index.ts:923<br>src/preload/index.ts:884<br>src/shared/contracts.ts:5421  | A-P5  | RETIRE   | —                 |                                                                                                   |
| `panel:openMine`                 | `setOpenMine`                 | send   | src/main/index.ts:1443<br>src/preload/index.ts:882<br>src/shared/contracts.ts:5409 | A-44  | CHANGE   | —                 | 14 renames it to `reportVisibleMines` / `presence:visibleMines` within this CHANGE row            |
| `panel:raise`                    | `raisePanel`                  | send   | src/main/index.ts:1339<br>src/preload/index.ts:565<br>src/shared/contracts.ts:5031 | A-02  | KEEP     | —                 |                                                                                                   |
| `panel:setAlwaysOnTop`           | `setAlwaysOnTop`              | invoke | src/main/index.ts:1341<br>src/preload/index.ts:569<br>src/shared/contracts.ts:5038 | A-04  | KEEP     | —                 |                                                                                                   |
| `panel:visible:changed`          | `onPanelVisibility`           | push   | src/main/index.ts:878<br>src/preload/index.ts:571<br>src/shared/contracts.ts:5070  | A-P1  | KEEP     | —                 |                                                                                                   |
| `panel:visible:get`              | `getPanelVisible`             | invoke | src/main/index.ts:1362<br>src/preload/index.ts:570<br>src/shared/contracts.ts:5069 | A-05  | KEEP     | —                 |                                                                                                   |
| `panel:watchDwarfFeed`           | `setWatchedDwarf`             | send   | src/main/index.ts:1703<br>src/preload/index.ts:635<br>src/shared/contracts.ts:5120 | A-16  | RETIRE   | —                 |                                                                                                   |
| `projects:query`                 | `queryProjects`               | invoke | src/main/index.ts:1932<br>src/preload/index.ts:792<br>src/shared/contracts.ts:5308 | A-34  | KEEP     | —                 |                                                                                                   |
| `shell:copyText`                 | `copyText`                    | invoke | src/main/index.ts:1809<br>src/preload/index.ts:690<br>src/shared/contracts.ts:5206 | A-22  | KEEP     | —                 |                                                                                                   |
| `shell:openExternalLink`         | `openExternalLink`            | invoke | src/main/index.ts:1790<br>src/preload/index.ts:687<br>src/shared/contracts.ts:5199 | A-21  | KEEP     | —                 |                                                                                                   |
| `shortcut:get`                   | `getToggleShortcut`           | invoke | src/main/index.ts:1659<br>src/preload/index.ts:599<br>src/shared/contracts.ts:5087 | A-10  | KEEP     | —                 |                                                                                                   |
| `shortcut:set`                   | `setToggleShortcut`           | invoke | src/main/index.ts:1660<br>src/preload/index.ts:603<br>src/shared/contracts.ts:5088 | A-11  | KEEP     | —                 |                                                                                                   |
| `typography:preferences:changed` | `onTypographyPreferences`     | push   | src/main/index.ts:1409<br>src/preload/index.ts:905<br>src/shared/contracts.ts:5442 | A-P6  | KEEP     | —                 |                                                                                                   |
| `typography:preferences:get`     | `getTypographyPreferences`    | invoke | src/main/index.ts:1398<br>src/preload/index.ts:895<br>src/shared/contracts.ts:5440 | A-45  | KEEP     | —                 |                                                                                                   |
| `typography:preferences:set`     | `setTypographyPreferences`    | invoke | src/main/index.ts:1399<br>src/preload/index.ts:900<br>src/shared/contracts.ts:5441 | A-46  | KEEP     | —                 |                                                                                                   |

### 14 §2.2 rows not in the tree

| Wire name                         | Member                      | Kind   | Found at  | 14 id | Status | Amendment request | Notes                                                                                     |
| --------------------------------- | --------------------------- | ------ | --------- | ----- | ------ | ----------------- | ----------------------------------------------------------------------------------------- |
| `host:snapshot`                   | `getHostSnapshot`           | invoke | not found | A-N01 | NEW    | —                 |                                                                                           |
| `host:event`                      | `onHostEvent`               | push   | not found | A-N02 | NEW    | —                 |                                                                                           |
| `host:connection:get`             | `getHostConnection`         | invoke | not found | A-N03 | NEW    | —                 |                                                                                           |
| `host:connection:changed`         | `onHostConnection`          | push   | not found | A-N04 | NEW    | —                 |                                                                                           |
| `host:connection:retry`           | `retryHostConnection`       | invoke | not found | A-N05 | NEW    | —                 |                                                                                           |
| `dwarf:message:retry`             | `retryDwarfMessage`         | invoke | not found | A-N06 | NEW    | —                 |                                                                                           |
| `ask:step:set`                    | `setAskStep`                | invoke | not found | A-N07 | NEW    | —                 |                                                                                           |
| `dwarf:rename`                    | `renameDwarf`               | invoke | not found | A-N08 | NEW    | —                 | The found `dwarf:setName` (AR-P3-02) is a different, UNLISTED channel                     |
| `dwarf:name:reset`                | `resetDwarfName`            | invoke | not found | A-N09 | NEW    | —                 | Same member name as the found `dwarf:resetName` (AR-P3-01), a different, UNLISTED channel |
| `host:recovery:retry`             | `retryRecovery`             | invoke | not found | A-N10 | NEW    | —                 |                                                                                           |
| `host:recovery:dismiss`           | `dismissRecovery`           | invoke | not found | A-N11 | NEW    | —                 |                                                                                           |
| `ui:preferences:reset`            | `onUiPreferencesReset`      | push   | not found | A-N12 | NEW    | —                 |                                                                                           |
| `mode:move`                       | `moveToMode`                | invoke | not found | A-N13 | NEW    | —                 | Veta/Valle member, born `ui-local`; may never be routed `legacy` (21 §7)                  |
| `mode:transition`                 | `onModeTransition`          | push   | not found | A-N14 | NEW    | —                 | Veta/Valle member, born `ui-local`; may never be routed `legacy` (21 §7)                  |
| `mode:transition:done`            | `modeTransitionDone`        | send   | not found | A-N15 | NEW    | —                 | Veta/Valle member, born `ui-local`; may never be routed `legacy` (21 §7)                  |
| `mode:revealDwarfChat`            | `onRevealDwarfChat`         | push   | not found | A-N16 | NEW    | —                 | Veta/Valle member, born `ui-local`; may never be routed `legacy` (21 §7)                  |
| `ui:session:get`                  | `getUiSession`              | invoke | not found | A-N17 | NEW    | —                 |                                                                                           |
| `ui:session:patch`                | `patchUiSession`            | send   | not found | A-N18 | NEW    | —                 |                                                                                           |
| `ui:session:changed`              | `onUiSessionChanged`        | push   | not found | A-N19 | NEW    | —                 |                                                                                           |
| `ui:preferences:get`              | `getUiPreferences`          | invoke | not found | A-N20 | NEW    | —                 | Veta/Valle member, born `ui-local`; may never be routed `legacy` (21 §7)                  |
| `ui:preferences:set`              | `setUiPreference`           | invoke | not found | A-N21 | NEW    | —                 | Veta/Valle member, born `ui-local`; may never be routed `legacy` (21 §7)                  |
| `veta:clickThrough`               | `setVetaClickThrough`       | send   | not found | A-N22 | NEW    | —                 | Veta/Valle member, born `ui-local`; may never be routed `legacy` (21 §7)                  |
| `veta:layout`                     | `layoutVeta`                | invoke | not found | A-N23 | NEW    | —                 | Veta/Valle member, born `ui-local`; may never be routed `legacy` (21 §7)                  |
| `window:limits`                   | `getWindowingLimits`        | invoke | not found | A-N24 | NEW    | —                 | Veta/Valle member, born `ui-local`; may never be routed `legacy` (21 §7)                  |
| `tray:stopEverything:requested`   | `onStopEverythingRequested` | push   | not found | A-N25 | NEW    | —                 |                                                                                           |
| `tray:stopEverything:confirm`     | `confirmStopEverything`     | invoke | not found | A-N26 | NEW    | —                 |                                                                                           |
| `tray:stopEverything:cancel`      | `cancelStopEverything`      | send   | not found | A-N27 | NEW    | —                 |                                                                                           |
| `veta:dock:changed`               | `onVetaDockChanged`         | push   | not found | A-N28 | NEW    | —                 | Veta/Valle member, born `ui-local`; may never be routed `legacy` (21 §7)                  |
| `dwarf:stop`                      | `stopDwarf`                 | invoke | not found | A-N29 | NEW    | —                 |                                                                                           |
| `diag:renderer:report`            | `reportRendererDiagnostic`  | send   | not found | A-N30 | NEW    | —                 |                                                                                           |
| `claude:hooks:set`                | `setClaudeHooksEnabled`     | invoke | not found | A-N31 | NEW    | —                 |                                                                                           |
| `welcome:answer`                  | `answerWelcome`             | invoke | not found | A-N32 | NEW    | —                 |                                                                                           |
| `host:connection:confirm-restart` | `confirmHostRestart`        | invoke | not found | A-N33 | NEW    | —                 | Dormant in v1 (14 §2.2)                                                                   |

<!-- reinventory-table:end -->
