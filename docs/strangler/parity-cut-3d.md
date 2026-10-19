# Parity exceptions — step cut-3d

The step-3d switch (ISSUE-186; `21` §2 cut 3 row 3d) moves A-39 `launchHostedProcess` to the Host
(`launching.launchCustom`, B-M34) with its target shape, and the "Other…" dwarfs' launch, send and console rows (A-35
with its Retry path, A-23, A-13) to the Host, qualified by the "Other…" driver's provider id. An "Other…" command now
runs as a Host-owned session that no longer dies with the window. This file lists the step's evidence, every intended
difference with what decides it, and the owner-only runs still pending.

## Step and internal build

| Field              | Value                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Step               | `cut-3d`                                                                                                                    |
| Internal build     | branch `feat/issue-186-route-switch-3d` (ISSUE-186); the internal build artifact is recorded when it is made                |
| Route-switch issue | ISSUE-186                                                                                                                   |
| Pre-cut build      | the 3b table as it shipped (`src/ui-main/ipc/testing/cut3bRoutes.ts` pins it), over the step-3d Host of the issues upstream |

## Parity suite and run evidence

The exit list of step 3d (`21` §2 cut 3 row 3d "Parity / exit", `21-migration-plan.md:218`, with the common rules of
cut 3), each item with its criterion and its named evidence (TC-186-04). Every issue that produces this evidence is
upstream of the switch: ISSUE-157 (`HostedCommandDriver`), ISSUE-165 (`launching.launchCustom`, B-M34, and the "Other…"
flows), ISSUE-182 (the wired Host the flows boot) and ISSUE-002 (the 3b switch).

- **C-01…C-05, C-18, C-28, C-29 for `HostedCommandDriver`** (TC-186-02):
  `src/host/modules/suppliers/adapters/drivers/hosted-command/HostedCommandDriver.conformance.test.ts` (ISSUE-157):
  the generic `driverConformance` cases C-01…C-05, C-18, C-28, C-29 and the driver's own cases (`[C-01, NFR-SEC-09]`
  the argv array with no shell, `[C-03]` the refusals that spawn nothing, `[C-04]` the 2 999 ms / 3 000 ms boundary,
  `[C-05]` stdin and the captured output, `[C-18]` the output end and the exit, `[C-28]` close, `[C-29]` onSpawned).
- **`hostedCommand.test.ts` unchanged** (no shell, metacharacters refused, ADR-020 D3):
  `src/host/modules/launching/domain/hostedCommand.test.ts`, moved whole by ISSUE-165 and not edited since (`git log`
  of the file shows its one commit); this switch does not touch it.
- **L2 flows**: `src/host/wiring/flows/launchOther.test.ts` (ISSUE-165) proves the launch (`[US-OBS-007.AC05, S5.21]`
  a valid custom command launches and its dwarf appears in the mine), the refusals (`S5.17`, `S5.16`), the sameness
  with a supplier dwarf (`US-OBS-007.AC04`, `US-LAUNCH-002.AC08`, `BR-08`) and INV-43. The case it lacked for row 3d,
  the window closed during the session, is `src/host/wiring/flows/other-step-3d.test.ts` "[ADR-001, US-OBS-007.AC05] an
  Other session launched through the Host survives closing the window and is there when it reopens", over the wired
  Host (`flows/testing/cut3aHost.ts`, which now composes `HostedCommandDriver` as `host/main.ts` does). Shortening the
  program's life to 30 s makes it fail (its dwarf departs), so it bites.
- **L9 E2E** (`17` §1.9): `e2e/cut-3d/other-launch.e2e.ts` "[ADR-001] an Other session launched through the Host
  survives closing the window": the renderer's A-39 starts `e2e/cut-3d/otherCommandStub.mjs` through node, the dwarf is
  Owned, the app quits (the window closes, the Host stays) and the stub keeps running, and the app reopened on the same
  profile shows the same dwarf over the same process.
- **Router cases** (TC-186-01): `src/ui-main/ipc/ipc-routing.contract.test.ts` `describe('release 3d (21 §2 cut 3d)')`,
  the A-39 host handler's L6 suite `src/ui-main/ipc/handlers/launchCustom.host.contract.test.ts`, and the 3d rollback
  case of `src/ui-main/ipc/rollbackTable.test.ts`. Leaving A-39 `legacy` makes the first router case fail.

| Suite                                     | Command                                                                                                                              | Internal build                   | OS                    | Result          | Date       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- | --------------------- | --------------- | ---------- |
| Router cases, A-39 handler, rollback      | `pnpm vitest run src/ui-main/ipc`                                                                                                    | `feat/issue-186-route-switch-3d` | Windows               | passed          | 2026-10-18 |
| `HostedCommandDriver` conformance, parser | `pnpm vitest run src/host/modules/suppliers/adapters/drivers/hosted-command src/host/modules/launching/domain/hostedCommand.test.ts` | `feat/issue-186-route-switch-3d` | Windows               | passed          | 2026-10-18 |
| L2 "Other…" flows                         | `pnpm vitest run src/host/wiring/flows/launchOther.test.ts src/host/wiring/flows/other-step-3d.test.ts`                              | `feat/issue-186-route-switch-3d` | Windows               | passed          | 2026-10-18 |
| L9 E2E ("Other…" stub command)            | `pnpm exec playwright test -c playwright.config.ts e2e/cut-3d`                                                                       | `feat/issue-186-route-switch-3d` | Windows               | passed          | 2026-10-18 |
| The release lanes (TC-186-02)             | `pnpm test:e2e`, `pnpm test:os`                                                                                                      | the 3d internal build            | Windows, macOS, Linux | pending (owner) |            |

## Intended differences

| Behaviour                                   | Legacy build                                                                                 | This step                                                                                                                                                                                                     | Decided by                                                |
| ------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| An "Other…" session after the window closes | today's hosted process is held by the window's main process and dies with it                 | the Host owns the session: it keeps running with the window closed and after a tray Quit, and the reopened window shows the same dwarf                                                                        | `21` §2 row 3d; OQ-44; ADR-002 D1                         |
| "Other…" as a Jev candidate                 | never                                                                                        | never: "Other…" is outside the catalog, `suppliers.launchable()` never lists it, and Jev's candidates stay Claude and Codex (Codex only in the observe-only variant)                                          | INV-43; `21` §2 "Let Jev choose (each step)"; OI-21-4     |
| How the command is parsed                   | in the window's main process (`hostedCommand.ts`), no shell                                  | in the Host (`parseHostedCommand`, the same rules moved whole), no shell; main validates only the request's shape (ADR-019)                                                                                   | ADR-020 item 3; NFR-SEC-09; `14` §2.1 A-39 Notes          |
| A command the parser refuses                | the call answers `{ launched: false, error }` with the parser's sentence, shown in the panel | the call is accepted with a `LaunchId` and settles `launch.failed {could-not-start}`: the launch-failure notice with Retry; the parser's sentence is the record's diagnostic `detail` only, never notice copy | ADR-020 item 3; `14` §2.1 A-39 Notes                      |
| A-39's answer                               | today's `AgentLaunchResult` (`{ launched, cause?, error? }`)                                 | `IpcResult<LaunchAccepted>` at acceptance; start and failure arrive as `launch.changed` / `launch.failed` frames, as for A-35                                                                                 | `14` §1.7, §3.4; `21` §3.1 (A-39 switches with its route) |
| Retry of a failed "Other…" launch           | a new A-39 call with nothing linking it to the failure                                       | A-39 with `retryOf` naming the failed launch                                                                                                                                                                  | `14` §3.4 `LaunchCustomParams`; 07 5A S5.08a              |
| Launch failures                             | today's three verdict causes                                                                 | the five ADR-020 causes, named for "The custom command" (US-LAUNCH-006.AC10), each with Retry                                                                                                                 | ADR-020 D1                                                |
| Send, console and stop of an "Other…" dwarf | today's runtime (A-23, A-13), and A-N29 through the Host since 3a                            | the Host for each: A-23 `conversation.send` (the text on the program's stdin), A-13 `conversation.resolveConsole`, A-N29 `crew.stop`                                                                          | `21` §2 cut 3 common rules; `15` §4.11                    |
| A-27, A-P3, A-P4 for an "Other…" dwarf      | no qualified route named it                                                                  | still none: no "Other…" session today's runtime launched outlives the update (it died with the window), so nothing reaches these rows; their successors are B-F10, B-F19 and B-F12                            | `21` §2 cut 3 common rules                                |

## Routes moved in this step

Rows of `src/ui-main/ipc/routes.ts` this step changes (ids of `14-ipc-contract.md` §2).

| Row              | Qualifier         | Route before                               | Route after                                            | Shape  |
| ---------------- | ----------------- | ------------------------------------------ | ------------------------------------------------------ | ------ |
| A-39             | none              | `legacy` (today's runtime)                 | `host` (`launching.launchCustom`, B-M34)               | target |
| A-35 (and Retry) | `provider: other` | `legacy` through `PerProviderShapeAdapter` | `host` (`launching.launch`, B-M33)                     | target |
| A-23             | `provider: other` | `legacy` through `PerProviderShapeAdapter` | `host` (`conversation.send`, B-M24)                    | target |
| A-13             | `provider: other` | `legacy` through `PerProviderShapeAdapter` | `host` (`conversation.resolveConsole`, B-M29)          | target |
| A-N29            | none              | `host` since 3a, every dwarf               | unchanged: its one `host` route serves "Other…" dwarfs | target |

B-M34 is the one seam B member born in 3d; no NEW row is born and `unrouted.ts` is unchanged. An "Other…" launch reaches
A-39, never A-35; the "Other…"-qualified A-35 route only keeps a supplier-way call naming that id off today's runtime.
The legacy feed is unchanged ("Other…" has no legacy discovery). Today's hosted-process launch
(`hostedProcesses.ts` composition in `runtime.ts`) is no longer reachable through the router and is deleted after the
soak by ISSUE-187. A 3d rollback build is the 3b table again (`docs/strangler/rollback.md` "Step 3d note").

## Spikes and variant recorded

| Spike | Record | Outcome                                       |
| ----- | ------ | --------------------------------------------- |
| none  | —      | row 3d has no entry criteria (`21` §2 row 3d) |

Variant: **"Other…" launched through `HostedCommandDriver`** (`stdio-raw`, `15` §4.11).

## Pending, owner-only

Items of the step's exit that neither CI nor an agent can complete (AGENTS §0.3). Each is filled in this file when its
run exists.

- **TC-186-02, the 3d internal build on Windows, macOS and Linux:** C-01…C-05, C-18, C-28, C-29 of
  `HostedCommandDriver`, the unchanged `hostedCommand.test.ts` and the cut-3d E2E in the release lanes, each run linked
  in the table above.
- **A-13 "Open console" live check per OS** for a Host-launched "Other…" dwarf (ADR-031).
- **The soak** (OQ-71), below.

| Item                    | OS      | Run by and date | Evidence |
| ----------------------- | ------- | --------------- | -------- |
| 3d internal build lanes | Windows |                 |          |
| 3d internal build lanes | macOS   |                 |          |
| 3d internal build lanes | Linux   |                 |          |
| A-13 console live check | Windows |                 |          |
| A-13 console live check | macOS   |                 |          |
| A-13 console live check | Linux   |                 |          |

## Soak record for the deletion

The step's deletion work unit (ISSUE-187) merges only after this internal build met the step's exit criteria on the
three OSes and then ran for 7 days of normal use with no blocking problem (the soak, OQ-71; owner 2026-10-18: one
soak at the end of cuts 3a–4b, recorded once in [`soak-record.md`](soak-record.md)).

| Field                        | Value                              |
| ---------------------------- | ---------------------------------- |
| Soak record                  | [`soak-record.md`](soak-record.md) |
| Retirement or deletion issue | ISSUE-187                          |

## Step-3d deletion (ISSUE-187)

Candidate decision (`21` §6): candidate replaced, evidence: the 3d parity run above (`HostedCommandDriver` C-01…C-05,
C-18, C-28, C-29 and the unchanged `hostedCommand.test.ts`), `pnpm vitest run src/host/noLegacyHostedLaunch.static.test.ts`
and the census against the merge base. Today's "Other…" launch leaves the tree: `runtime.ts` composes no
`HostedProcessRegistry` and has no `launchHostedProcess`, no `hosted-stdin` delivery or kick tier and no hosted board
stamp; the legacy A-39 handlers of `src/main/index.ts` and `LegacyRuntimeRoute.ts` are deleted, and so are
`hostedProcesses.ts`, `nodeHostedProcess.ts`, `hostedBoard.ts` and today's `hostedCommand.ts` (its Host copy is
`src/host/modules/launching/domain/hostedCommand.ts`), with their tests (`docs/test-removals.md`, ISSUE-187). The
legacy exclusion is the one pattern `^src/(main|shared)/` and shrinks by the files it covers. From this commit 3d rolls
forward only (`rollback.md` "Step 3d note"). The work unit merges only once the single soak record
([`soak-record.md`](soak-record.md)) is filled.
