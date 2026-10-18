# Parity exceptions — step cut-4b

The step-4b switch (ISSUE-238; `21` §2 cut 4b) is the last provider step. OpenCode's launch (A-35 with its Retry path),
catalog (A-36), send (A-23) and console (A-13) rows move to the Host, qualified by provider as every provider step did
(A-N29's one `host` route already serves every dwarf). The Host launches OpenCode itself through its `acp` entry and reads
its own `opencode-permissions` state for each permission request: a card while it is `on-verified`, denied by the Host
with one chat line otherwise. No provider is left for `PerProviderShapeAdapter` or `CatalogMergeAdapter`, so the
unqualified routes of A-13, A-23, A-35 and A-36 are the Host's too, and A-27, A-P3 and A-P4 are retired with no route.
This file lists the step's evidence, every intended difference and the soak record of the deletions (ISSUE-239…ISSUE-241).

## Step and internal build

| Field              | Value                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------- |
| Step               | `cut-4b`                                                                              |
| Internal build     | the merge commit of the ISSUE-238 PR (pending: the owner's internal build)            |
| Route-switch issue | ISSUE-238 (GitHub #951)                                                               |
| Pre-cut build      | the step-4a table as it shipped (`src/ui-main/ipc/testing/cut4aRoutes.ts`, ISSUE-235) |

## Parity suite and run evidence

The exit list of `21` §2 row 4b (`21-migration-plan.md:282`), each item with its evidence run (TC-238-05). Every issue
that produces the evidence is upstream of this switch: ISSUE-155 (the OpenCode drivers and their conformance), ISSUE-203
(C-23 for the OpenCode driver), ISSUE-229 (the OpenCode plugin asks), ISSUE-235 (4a), ISSUE-237 (the person-run server
attach), ISSUE-325 (SP-14) and the S-031-3 record.

| Exit item                                                                                                                        | Suite                                                                                                                                                                                                | Command                                                                                                  | OS      | Result                                                     | Date       |
| -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------- | ---------- |
| C-01…C-29 for the chosen driver (OpenCode `acp`, the generic `AcpDriver` with `OPENCODE_ACP`)                                    | `src/host/modules/suppliers/adapters/drivers/acp/OpenCodeAcp.conformance.test.ts` (ISSUE-155), its inapplicable cases named in the suite                                                             | `pnpm vitest run src/host/modules/suppliers/adapters/drivers`                                            | Windows | passed                                                     | 2026-10-18 |
| C-27 for `off`, `on-unverified`, `on-verified`                                                                                   | same suite, "[C-27] with the integration off, on-unverified and on-verified …" and "[C-27, ADR-011] with the gate closed …"                                                                          | same                                                                                                     | Windows | passed                                                     | 2026-10-18 |
| C-23: no delegation token in env or configuration (`OPENCODE_CONFIG_CONTENT` not built by the Host)                              | same suite (C-23 case, the path-only `ticket-file` relay entry of SP-12, ISSUE-203); L2 `src/host/wiring/flows/opencode-step-4b.test.ts` (no token, no `OPENCODE_CONFIG_CONTENT` in the agent's env) | `pnpm vitest run src/host/modules/suppliers src/host/wiring/flows/opencode-step-4b.test.ts`              | Windows | passed                                                     | 2026-10-18 |
| The Host reads its own `opencode-permissions` state: a card while `on-verified`, auto-denied with one chat line otherwise        | L2 `src/host/wiring/flows/opencode-step-4b.test.ts` (both cases; break-checked: a gate answering `on-verified` always opens a card while off); L9 `e2e/cut-4b/opencode-launch.e2e.ts`                | `pnpm vitest run src/host/wiring/flows/opencode-step-4b.test.ts`; `pnpm exec playwright test e2e/cut-4b` | Windows | passed; macOS and Linux: CI release lanes                  | 2026-10-18 |
| No legacy plugin channel answers: one answerer                                                                                   | router case "in 4b no legacy launch, send or stop row remains …" (`legacyOpenCodePluginComposed` false; since 4a)                                                                                    | `pnpm vitest run src/ui-main/ipc`                                                                        | Windows | passed                                                     | 2026-10-18 |
| Launch outcomes as for every provider step                                                                                       | `src/legacy-bridge/parity/launchCauseParity.cut-4b.test.ts` (the table below)                                                                                                                        | `pnpm vitest run src/legacy-bridge/parity`                                                               | Windows | passed                                                     | 2026-10-18 |
| Router: A-27, A-P3, A-P4 have no handler; no legacy launch, send or stop row remains (TC-238-01)                                 | `src/ui-main/ipc/ipc-routing.contract.test.ts` `describe('release 4b (21 §2 cut 4b)')`                                                                                                               | `pnpm vitest run src/ui-main/ipc`                                                                        | Windows | passed                                                     | 2026-10-18 |
| A-36 relayed from the Host whole                                                                                                 | `src/ui-main/ipc/handlers/listAgentProviders.host.contract.test.ts`                                                                                                                                  | same                                                                                                     | Windows | passed                                                     | 2026-10-18 |
| L9 E2E with the OpenCode stub: launch, send, a card while `on-verified`, auto-deny with one line while off, stop; Jev candidates | `e2e/cut-4b/opencode-launch.e2e.ts` (an ACP stub `opencode`, `e2e/cut-4b/opencodeAcpStub.mjs`)                                                                                                       | `pnpm exec playwright test -c playwright.config.ts e2e/cut-4b`                                           | Windows | passed; macOS and Linux: CI release lanes                  | 2026-10-18 |
| L9 E2E: the Add panel's OpenCode notice and its real "Turn on" (4a's case, now through the Host's `gated-off` entry)             | `e2e/cut-4a/opencode-consent.e2e.ts`                                                                                                                                                                 | `pnpm exec playwright test -c playwright.config.ts e2e/cut-4a`                                           | Windows | passed                                                     | 2026-10-18 |
| Real OpenCode CLI (`opencode acp` 1.18.32 or later) launched by the Host                                                         | the real-CLI lane (`17` §5.5)                                                                                                                                                                        | `pnpm test:real-cli`                                                                                     | —       | pending (owner: real-CLI lane on the maintainer's machine) | —          |

### Launch-cause mapping (ADR-020)

The SP-12 recording (`fixtures/opencode/acp/1.18.32/`) holds no launch failure, so every row is a situation both sides
are driven through (today's detached one-shot `opencode run --format json`; the launching module's five-cause table).

| Failure                     | Legacy reason     | ADR-020 cause     | Decided by               |
| --------------------------- | ----------------- | ----------------- | ------------------------ |
| CLI absent                  | `not-installed`   | `not-installed`   | ADR-020 D1 cause 1       |
| Spawn refused (`EACCES`)    | `could-not-start` | `could-not-start` | ADR-020 item 3           |
| Spawn refused (`ENOENT`)    | `could-not-start` | `not-installed`   | ADR-020 item 4; 07 S5.16 |
| Fails inside the window     | `exited-at-once`  | `exited-at-once`  | ADR-020 D4               |
| Exits cleanly in the window | none (launched)   | `exited-at-once`  | ADR-020 D4; 15 §4.7      |
| Exits after the window      | none (launched)   | `could-not-start` | ADR-020 item 4; 07 S5.20 |
| Never ready                 | none (launched)   | `could-not-start` | ADR-020 item 4           |

## Intended differences

| Behaviour                                                 | Legacy build                                                                                   | This step                                                                                                                                                                                                                          | Decided by                                                          |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| OpenCode driver                                           | today's detached one-shot `opencode run --format json`, the token in `OPENCODE_CONFIG_CONTENT` | the person's own `opencode acp` through the generic `AcpDriver` (ADR-009 D4 option (c)), held by the Host; the relay entry is the path-only `ticket-file` (SP-12), no token in env or config                                       | S-031-3 (failed: no Host-launched `opencode serve`); SP-12; ADR-013 |
| "Let Jev choose" candidates                               | as 4a: Claude, Codex (Antigravity in development builds)                                       | every launchable provider, OpenCode included: the narrowing of 3a…4a ends                                                                                                                                                          | `21` §2 cut 3 "Let Jev choose (each step)" row 4b                   |
| OpenCode permission requests                              | answered through today's plugin relay or not at all                                            | a card while `opencode-permissions` is `on-verified`; otherwise denied by the Host (`reject_once`) with one chat line, no card                                                                                                     | ADR-011 items 3, 7; `21` §2 cut 4b                                  |
| A-36 catalog                                              | `CatalogMergeAdapter`: the moved providers' Host entries, today's catalog for OpenCode         | the Host's `suppliers.launchable` whole; OpenCode's entry carries its own `answerChannel`, so the Add panel's OpenCode notice now shows while the integration is off                                                               | `21` §3.1 (`CatalogMergeAdapter` 3a–4b); ADR-011 item 7; O-14       |
| A call of A-13, A-23 or A-35 naming no qualified provider | `PerProviderShapeAdapter` sent it to today's runtime                                           | the Host answers it (the unqualified route is `host`): a development build's simulated provider, a "Let Jev choose" launch, and a public build's gated provider, whose launch its Host refuses (no gated driver in a public build) | `21` §3.1; ADR-009 D5, D6                                           |
| A-27, A-P3, A-P4                                          | today's handlers for OpenCode                                                                  | retired, no route and no handler; successors `dwarf.departed` (B-F10), `launch.failed` (B-F19), `message.delivery` (B-F12); handlers deleted by ISSUE-239                                                                          | `21` §2 cut 3 common rules, cut 4b                                  |
| Ending one OpenCode turn                                  | today's runtime ends the one-shot process                                                      | the ACP `session/cancel` of the Host's own `opencode acp`; on a person-run `opencode serve` the abort is `POST /session/{id}/abort` (SP-14), the server never signalled                                                            | SP-14; ADR-014                                                      |
| A session today's runtime launched before 4b              | ended by today's runtime                                                                       | stays an observed session; "Stop dwarf…", Remove mine and Stop everything still end it through `LegacyEndFirstAdapter` until ISSUE-241                                                                                             | `21` §2 cut 3 common rules; §3 `LegacyEndFirstAdapter`              |

Recorded now for ISSUE-241 (the end of cut 4, not this switch): once `LegacyDwarfIdBridge`, `LegacyEndFirstAdapter`,
`LegacyAgentRegistryFeed`, `LegacyAskRelay` and `LegacyAnswerShapeAdapter` are deleted, questions of person-launched Codex
sessions follow the target rule (no card, ADR-011 item 4), and a session the old app launched that is still alive can no
longer be ended by DwarfAI (`15` §5 `no-identity`).

## Routes moved in this step

Rows of `src/ui-main/ipc/routes.ts` this step changes (ids of `14-ipc-contract.md` §2).

| Row                      | Qualifier            | Route before                                            | Route after                                                         | Shape    |
| ------------------------ | -------------------- | ------------------------------------------------------- | ------------------------------------------------------------------- | -------- |
| A-13, A-23, A-35 (Retry) | `provider: opencode` | none: the unqualified route below served it             | `host` (`conversation.resolveConsole`, `.send`, `launching.launch`) | `target` |
| A-13, A-23, A-35 (Retry) | none                 | `legacy` through `PerProviderShapeAdapter` (3a)         | `host` (same members)                                               | `target` |
| A-36                     | `provider: opencode` | none: `CatalogMergeAdapter` read today's catalog for it | `host` (`suppliers.launchable`)                                     | `target` |
| A-36                     | none                 | `legacy` through `CatalogMergeAdapter` (3a)             | `host` (`suppliers.launchable`, the entries whole)                  | `target` |
| A-27, A-P3, A-P4         | `provider: opencode` | `legacy`, today's shape (3a)                            | none: retired (`RETIRED`, `cut-4b`)                                 | —        |
| A-N29                    | none                 | `host` since 3a (through `LegacyEndFirstAdapter`)       | unchanged                                                           | `target` |

No seam B member and no NEW row is born in 4b (`21` §2 seam-B table row 4b), so `src/contracts/ipc/unrouted.ts`'s
unrouted list is 4a's; its `RETIRED` list gains A-27, A-P3 and A-P4.

## Spikes and variant recorded

| Spike   | Record                     | Outcome                                                                                                                                                                                               |
| ------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S-031-3 | `spike-results/S-031-3.md` | failed at OpenCode 1.18.32: the server password goes only through argv or env and `opencode serve` has no owner-only endpoint, so the Host launches OpenCode through `acp` (option (c)); not blocking |
| SP-14   | `spike-results/SP-14.md`   | passed on Windows at 1.18.32: `POST /session/{id}/abort?directory=<cwd>` ends one session's turn and leaves the shared server running; macOS and Linux not run (no limitation recorded)               |
| SP-12   | `spike-results/SP-12.md`   | the path-only `ticket-file` relay entry in `session/new.mcpServers` (foreman ruling 2026-10-17)                                                                                                       |
| S-011-1 | `spike-results/S-011-1.md` | `on-verified` = written and read back (as 4a)                                                                                                                                                         |

Variant: OpenCode launched by the Host through `opencode acp`; `OpenCodeServerDriver` is not attached to the launch
registry (its probe reports `launch: false`, FM-084, and launching takes the registry's first driver), so its person-run
attach (ISSUE-237) has no caller in this build: the person-run server's permission answers go through the asking
module's OpenCode plugin channel, with the stored password, since 4a.

## Soak record for the deletion

The step's deletion work units (ISSUE-239, ISSUE-240, ISSUE-241) merge only after this internal build met the step's
exit criteria on the three OSes and then ran for 7 days of normal use with no blocking problem (the soak, OQ-71; owner
2026-10-18: one soak at the end of cuts 3a–4b, then every retirement and cut 5 in a row).

| Field                        | Value                                    |
| ---------------------------- | ---------------------------------------- |
| Exit criteria met on Windows | pending (owner: internal build)          |
| Exit criteria met on macOS   | pending (owner: CI lanes, real-CLI lane) |
| Exit criteria met on Linux   | pending (owner: CI lanes, real-CLI lane) |
| Soak build                   | pending                                  |
| Soak start                   | pending                                  |
| Soak end                     | pending                                  |
| Blocking problems            | pending                                  |
| Retirement or deletion issue | ISSUE-239, ISSUE-240, ISSUE-241          |
