# Parity exceptions — step cut-3b

The step-3b switch (ISSUE-002; `21` §2 cut 3 row 3b) moves Codex's launch, send, console and stop rows to the Host,
qualified by provider exactly as 3a did for Claude. This file lists the step's evidence, every intended difference
with what decides it, and the owner-only runs still pending.

## Step and internal build

| Field              | Value                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Step               | `cut-3b`                                                                                                                    |
| Internal build     | branch `feat/issue-002-route-switch-3b` (ISSUE-002); the internal build artifact is recorded when it is made                |
| Route-switch issue | ISSUE-002                                                                                                                   |
| Pre-cut build      | the 3a table as it shipped (`src/ui-main/ipc/testing/cut3aRoutes.ts` pins it), over the step-3b Host of the issues upstream |

## Parity suite and run evidence

The exit list of step 3b (`21` §2 cut 3 row 3b "Parity / exit", `21-migration-plan.md:217`, with the common rules of
cut 3), each item with its criterion and its named evidence (TC-002-06). Every issue that produces this evidence is
upstream of the switch: ISSUE-152 (`CodexAppServerDriver`), ISSUE-153 (`CodexAcpDriver`), ISSUE-202 (the Codex
delegation entry) and ISSUE-001 (the 3a switch).

- **C-01…C-29 for the Codex drivers, C-23 included** (TC-002-02):
  `src/host/modules/suppliers/adapters/drivers/codex-app-server/CodexAppServerDriver.conformance.test.ts` (ISSUE-152,
  with ISSUE-202's `[C-23]` and `[C-24]` cases over `c-23-gated-delegation`: the gated entry carries a credential path
  and pre-approves exactly `delegate_subtask` and `subtask_result`, no token in argv or env) and
  `src/host/modules/suppliers/adapters/drivers/acp-codex/CodexAcpDriver.conformance.test.ts` (ISSUE-153). This switch
  adds one case to the first: on Windows an npm `codex` that resolves to its script entry is probed and launched by the
  person's `node` (ADR-029 row 8), as 3a did for Claude.
- **Launch parity per Codex launch failure** (TC-002-03): `src/legacy-bridge/parity/launchCauseParity.cut-3b.test.ts`
  "[ADR-020] each recorded Codex launch failure maps from its legacy reason to the ADR-020 cause listed in
  parity-cut-3b.md". Today's side is today's detached `codex exec` launch (`launchClaudeSession` over
  `runLaunchProcess` and its early-failure window) over a spawn double; the Host's side is the launching module's
  five-cause table. The mapping is the table under "Launch-cause mapping" below. The Codex recordings
  (`fixtures/codex/app-server-rpc/0.153.4/`, S-015-1 run 3 and SP-12) hold no launch failure, so every row is a
  situation both sides are driven through.
- **L2 flow launch → turn → ask → answer → turn end** (`15` §9.2): `src/host/wiring/flows/codex-step-3b.test.ts` over
  the C-06 recording (a command approval inside the first turn). **Pending**: the case fails on the current tree, see
  "Defect found by the step-3b flow" below. Crash recovery of a Codex session (ADR-015) is
  `src/host/wiring/flows/cut3aHost.test.ts` "[S4.18, CH-01] a Host rebuilt over the same DB resumes the owned session
  silently" (the C-16 recording); stop (ADR-014) is the provider-neutral `stopDwarf.test.ts`, `stopEverything.test.ts`
  and `stopAll.test.ts`.
- **L9 E2E with the Codex stub CLI** (`17` §1.9): `e2e/cut-3b/codex-launch.e2e.ts` (launch, send, a permission
  answered in the app, stop, all through the Host; the stub writes down its argv and its environment's names, and
  neither holds a delegation token). It drives `e2e/cut-3b/codexAppServerStub.mjs`, an interactive `codex app-server`
  stub (the kit's `fixtures/bin/codex` only replays a rollout and reads no stdin). Before the switch the case fails at
  the launch (A-35 reaches today's `codex exec`, refused).
- **Router cases** (TC-002-01): `src/ui-main/ipc/ipc-routing.contract.test.ts` `describe('release 3b (21 §2 cut 3b)')`
  and the 3b rollback case of `src/ui-main/ipc/rollbackTable.test.ts`.

| Suite                                     | Command                                                                                         | Internal build                   | OS                    | Result                | Date       |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------- | --------------------- | --------------------- | ---------- |
| Router cases, launch parity, Codex driver | `pnpm vitest run src/ui-main/ipc src/legacy-bridge src/host/modules/suppliers/adapters/drivers` | `feat/issue-002-route-switch-3b` | Windows               | passed                | 2026-10-18 |
| L9 E2E (Codex stub)                       | `pnpm exec playwright test -c playwright.config.ts e2e/cut-3b`                                  | `feat/issue-002-route-switch-3b` | Windows               | passed                | 2026-10-18 |
| L2 Codex flow                             | `pnpm vitest run src/host/wiring/flows/codex-step-3b.test.ts`                                   | `feat/issue-002-route-switch-3b` | Windows               | failed (defect below) | 2026-10-18 |
| The release lanes (TC-002-05)             | `pnpm test:e2e`, `pnpm test:os`                                                                 | the 3b internal build            | Windows, macOS, Linux | pending (owner)       |            |

## Launch-cause mapping

Copied from `src/legacy-bridge/parity/launchCauseParity.cut-3b.test.ts`, which fails on any pair this table does not
list. A row whose two sides differ is an intended difference.

| Failure                                      | Legacy reason     | Host cause (ADR-020 D1) | Decided by               |
| -------------------------------------------- | ----------------- | ----------------------- | ------------------------ |
| `codex` not found                            | `not-installed`   | `not-installed`         | ADR-020 D1 cause 1       |
| The OS refuses the spawn (`EACCES`)          | `could-not-start` | `could-not-start`       | ADR-020 item 3           |
| The OS refuses the spawn (`ENOENT`)          | `could-not-start` | `not-installed`         | ADR-020 item 4; 07 S5.16 |
| Exits non-zero inside the 3 s window         | `exited-at-once`  | `exited-at-once`        | ADR-020 D4               |
| Exits cleanly inside the 3 s window          | none (`launched`) | `exited-at-once`        | ADR-020 D4; 15 §4.4      |
| Exits after the window, never ready          | none (`launched`) | `could-not-start`       | ADR-020 item 4; 07 S5.20 |
| Never ready (no handshake within its budget) | none (`launched`) | `could-not-start`       | ADR-020 item 4           |

Today's `codex exec` is one-shot: a clean exit is its turn finishing, and it has no readiness handshake. The Host's
`codex app-server` is a held server, so any end before it is ready is the launch failing.

## Intended differences

| Behaviour                                                                                        | Legacy build                                                                                                       | This step                                                                                                                                                                                                                                            | Decided by                                         |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| How Codex is launched                                                                            | a detached one-shot `codex exec` per message; a later message relaunches it (`codexResume.ts`, the queue relaunch) | one `codex app-server` process per session, held by the Host; each message is a `turn/start` on the same thread (`CodexAppServerDriver`, preferred; `CodexAcpDriver` over a user-installed `codex-acp` when the probe finds no `app-server` command) | ADR-009 D4; `21` §2 row 3b                         |
| Delegation entry of a Codex launch                                                               | `-c mcp_servers.jev.env={…token…}` in argv (the token in the command line)                                         | the path-only `ticket-file` entry: `-c mcp_servers.jev.*` names the relay and a credential file path, and pre-approves only `delegate_subtask` and `subtask_result`; no token in argv or env (C-23, C-24)                                            | ADR-013 items 1, 3, 8; SP-12 (value `ticket-file`) |
| The legacy test that pins the token in argv (`delegationInjection.test.ts:175-178` at `0bfd108`) | runs                                                                                                               | replaced by C-23 of the Codex drivers; the legacy test stays in the tree until ISSUE-185 deletes its subject with it, removed visibly with a `docs/test-removals.md` entry (`17` §2.6)                                                               | ADR-013 item 8; `21` §2 row 3b                     |
| "Let Jev choose" candidates                                                                      | Claude (3a)                                                                                                        | Claude, Codex (`suppliers.launchable()`); OpenCode and Antigravity stay launchable by hand only                                                                                                                                                      | `21` §2 "Let Jev choose (each step)"; OI-21-4      |
| Launch failures                                                                                  | the reason of today's verdict or early-failure window                                                              | the five ADR-020 causes, each with Retry (table above)                                                                                                                                                                                               | ADR-020                                            |
| A Codex session after the window closes or a tray Quit                                           | ended with the app for a held session; a detached `exec` ran to its end                                            | keeps running in the Host; resumed silently after a Host crash (`thread/resume`), none after a reboot                                                                                                                                                | OQ-44, OQ-29, OQ-55; ADR-015                       |
| Adopting a Codex session the Host did not launch                                                 | not offered                                                                                                        | not offered: `adopt: false` in v1 (the Codex daemon is Unix-only)                                                                                                                                                                                    | S-015-1 (failed); ADR-015 item 5                   |
| Questions of person-launched (observed) Codex sessions                                           | answered through today's runtime                                                                                   | still answered through `LegacyAskRelay` (origin `legacy-ask-channel`) until the end of cut 4; the legacy feed keeps listing those sessions for it (`legacy-launched-or-pending-questions`)                                                           | `21` §2 cut 2 "Qualified routes"; ADR-011 item 4   |
| Codex sessions today's runtime launched before the step                                          | stoppable through today's runtime                                                                                  | still listed by the legacy feed and ended by `LegacyEndFirstAdapter` before `crew.stop` (A-N29, A-32, A-N26); never re-adopted as owned                                                                                                              | `21` §3; ADR-015                                   |
| A-27, A-P3, A-P4 for a Codex dwarf                                                               | served by today's runtime                                                                                          | no route: their successors are `dwarf.departed` (B-F10), `launch.failed` (B-F19) and `message.delivery` (B-F12)                                                                                                                                      | `21` §2 cut 3 common rules                         |
| A Windows npm `codex` (a `codex.cmd` shim)                                                       | started through today's shim reader                                                                                | the shim's script entry is started by the person's `node`; no shell (R17)                                                                                                                                                                            | ADR-029 row 8; ADR-009 D5                          |

## Routes moved in this step

Rows of `src/ui-main/ipc/routes.ts` this step changes (ids of `14-ipc-contract.md` §2).

| Row              | Qualifier         | Route before                               | Route after                                      | Shape  |
| ---------------- | ----------------- | ------------------------------------------ | ------------------------------------------------ | ------ |
| A-35 (and Retry) | `provider: codex` | `legacy` through `PerProviderShapeAdapter` | `host` (`launching.launch`, B-M33)               | target |
| A-36             | `provider: codex` | `legacy` through `CatalogMergeAdapter`     | `host` (`suppliers.launchable`, B-M37)           | target |
| A-23             | `provider: codex` | `legacy` through `PerProviderShapeAdapter` | `host` (`conversation.send`, B-M24)              | target |
| A-13             | `provider: codex` | `legacy` through `PerProviderShapeAdapter` | `host` (`conversation.resolveConsole`, B-M29)    | target |
| A-N29            | none              | `host` since 3a, every dwarf               | unchanged: its one `host` route serves Codex too | target |
| A-27, A-P3, A-P4 | `provider: codex` | `legacy`                                   | no route (Antigravity and OpenCode keep theirs)  | today  |

No seam B member and no NEW row is born in 3b; `unrouted.ts` is unchanged. The legacy feed's Codex mode moves from
`discover` to `legacy-launched-or-pending-questions` (switched off in legacy: Codex's discovery of sessions the Host
observes). A 3b rollback build is the 3a table again (`docs/strangler/rollback.md` "Step 3b note").

## Spikes and variant recorded

| Spike   | Record                     | Outcome                                                                                                                          |
| ------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| SP-12   | `spike-results/SP-12.md`   | partial (Windows only): the argv half holds; `mcpInjection` stays `ticket-file` for Codex `app-server-rpc`, the env half is R-16 |
| S-008-1 | `spike-results/S-008-1.md` | `codex-acp` 0.16.0 not bundled, user-installed (owner, 2026-10-16); not blocking for 3b                                          |
| S-015-1 | `spike-results/S-015-1.md` | failed: no adopt of the Codex daemon; Codex `adopt: false` in v1, recovery is `thread/resume`                                    |

Variant: **Codex launched through `CodexAppServerDriver`** where the person's `codex` has the `app-server` command, and
through `CodexAcpDriver` where it has not and a user-installed `codex-acp` resolves. Delegation entry form:
`ticket-file` (the path-only relay entry), not `protocol`.

## Defect found by the step-3b flow

`src/host/wiring/flows/codex-step-3b.test.ts` fails on the current tree: when a Codex launch's first turn raises an
approval request in the same read as the turn's first notifications (the C-06 recording), the ask is lost. The launch
binds the session's event channel, which flushes the buffered events, before it records the session as owned
(`src/host/modules/launching/application/launch.ts`, `succeed()`: `bindings.bind(ref, dwarfId)` runs before
`ownSession(…)`). The buffered `ask.opened` then meets a dwarf that is not owned yet, is classified as an observed
request the provider cannot detect (`asking/application/askBroker.ts` `open`, 07 S1.17) and is dropped with an
`uncaught` log line, so the provider waits on an answer nobody can give. Binding after `ownSession` makes the flow pass
and keeps the launching suites green (checked locally, not committed: the file is outside this issue's lane). The E2E
case does not meet it, because its ask comes on a later turn. Until it is fixed the flow evidence above is pending.

## Pending, owner-only

Items of the step's exit that neither CI nor an agent can complete (AGENTS §0.3). Each is filled in this file when its
run exists.

- **TC-002-05, the 3b internal build on Windows, macOS and Linux:** the Codex flows, C-01…C-29 of both Codex drivers,
  C-23, C-24 and the Codex E2E in the release lanes, each run linked in the table above.
- **The real-CLI lane** (`pnpm test:real-cli`, `17` §5.5): a launch, a send, a permission and a stop against the
  person's own `codex` on each OS, on the maintainer's machine with the person's own login; never CI, never an agent.
- **A-13 "Open console" live check per OS** for a Host-launched Codex dwarf (ADR-031).
- **SP-12 on macOS and Linux**, or the owner's waiver for this internal step.
- **The soak** (OQ-71), below.

| Item                    | OS      | Run by and date | Evidence |
| ----------------------- | ------- | --------------- | -------- |
| 3b internal build lanes | Windows |                 |          |
| 3b internal build lanes | macOS   |                 |          |
| 3b internal build lanes | Linux   |                 |          |
| Real-CLI lane           | Windows |                 |          |
| Real-CLI lane           | macOS   |                 |          |
| Real-CLI lane           | Linux   |                 |          |
| A-13 console live check | Windows |                 |          |
| A-13 console live check | macOS   |                 |          |
| A-13 console live check | Linux   |                 |          |
| SP-12 gate decision     | —       |                 |          |

## Soak record for the deletion

The step's deletion work unit (ISSUE-185: the legacy Codex detached launch, `codexResume.ts` and the queue relaunch
path, the `-c mcp_servers.jev.env={…token…}` builder, and with it the legacy test that pins the token in argv)
merges only after this internal build met the step's exit criteria on the three OSes and then ran for 7 days of normal
use with no blocking problem (the soak, OQ-71).

| Field                        | Value     |
| ---------------------------- | --------- |
| Exit criteria met on Windows |           |
| Exit criteria met on macOS   |           |
| Exit criteria met on Linux   |           |
| Soak build                   |           |
| Soak start                   |           |
| Soak end                     |           |
| Blocking problems            |           |
| Retirement or deletion issue | ISSUE-185 |
