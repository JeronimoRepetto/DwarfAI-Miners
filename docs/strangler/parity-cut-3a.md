# Parity exceptions — step cut-3a

The parity record of step 3a, the Claude launch step (`21-migration-plan.md` §1 item 3, §2 cut 3 row 3a; ISSUE-001).
Append-only: one entry per PR (`22-roadmap.md` §5).

## Step and internal build

| Field              | Value                                                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Step               | `cut-3a`                                                                                                                      |
| Internal build     | branch `feat/issue-001-route-switch` (ISSUE-001); the internal build artifact is recorded when it is made                     |
| Route-switch issue | ISSUE-001                                                                                                                     |
| Pre-cut build      | the cut-2 table as it shipped (`src/ui-main/ipc/testing/cut2Routes.ts` pins it), over the step-3a Host of the issues upstream |

## Parity suite and run evidence

The exit list of step 3a (`21` §2 cut 3 row 3a, "Parity / exit", `21-migration-plan.md:216`), each item with its
criterion and its named evidence (TC-001-06). Every issue that produces this evidence is upstream of the switch
(`23-epics/README.md` "Step membership and closing issues").

- **Launch parity per Claude fixture** (TC-001-03): `src/legacy-bridge/parity/launchCauseParity.cut-3a.test.ts`
  "[ADR-020] each recorded Claude launch failure maps from its legacy reason to the ADR-020 cause listed in
  parity-cut-3a.md". Today's side is today's held-session registry over an engine double; the Host's side is the
  launching module's five-cause table and, for the recorded fixture `fixtures/claude/stream-json/2.1.x/s0201-early-exit`
  (each timing variant), the cause its expected outcome holds. The mapping is the table under "Launch-cause mapping"
  below; any pair it does not list fails parity.
- **L4 `driverConformance` C-01…C-29 for each offered Claude driver**:
  `src/host/modules/suppliers/adapters/drivers/claude-stream-json/ClaudeStreamJsonDriver.conformance.test.ts`
  (ISSUE-150) and `src/host/modules/suppliers/adapters/drivers/acp-claude/ClaudeAcpDriver.conformance.test.ts`
  (ISSUE-151), each with C-23 (no secret in argv, env or a file) and C-24 (no forbidden flag) included.
- **L2 flows** (`15` §9.2; TC-001-05): launch → turn → ask → answer → turn end in
  `src/host/wiring/flows/cut3aHost.test.ts`, `launch.test.ts`, `asking.flow.test.ts` and `turnEnds.flow.test.ts`; crash
  recovery (ADR-015) in `hostRecovery.test.ts`, `recoveryReport.test.ts` and `resetResume.test.ts`; stop (ADR-014) in
  `stopDwarf.test.ts`, `stopEverything.test.ts` and `stopAll.test.ts`.
- **L9 E2E with the Claude stub CLI** (`17` §1.9): `e2e/cut-3a/claude-launch.e2e.ts` (launch, send, a permission
  answered in the app, stop, all through the Host), `e2e/cut-3a/recovery-message-ui.e2e.ts` (TC-001-07: one grouped
  recovery message after a Host kill, CH-01), `e2e/cut-3a/stop-legacy-launched.e2e.ts` (Stop dwarf of a legacy-launched
  session, `LegacyEndFirstAdapter` first) and `e2e/stop-all/stop-everything.e2e.ts` (US-RES-002.AC09: Stop everything
  and quit ends the launched session and keeps the person's own). The cases drive `e2e/cut-3a/claudeStreamStub.mjs`, an
  interactive stub that keeps the ISSUE-313 kit's `--version` and `--help` answers and adds the stream-json session and
  the permission prompt tool call over the relay (the kit's `fixtures/bin/claude` replays and reads no stdin).
- **Router test "catalog merge"** (`21` §3.1; TC-001-01): `src/ui-main/ipc/ipc-routing.contract.test.ts`
  `describe('release 3a (21 §2 cut 3a)')`, with `src/legacy-bridge/shape/CatalogMergeAdapter.test.ts`.
- **Jev key migration test** (ISSUE-217, `21` §4): `src/legacy-bridge/secrets/secretMigrationBridge.test.ts` (seeded
  legacy file → Host status `set`, legacy file gone; a key cleared before the step → the Host has nothing; values
  never in a log) and `src/host/wiring/flows/secretNeverEchoed.test.ts`.

| Suite                                                  | Command                                                                                                                                 | Internal build                               | OS      | Result                       | Date       |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------- | ---------------------------- | ---------- |
| Router, launch parity, flows (local, before the build) | `pnpm vitest run src/ui-main/ipc/ipc-routing.contract.test.ts src/legacy-bridge/parity src/host/wiring/flows`                           | branch `feat/issue-001-route-switch` (local) | Windows | passed (54 files, 478 tests) | 2026-10-18 |
| Claude driver conformance (local, before the build)    | `pnpm vitest run src/host/modules/suppliers/adapters/drivers/claude-stream-json src/host/modules/suppliers/adapters/drivers/acp-claude` | branch `feat/issue-001-route-switch` (local) | Windows | passed (3 files, 117 tests)  | 2026-10-18 |
| Step-3a L9 (local, before the build)                   | `pnpm build:native && pnpm build && pnpm exec playwright test -c playwright.config.ts e2e/cut-3a e2e/stop-all`                          | branch `feat/issue-001-route-switch` (local) | Windows | passed (4 of 4)              | 2026-10-18 |
| Release lanes of the 3a internal build (TC-001-05)     |                                                                                                                                         |                                              | Windows |                              |            |
| Release lanes of the 3a internal build (TC-001-05)     |                                                                                                                                         |                                              | macOS   |                              |            |
| Release lanes of the 3a internal build (TC-001-05)     |                                                                                                                                         |                                              | Linux   |                              |            |

Two product defects the step-3a L9 cases found, fixed in this step (RED first):

- **A Windows npm `claude` could not start** (`could-not-start`, `spawn EFTYPE`): an npm install resolves to its script
  entry, which the stream-json driver spawned as a program. Its launch, resume and help probe now start the entry with
  the person's `node` through `adapterLaunch` (#1360), as the ACP drivers do; no `node` resolves → `not-installed`,
  nothing spawned, never a shell (R17). Case: `ClaudeStreamJsonDriver.conformance.test.ts` "[C-02, ADR-029] on
  Windows an npm-installed claude that resolves to a script entry …".
- **Stop dwarf… skipped the legacy end of a legacy-launched Claude session**: the 3a feed switched Claude's legacy
  discovery off, so `LegacyDwarfIdBridge` had no legacy side to join and `LegacyEndFirstAdapter` relayed `crew.stop`
  straight. A moved provider now keeps only the sessions today's launched register names (`legacy-launched`, `21` §3:
  the feed shrinks, the adapter needs the join). Cases: `LegacyAgentRegistryFeed.test.ts` "[ADR-001] in 3a Claude keeps
  only the sessions today’s runtime launched …" and `e2e/cut-3a/stop-legacy-launched.e2e.ts`.

## Launch-cause mapping

Each Claude launch failure: the reason today's Claude launch gives, and the ADR-020 cause the Host reports. The table
is `LAUNCH_CAUSE_PARITY` of `src/legacy-bridge/parity/launchCauseParity.cut-3a.test.ts` (ISSUE-001 work unit B), which
fails on any pair not listed here. A row whose two sides differ is an intended difference.

| Failure                                                    | Legacy reason                   | Host cause (ADR-020 D1) | Decided by          |
| ---------------------------------------------------------- | ------------------------------- | ----------------------- | ------------------- |
| `claude` not found                                         | `not-installed`                 | `not-installed`         | ADR-020 D1 cause 1  |
| the process never spawned (for example `EACCES`)           | `could-not-start`               | `could-not-start`       | ADR-020 item 3      |
| the session ended inside the early-failure window          | `exited-at-once`                | `exited-at-once`        | ADR-020 D4          |
| recorded `s0201-early-exit`: an error result before `init` | none (today reports no failure) | `exited-at-once`        | ADR-020 D4; S-020-1 |
| the session never becomes ready                            | none (today reports no failure) | `could-not-start`       | ADR-020 item 4      |

The two intended differences: today waits for the session's stream to close, which the recording places past the 3 s
window, and reports nothing, while the Host reads the error `result` before `system/init` as the launch failing (the
measured rule of S-020-1); and today has no readiness handshake, while the Host fails a launch whose handshake does not
complete in time (`07` machine 5B S5.19).

## Intended differences

| Behaviour                                   | Legacy build                                                                                                                     | This step                                                                                                                                                                                                                                                                                                                                                                                                            | Decided by                                                                        |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Who launches Claude                         | today's runtime, through the Agent SDK held session or its detached launch                                                       | the Host, through `ClaudeStreamJsonDriver` over the person's own `claude -p` (probe-gated), or `ClaudeAcpDriver` when a user-installed `claude-agent-acp` resolves; no Agent SDK driver                                                                                                                                                                                                                              | `21` §2 cut 3 row 3a; ADR-009 D4, D5; OQ-52                                       |
| Launch failures                             | today's own reasons, some launches reporting none                                                                                | exactly the five ADR-020 causes, each with Retry (`retryOf`), mapped as "Launch-cause mapping" lists                                                                                                                                                                                                                                                                                                                 | ADR-020 D1, item 2                                                                |
| A Claude session and the window             | a held Claude session ended when the app quit                                                                                    | a Host-launched session survives closing the window and the tray's Quit; only Stop dwarf, Stop everything and quit or its own end end it                                                                                                                                                                                                                                                                             | OQ-44; PO #63; ADR-002 D1                                                         |
| After a Host crash                          | —                                                                                                                                | the Host resumes each Claude session it launched (`--resume <id>`, SP-15) and shows ONE grouped recovery message for those it could not resume, with Try again and Dismiss; none after a reboot                                                                                                                                                                                                                      | ADR-015 items 4, 5; OQ-29; OQ-43; OQ-55                                           |
| "Let Jev choose" candidates                 | every provider today's runtime could launch                                                                                      | Claude only: Jev's candidates are the Host's `suppliers.launchable()`, and in 3a the Host launches Claude only. Providers still launched `legacy` stay launchable by hand (supplier chip) but are not Jev candidates; "Other…" never is. No strangler adapter widens the set                                                                                                                                         | `21` §2 "Let Jev choose (each step)"; lead decision N-03; `21` §11 OI-21-4; OQ-66 |
| Delegation to a provider not yet moved      | today's runtime launched the delegated worker                                                                                    | the delegation MCP endpoint is the Host's, and a delegated worker can only be launched by a Host driver: a parent's delegation to a provider whose step has not passed (Codex, Antigravity, OpenCode in 3a) falls back, and the parent continues with its own subagent                                                                                                                                               | `21` §2 cut 3 "Delegation"; PO #20; ADR-013                                       |
| Send to a Claude dwarf the old app launched | today's runtime sent through its own session (the held session, or its text delivery for an observed session)                    | every A-23 for a Claude dwarf goes to the Host. A session the legacy path launched before the step keeps running as an **observed** session, never re-adopted as Owned, so its text goes through `ObservedSessionTurnSender` (the terminal relay, its mark unconfirmed until the transcript echo), or answers `cannot-receive`                                                                                       | `21` §2 cut 3 common rules; ADR-015; ADR-022; ISSUE-167                           |
| Stop a dwarf                                | Kick (A-26) interrupted the turn; a held session ended with the app                                                              | "Stop dwarf…" (A-N29) is the only stop and ends the whole session, also mid-turn. A legacy-launched session is ended through `LegacyEndFirstAdapter` first (today's identity-checked kill, then `crew.stop` once the Host saw it depart)                                                                                                                                                                             | AMENDMENT-2; OQ-49; OQ-54; ADR-014; `21` §3                                       |
| Stop everything and quit                    | ended today's launches                                                                                                           | A-N26 also ends every Host-owned session (each departs `stopped`); sessions the person started in their own terminal keep running                                                                                                                                                                                                                                                                                    | US-RES-002.AC09; PO #105; INV-120; INV-121                                        |
| Models of a provider                        | A-37 `agent:models` listed them                                                                                                  | each A-36 supplier entry carries its models and efforts; Claude's from the Host, the providers not yet moved through `CatalogMergeAdapter`                                                                                                                                                                                                                                                                           | `21` §2 cut 3 row 3a (A-37, A-38 merged into A-35/A-36); `21` §3.1                |
| Attachment descriptions                     | today's runtime described the picked files                                                                                       | the Host describes them for every provider (B-M28) and re-validates every path; the legacy send of a provider not yet moved receives the same picks                                                                                                                                                                                                                                                                  | `21` §2 cut 3 (A-25)                                                              |
| The Jev key                                 | a legacy key file owned by today's runtime                                                                                       | moved once into the OS secret store, owned by the Host (A-48, A-49 `host`); the legacy file is removed after the Host confirms                                                                                                                                                                                                                                                                                       | ADR-017 items 1, 8; `21` §4; ISSUE-217                                            |
| The Jev key status                          | A-47, and every Jev row that answers the state in force (A-51 on a refused payload), read today's key file through `safeStorage` | A-47 answers the Host's `SecretStatus('jev-key')` through `JevSettingsShapeAdapter`, so a refused A-51 (answered with A-47, `LEGACY_REFUSALS`) does too: with no usable OS secret store for the Host (`secretBackend: 'unavailable'`) it reads `encryption-unavailable` even where Electron's `safeStorage` could encrypt (seen on the macOS CI runner). The seam-A replay leaves such a row out by reading `ROUTES` | ADR-017 items 1, 5; `21` §3.1                                                     |
| The Host's `toast` frame (B-F28)            | —                                                                                                                                | named, not routed: `14` §2 gives the frame (`HostToast`, for example `dwarf-stop-failed`, `session-crashed`) no seam-A member of its own, and this step adds no row for it (a channel `14` does not list is an amendment, never a silent addition)                                                                                                                                                                   | `14` §2; `21` §2 pre-cut 0 P-3                                                    |

Recorded later (ISSUE-249, 2026-10-19): from this step the chat shows transcript text without display redaction;
`redactSecrets` covers log lines and activity summaries only, as the package requires. The row is in
[`parity-cut-5.md`](parity-cut-5.md) "Intended differences" (the owner may ask to restore it; the package does not
require it).

## Foreman decision: the credential file names the MCP endpoint (2026-10-18)

Owner-approved in place of the rejected AMENDMENT-24; ADR-013 (not frozen) is the only document whose reading changes,
and no frozen contract moves: `15` §4 still gives the relay entry `ELECTRON_RUN_AS_NODE` and
`DWARFAI_MCP_CREDENTIAL_FILE` only, and neither the relay entry nor the provider child gains a variable.

- **Problem.** On Linux the Host binds `$XDG_RUNTIME_DIR/dwarfai/mcp-<profileKey>.sock`, but a relay started by a
  provider never sees `XDG_RUNTIME_DIR`, derived the fallback `<hostDataDir>/run/mcp-<profileKey>.sock` and failed
  `ENOENT` (CI run 39109490095, `e2e/cut-3a/claude-launch.e2e.ts`, "the stub's permission request opens an ask").
- **Decision.** The per-launch credential file `<hostDataDir>/run/mcp/<launchId>.cred` (same path, `0600` in a `0700`
  directory, owner-only ACL on Windows) holds `{"v":1,"credential":"<64 hex>","endpoint":"<path the Host bound>"}`,
  byte for byte as `JSON.stringify` writes it (`relay/credentialFileLayout.ts`, written through
  `EndpointNamingCredentialFiles`). The relay reads the endpoint from it on every OS and connects only when the path is
  one the Host's own rule (`mcpEndpointFor`) yields for that data dir on that OS; any other path is refused
  (`endpoint-refused`) before a connection. The byte cap rises from 256 to 512.
- **Upgrade.** A file holding the credential alone (a Host of the previous build, or no bound endpoint yet) still makes
  the relay derive the endpoint as before, so a running session survives the upgrade.

## Routes moved in this step

Rows of `src/ui-main/ipc/routes.ts` this step changes (ids of `14-ipc-contract.md` §2), as ISSUE-001 lists them. Every
other row keeps its cut-2 route. The Claude qualifier is the catalog id from `CATALOG_PROVIDER_IDS` (R12).

| Row                                                                            | Qualifier                              | Route before                            | Route after                                                                                           | Shape    |
| ------------------------------------------------------------------------------ | -------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------- |
| A-35 `launchAgent` (and its Retry), A-23 `sendDwarfText`, A-13 `activateDwarf` | `provider: claude`                     | `legacy`, today's shape                 | `host`, `since: 'cut-3a'` (B-M33, B-M24, B-M29)                                                       | `target` |
| A-35, A-23, A-13                                                               | every other provider                   | `legacy`, today's shape                 | `legacy` through `PerProviderShapeAdapter`                                                            | `target` |
| A-36 `listAgentProviders`                                                      | `provider: claude`                     | `legacy`, today's shape                 | `host` (B-M37), read by `CatalogMergeAdapter` for Claude's entry                                      | `target` |
| A-36                                                                           | none (the renderer's one catalog call) | `legacy`, today's shape                 | `legacy` through `CatalogMergeAdapter`: Claude's entry from the Host, the others from today's runtime | `target` |
| A-N29 `stopDwarf` (NEW)                                                        | none (every dwarf)                     | unrouted (`unrouted.ts`, step `cut-3a`) | `host` (B-M21), through `LegacyEndFirstAdapter` for a legacy-launched session                         | `target` |
| A-25 `describeDwarfAttachments`                                                | none (every provider)                  | `legacy`                                | `host` (B-M28)                                                                                        | `target` |
| A-48, A-49 (Jev key set and clear)                                             | none                                   | `legacy`                                | `host` (B-M10, B-M11), behind the one-time key migration                                              | `target` |
| A-50 `jev:route`                                                               | none                                   | `legacy`                                | `host` (B-M38 `jev.suggest`)                                                                          | `target` |
| A-47 `jev:settings:get`                                                        | none                                   | `legacy`                                | `legacy` through `JevSettingsShapeAdapter`                                                            | `target` |
| A-N06 retry message, A-N10 and A-N11 recovery report (NEW)                     | none                                   | unrouted (`unrouted.ts`, step `cut-3a`) | `host` (B-M25, B-M35, B-M36)                                                                          | `target` |
| A-27, A-P3, A-P4                                                               | each provider not yet moved            | `legacy`                                | `legacy`, qualified to Codex, Antigravity and OpenCode                                                | `today`  |

A-N08 and A-N09 keep the `host` routes they were born with in cut 2 (the ISSUE-172 lead decision), and A-N26 keeps its
cut-0 route (`LegacyEndFirstAdapter` first); the Host now also ends its own Owned sessions behind it. None of these
rows changes in this step.

Each `host` route uses only seam-B members born by 3a (`21` §2 "Seam B members", row 3a) and reaches
`parity: 'passed'` only with the evidence above (TC-001-02). Rollback (`21` §2.1) is a new internal build, only before
the step's deletion commit merges: A-13, A-23, A-35 and A-36 fold into their unqualified shape-adapter rows, A-25, A-27,
A-P3 and A-P4 and the retired rows go back to today's runtime, and A-47…A-50 keep their 3a routes because the Jev key
was migrated into the Host; `docs/strangler/rollback.md` "Step 3a note" records the per-row decision.

## Retired rows

Rows of `14` §2 that 3a retires: no route and no handler (TC-001-01; `21` §2 cut 3 row 3a).

| Row                     | Successor                                                               | Decided by                      |
| ----------------------- | ----------------------------------------------------------------------- | ------------------------------- |
| A-26 `dwarf:kick`       | A-N29 "Stop dwarf…" ends the whole session; the kick control is removed | OQ-49; OQ-54; AMENDMENT-2       |
| A-37 `agent:models`     | the models of each A-36 entry                                           | `21` §2 cut 3 row 3a; `21` §3.1 |
| A-38 `agent:launchHeld` | A-35 with the `14` `LaunchParams` (no held-session launch)              | `21` §2 cut 3 row 3a; OQ-52     |

A-27, A-P3 and A-P4 are not retired here: they stay `legacy` for the providers not yet moved and are retired at the end
of 4b; for Claude their successors are `dwarf.departed` (B-F10), `launch.failed` (B-F19) and `message.delivery` (B-F12).

## Spikes and variant recorded

| Spike   | Record                     | Outcome                                                                                                                                         |
| ------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| SP-08   | `spike-results/SP-08.md`   | passed for Claude Code 2.1.301: `--permission-prompt-tool` present and routing (Windows only ran)                                               |
| S-008-1 | `spike-results/S-008-1.md` | passed: `@agentclientprotocol/sdk` 1.6.0 bundled (Apache-2.0); `claude-agent-acp` stays user-installed                                          |
| SP-10   | `spike-results/SP-10.md`   | partial: the Claude part passed for 2.1.301 (Windows only); the Antigravity part has not run (3e)                                               |
| S-020-1 | `spike-results/S-020-1.md` | passed for 2.1.301: readiness is `system/init` after the first stdin line; an error `result` before it is the launch failing (Windows only ran) |
| SP-15   | `spike-results/SP-15.md`   | partial: the stream-json `--resume <id>` keeps the id for 2.1.301 (Windows only); the idle quota and the other CLIs not recorded                |
| SP-16   | `spike-results/SP-16.md`   | partial: `@napi-rs/keyring` 2.1.0 passes on Windows; macOS and Linux not run, no waiver                                                         |

Variant: **the Claude driver offered** (not the observe-only variant of OQ-67). SP-08 and S-008-1 both passed, so
`ClaudeStreamJsonDriver` is offered where the probe finds the prompt tool, and `ClaudeAcpDriver` where a user-installed
`claude-agent-acp` resolves (it is preferred then, `profiles.ts`). Claude is launchable, a Jev candidate and a
delegated worker.

## Pending, owner-only

Items of the step's exit that neither CI nor an agent can complete (AGENTS §0.3). Each is filled in this file when its
run exists.

- **ISSUE-321 spike gate.** SP-08, S-020-1 and the Claude part of SP-10 ran on Windows only, and SP-10, SP-15 and SP-16
  are partial. The switch merges only once the records exist and follow their decision (`24-issues/README.md` §6): the
  owner either waives the macOS and Linux runs for this internal step or runs them.
- **TC-001-05, the 3a internal build on Windows, macOS and Linux:** the L2 flows, C-01…C-29 of each offered Claude
  driver, C-23, C-24 and the Claude E2E in the release lanes, each run linked in the table above.
- **The real-CLI lane** (`pnpm test:real-cli`, `17` §5.5): a launch, a send, a permission and a stop against the
  person's own `claude` on each OS, on the maintainer's machine with the person's own login; never CI, never an agent.
- **A-13 "Open console" live check per OS:** the Host-launched Claude dwarf opens its console as ADR-031 sets it for
  `console: 'log'` (15 §3 row C2), checked on a built app on each OS.
- **The Jev key migration on a real keychain:** a legacy key file moved once into the OS secret store and the file
  removed, on each OS (SP-16 has only Windows).
- **The soak** (OQ-71), below.

| Item                         | OS      | Run by and date | Evidence |
| ---------------------------- | ------- | --------------- | -------- |
| ISSUE-321 gate decision      | —       |                 |          |
| Real-CLI lane                | Windows |                 |          |
| Real-CLI lane                | macOS   |                 |          |
| Real-CLI lane                | Linux   |                 |          |
| A-13 console live check      | Windows |                 |          |
| A-13 console live check      | macOS   |                 |          |
| A-13 console live check      | Linux   |                 |          |
| Jev key migration (keychain) | Windows |                 |          |
| Jev key migration (keychain) | macOS   |                 |          |
| Jev key migration (keychain) | Linux   |                 |          |

## Soak record for the deletion

The step's deletion work unit (ISSUE-184: the Agent SDK path, `sdkHeldSession.ts`, the `@anthropic-ai/claude-agent-sdk*`
dependencies, the legacy Claude launch and ask channel, the A-26 handler, the legacy Jev key file) merges only after
this internal build met the step's exit criteria on the three OSes and then ran for 7 days of normal use with no
blocking problem (the soak, OQ-71; owner 2026-10-18: one soak at the end of cuts 3a–4b, recorded once in
[`soak-record.md`](soak-record.md)).

| Field                        | Value                              |
| ---------------------------- | ---------------------------------- |
| Soak record                  | [`soak-record.md`](soak-record.md) |
| Retirement or deletion issue | ISSUE-184                          |

## Step-3a deletion (ISSUE-184)

Candidate decision (`21` §6): candidate replaced, evidence: the 3a parity run above (`ClaudeStreamJsonDriver` and
`ClaudeAcpDriver` conformance, the 3a flows), `pnpm vitest run src/host/noAgentSdk.static.test.ts`, `pnpm depcruise`,
`pnpm test:canaries` and the census against the merge base. `sdkHeldSession.ts` is not a candidate (OQ-52). Milestone
M4a (`20` R-20): no Agent SDK in the tree. Deleted: `sdkHeldSession.ts` (the Agent SDK held session, its `canUseTool`
ask relay and its model catalogue query), `claudeTurnOutcome.ts`, `delegationHeldServer.ts` (the SDK's in-process
delegation server), the detached `claude -p` launch of `launchRunner.ts` with its `--mcp-config` temp file and Claude's
builders in `delegationInjection.ts`, and the legacy A-38 `launchHeldSession` handlers of `src/main/index.ts` and
`LegacyRuntimeRoute.ts` and A-26's `kickDwarf` handler of `LegacyRuntimeRoute.ts`; today's runtime composes no held
engine, so its registry refuses every held launch, and `LAUNCHABLE_PROVIDERS` no longer names Claude. The packages
leave `package.json` and the lockfile with `scripts/pruneSdkRuntimes.mjs` (and its `afterPack` call) and
`scripts/sdkRuntimeVersions.test.mjs`; the provider-scan allowance is closed (empty); R11 also matches the bare module
name, so `lint-canaries/R11-no-claude-agent-sdk` and a planted import in the real tree still fail lint. Kept on
purpose: the `supportedArchitectures` block of `pnpm-workspace.yaml`, which the bundled `@napi-rs/keyring` bindings
still need for the cross-arch macOS build (a difference from foreman decision D6, recorded here); `src/main/index.ts`'s
A-26 registration, unrouted since 3a, which the registry re-inventory still lists as a found RETIRE row until
`index.ts` goes whole (ISSUE-243); the A-40/A-41 `legacy-launch` answer route, which ISSUE-241 retires. TC-184-04: a
Claude session today's code launched before 3a is ended through `LegacyEndFirstAdapter` (A-N29's one `host` route)
and observed by the Host; a held one died with its window. From this commit 3a rolls forward only (`rollback.md`
"Step-3a deletion"). The work unit merges only once the single soak record ([`soak-record.md`](soak-record.md)) is
filled.
