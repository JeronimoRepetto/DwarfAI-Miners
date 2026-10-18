# Parity exceptions — step cut-4a

The step-4a switch (ISSUE-235, with ISSUE-234 folded in; `21` §2 cut 4a) moves the Settings family to the Host with its
target shape and no shape adapter: A-42, A-43, A-47, A-51 (KEEP), A-52…A-55 (CHANGE: `OpenCodeSettingsView`,
`IntegrationState` + `consentOrigin`, the password in the Host's `SecretStore`) and A-33 (the Reset saga alone). It ends
`ResetFanout`, `SettingsMirrorBridge` and `JevSettingsShapeAdapter`, switches today's OpenCode plugin installer and its
listener route off (the Host writes the plugin file and answers its asks, legacy-launched sessions' included), and opens
the OpenCode option of the first-run step and the boot legacy probe of the `opencode-plugin` target. OpenCode's launch,
send, stop and console rows and A-27, A-P3, A-P4 stay `legacy` until 4b. This file lists the step's evidence, every
intended difference and the soak record of the retirement (ISSUE-236).

## Step and internal build

| Field              | Value                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------- |
| Step               | `cut-4a`                                                                              |
| Internal build     | the merge commit of the ISSUE-235 PR (pending: the owner's internal build)            |
| Route-switch issue | ISSUE-235 (GitHub #948), with ISSUE-234 (GitHub #947)                                 |
| Pre-cut build      | the step-3e table as it shipped (`src/ui-main/ipc/testing/cut3eRoutes.ts`, ISSUE-188) |

## Parity suite and run evidence

The exit criteria of `21` §2 row 4a (`21-migration-plan.md:271`), each with its evidence run. Every issue that produces
the evidence is upstream of this switch (ISSUE-215, ISSUE-227…ISSUE-234, ISSUE-322, ISSUE-327).

| Exit item                                                                                       | Suite                                                                                                                                                                            | Command                                                                                  | OS                | Result                                    | Date       |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------- | ----------------------------------------- | ---------- |
| Settings parity, A-42, A-43, A-47, A-51 (KEEP) equal the legacy shape for the same inputs       | `src/ui-main/ipc/handlers/settingsParity.contract.test.ts` over the recorded `__fixtures__/settings-parity.legacy.json` (ISSUE-230)                                              | `pnpm vitest run src/ui-main/ipc/handlers`                                               | Windows           | passed                                    | 2026-10-18 |
| A-52…A-55 (CHANGE) map the Host's view; no shape adapter                                        | `openCodeSettings.host.contract.test.ts` (ISSUE-228), `openCodePassword.contract.test.ts` (ISSUE-231)                                                                            | same                                                                                     | Windows           | passed                                    | 2026-10-18 |
| Secret migration: seeded legacy file → Host `set`, file gone, never in a log; cleared → nothing | `src/legacy-bridge/secrets/secretMigrationBridge.test.ts`; `ipc-routing.contract.test.ts` `describe('OpenCode server password rows')` (log canary)                               | `pnpm vitest run src/legacy-bridge/secrets src/ui-main/ipc/ipc-routing.contract.test.ts` | Windows           | passed                                    | 2026-10-18 |
| `runSecretStoreContract` fake + real (L3, L8; Linux with and without Secret Service)            | `src/host/modules/preferences/testing/secretStore.contract.test.ts`; `OsKeyringSecretStore.os.test.ts`, `OsKeyringSecretStore.noSecretService.os.test.ts` (ISSUE-215, ISSUE-322) | `pnpm test:os`                                                                           | Windows (CI: all) | passed here; macOS and Linux: CI OS lane  | 2026-10-18 |
| `ExternalConfigWriter` contract for `opencode-plugin`                                           | `OpenCodePluginConfigWriter.test.ts`, `OpenCodePluginConfigWriter.os.test.ts` (ISSUE-227)                                                                                        | `pnpm vitest run src/host/modules/preferences`; `pnpm test:os`                           | Windows (CI: all) | passed here                               | 2026-10-18 |
| First-run step: OpenCode only → `offered: ['opencode-permissions']`; both → both; old-app file  | `src/host/modules/preferences/application/welcomeBoot.test.ts` (ISSUE-232); `src/host/wiring/bridges/hostConfigWriter.test.ts` (the 4a opening of the probe and the offer)       | `pnpm vitest run src/host/modules/preferences src/host/wiring/bridges`                   | Windows           | passed                                    | 2026-10-18 |
| OpenCode plugin asks of a legacy-launched session reach the Host broker (card only while on)    | `src/host/modules/asking/adapters/openCodePlugin/*.test.ts` (ISSUE-229); router case "the OpenCode plugin asks are not under the legacy-ask-channel qualifier"                   | `pnpm vitest run src/host/modules/asking src/ui-main/ipc/ipc-routing.contract.test.ts`   | Windows           | passed                                    | 2026-10-18 |
| Reset saga integration (`09` §6.5 "Reset scope", "Reset resume")                                | `src/host/wiring/flows/resetScope.flow.test.ts`, `resetScope.test.ts`, `resetResume.test.ts`, `src/host/platform/sqlite/resetScope.l5.test.ts` (ISSUE-233)                       | `pnpm vitest run src/host/wiring/flows src/host/platform/sqlite`                         | Windows           | passed                                    | 2026-10-18 |
| Router: the 4a table (TC-235-01, TC-235-02)                                                     | `src/ui-main/ipc/ipc-routing.contract.test.ts` `describe('release 4a (21 §2 cut 4a)')`                                                                                           | `pnpm vitest run src/ui-main/ipc`                                                        | Windows           | passed                                    | 2026-10-18 |
| Renderer: the Settings composables read the Host and hold no secret (ISSUE-234)                 | `src/renderer/src/composables/use{OpenCode,Jev,Notification}Settings.test.ts`, `useResetMetrics.test.ts`                                                                         | `pnpm vitest run src/renderer/src/composables`                                           | Windows           | passed                                    | 2026-10-18 |
| L9 E2E: OpenCode consent (Add panel origin), first-run with both tools, Reset metrics           | `e2e/cut-4a/opencode-consent.e2e.ts`, `first-run-both.e2e.ts`, `reset-metrics.e2e.ts`                                                                                            | `pnpm exec playwright test -c playwright.config.ts e2e/cut-4a`                           | Windows           | passed; macOS and Linux: CI release lanes | 2026-10-18 |
| L9 E2E: old-app plugin file accept/decline in the first-run step; Settings entry point          | not built as L9 here; covered at L2 by `welcomeBoot.test.ts` and `OpenCodePluginConfigWriter.test.ts` ("findLegacy … install replaces it … revert removes it")                   | —                                                                                        | —                 | pending (owner: release-lane case)        | —          |
| A Host killed during Reset step 4 completes at the next start (US-SET-010.AC07, CH-01)          | L2 `resetResume.test.ts`; the L9 fault point inside the saga does not exist in the harness                                                                                       | —                                                                                        | —                 | L2 passed; L9 pending                     | 2026-10-18 |

## Intended differences

| Behaviour                                        | Legacy build                                                                              | This step                                                                                                                                                                       | Decided by                                                     |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Jev candidate set ("Let Jev choose")             | as 3e: Claude, Codex (Antigravity in development builds)                                  | unchanged: OpenCode's launch rows are still `legacy`, so it is no candidate until 4b                                                                                            | `21` §2 cut 3 "Let Jev choose (each step)" row 4a              |
| Meaning of `on-verified` for the OpenCode plugin | today's relay: written, port opened                                                       | "written and read back" (no loaded signal in OpenCode 1.18.32); a person-run server loads it only for a project opened after the write                                          | S-011-1 (`spike-results/S-011-1.md`, Decision), ADR-011 item 2 |
| OpenCode server password at rest                 | `safeStorage` file in userData                                                            | moved once into the Host's OS `SecretStore` (`origin: 'migration'`), the file deleted after the Host confirmed; never shown, never logged                                       | ADR-017 items 1, 8; `21` §3 `SecretMigrationBridge`            |
| Settings store direction                         | today's store is the truth, `SettingsMirrorBridge` mirrors it into the Host               | the Host's preferences are the truth; the mirror is not composed                                                                                                                | `21` §3 (`SettingsMirrorBridge` 1–3e)                          |
| Reset metrics                                    | `ResetFanout`: today's reset, then the Host saga                                          | the Host saga alone, which wipes the ADR-023 scope (secrets included, OQ-12; the install moment, OQ-13; "Start with the system" back on, OQ-65)                                 | `21` §3 (`ResetFanout` 1–3e); ADR-023                          |
| A-51 stored model and effort                     | today's store re-checked the default model and effort against the launch gate             | the Host stores any model or effort string with a catalog provider (09 §4.8: never without a provider) and A-51 never answers `preferencesError`                                | ISSUE-230 (#1402) forward note; 09 §4.8; 14 §2.1 A-51          |
| OpenCode plugin file writer and asks             | today's installer (`restore()` at start) and today's loopback route feed `LegacyAskRelay` | the Host's `OpenCodePluginConfigWriter` and its plugin channel; today's half is not composed (`legacyOpenCodePluginComposed`)                                                   | `21` §1 item 4, §2 cut 4a; ADR-016; ADR-011                    |
| First-run step                                   | Claude Code only                                                                          | OpenCode offered and pre-selected when installed; the boot legacy probe includes `opencode-plugin`                                                                              | OQ-68; AMENDMENT-9, OQ-70; `07` S41.01, S41.02                 |
| A-53 refusal text in Settings                    | today's raw reason string beside the switch                                               | the switch stays off and the failure is kept in the composable; no reason line until design gives its words                                                                     | 25-AGENTS §8.1 (no invented copy); `21` §1 item 8              |
| Add panel OpenCode notice                        | none                                                                                      | drawn for a `gated-off` entry, "Turn on" (owner-approved copy 2026-10-18); in 4a OpenCode's entry still comes through `CatalogMergeAdapter` as `available`, so it shows from 4b | ADR-011 item 7, O-14; owner-approved copy 2026-10-18           |

## Routes moved in this step

Rows of `src/ui-main/ipc/routes.ts` this step changes (ids of `14-ipc-contract.md` §2).

| Row        | Qualifier            | Route before                                                                                              | Route after                                                   | Shape    |
| ---------- | -------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------- |
| A-33       | none                 | `legacy` through `ResetFanout` (cut 1)                                                                    | `host` (`preferences.resetMetrics`)                           | `target` |
| A-42, A-43 | none                 | `legacy` (pre-cut)                                                                                        | `host` (`preferences.get` / `.set`)                           | `target` |
| A-47       | none                 | `legacy` through `JevSettingsShapeAdapter` (3a)                                                           | `host` (`preferences.get`)                                    | `target` |
| A-51       | none                 | `legacy` (pre-cut)                                                                                        | `host` (`preferences.get`, `.set`)                            | `target` |
| A-52       | none                 | `legacy` (pre-cut), today's shape                                                                         | `host` (`preferences.get`)                                    | `target` |
| A-53       | none                 | `legacy` (pre-cut), today's shape                                                                         | `host` (`preferences.setOpenCodePermissions`, B-M14, born 4a) | `target` |
| A-54, A-55 | none                 | `legacy` (pre-cut), today's shape                                                                         | `host` (`settings.secret.set` / `.clear`)                     | `target` |
| A-40, A-41 | `legacy-ask-channel` | unchanged route; served only for person-launched Codex questions once today's OpenCode plugin half is off | unchanged                                                     | `target` |

## Spikes and variant recorded

| Spike   | Record                     | Outcome                                                                                             |
| ------- | -------------------------- | --------------------------------------------------------------------------------------------------- |
| SP-16   | `spike-results/SP-16.md`   | partial: Windows passed (`@napi-rs/keyring` 2.1.0); macOS and Linux pending (owner)                 |
| S-011-1 | `spike-results/S-011-1.md` | passed for OpenCode 1.18.32 on Windows: `on-verified` = written and read back; macOS, Linux not run |
| S-008-1 | `spike-results/S-008-1.md` | the keyring library's license and bundle decision                                                   |

Variant: the OpenCode plugin file written by the Host, `on-verified` meaning "written and read back"; OpenCode launched
by today's runtime until 4b.

## Soak record for the deletion

The step's retirement work unit (ISSUE-236) merges only after this internal build met the step's exit criteria on the
three OSes and then ran for 7 days of normal use with no blocking problem (the soak, OQ-71; owner 2026-10-18: one soak
at the end of cuts 3a–4b).

| Field                        | Value                                |
| ---------------------------- | ------------------------------------ |
| Exit criteria met on Windows | pending (owner: internal build)      |
| Exit criteria met on macOS   | pending (owner: CI lanes, SP-16 run) |
| Exit criteria met on Linux   | pending (owner: CI lanes, SP-16 run) |
| Soak build                   | pending                              |
| Soak start                   | pending                              |
| Soak end                     | pending                              |
| Blocking problems            | pending                              |
| Retirement or deletion issue | ISSUE-236                            |
