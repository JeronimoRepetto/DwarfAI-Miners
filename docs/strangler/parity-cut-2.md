# Parity exceptions — step cut-2

The parity record of cut 2 (`21-migration-plan.md` §1 item 3, §2 cut 2; ISSUE-141). Append-only: one entry per PR
(`22-roadmap.md` §5).

## Step and internal build

| Field              | Value                                                                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Step               | `cut-2`                                                                                                                                                           |
| Internal build     | branch `feat/issue-141-cut-2-route-switch` (ISSUE-141); the internal build artifact is recorded when it is made                                                   |
| Route-switch issue | ISSUE-141                                                                                                                                                         |
| Pre-cut build      | the cut-1 table as it shipped (`src/ui-main/ipc/testing/cut1Routes.ts` pins it), over the cut-2 Host of ISSUE-140 (`feat/issue-140-wire-asking-into-host`, #1270) |

## Parity suite and run evidence

The suites `21` §2 names for this step (cut 2 "Exit criteria", `21-migration-plan.md:186`), each item with its
criterion or its named evidence run (TC-141-05):

- **Ask parity** (`src/legacy-bridge/parity/askParity.cut-2.test.ts`, TC-141-02): for every recorded observed-Claude
  fixture of `fixtures/claude/hook-keystroke/2.1.x` (five cases, each with its CRLF and extra-field variants), the key
  the Host's observed-Claude channel presses for an Allow or a Deny equals the key today's runtime pressed
  (`permissionKeystrokeFor`), except the rows of "Intended differences" marked "ask parity". SP-11 did not pass, so both
  sides answer by keystroke (row SP-11 below).
- **L1/L2 broker suites** (every ADR-010 item, `16` §4 AskBroker, idempotency by `requestId`, stale drop, persistence of
  open asks and the current step): `src/host/modules/asking/domain/askMachine.test.ts`, `permissionOptions.test.ts`,
  `emission.test.ts`, `attribution.test.ts`, `answersRecordText.test.ts`; `src/host/modules/asking/application/askBroker.*.test.ts`
  (answer, refused, elsewhere, setStep, closeForDwarf, noChannel, keystrokeAttribution) and `askQueries.test.ts`;
  `src/host/modules/asking/adapters/SqliteAskRepository.test.ts` with `testing/askRepository.contract.ts`; the
  observed-Claude adapters' tests under `src/host/modules/asking/adapters/observedClaude/`.
- **L6 A-40/A-41/A-N07 schemas and the AMENDMENT-7 rows** (TC-141-01): `src/ui-main/ipc/ipc-routing.contract.test.ts`
  `describe('release cut 2 (21 §2 cut 2)')`; `src/ui-main/ipc/handlers/answerDwarf.host.test.ts`,
  `setAskStep.host.contract.test.ts`, `setClaudeHooks.host.test.ts`, `answerWelcome.host.test.ts`.
- **L2 dual-source ask read model** (a `legacy:` AskId never reaches `asking.*`, a Host AskId never reaches today's
  runtime, no collision): `src/ui-main/ipc/handlers/answerDwarf.dispatch.contract.test.ts` and the first router case
  above; the renderer half in `src/renderer/src/composables/useDwarfQuestion.test.ts` ("[ADR-033] Host asks come from
  the asks section…", "[ADR-001] an answer to a legacy: card goes through the legacy route and an answer to a Host card
  through the host route", "[US-ASK-006.AC09] a not-open outcome renders nothing…") and
  `src/renderer/src/composables/useMessageDock.test.ts`.
- **L9 ask cases** (`e2e/cut-2/asks.e2e.ts`): answered in the terminal closes the card with no notice; reopen shows the
  card again on its step; answered in the app, the keystroke relay (#1285) presses the measured Allow key (`1`, no
  Enter) in the session's own console, a hidden stub console on Windows (macOS and Linux need a tmux pane or a
  Terminal.app tab: the maintainer's lane, `ConsoleKeystrokeDelivery.os.test.ts`). The case is declared on the
  Windows leg only (an OS split, as the OS lane's `describe.runIf`; never a skip, 17 §5.4).
- **First-run step cases with the cut-2 `offered`** (`07` S41.01, S41.02, S41.09): `e2e/cut-2/first-run-step-ui.e2e.ts`
  (clean profile with the Claude stub: the step shows with `offered: ['claude-hooks']`, the option pre-selected;
  Activate writes the Host's entry; with the option off Activate closes the step and writes nothing),
  `e2e/cut-2/first-run-step.e2e.ts` (an old-app entry: `401` at the Host ingress before the answer, accept replaces it,
  decline removes it, the person's own hook byte-kept), `e2e/cut-2/claude-hooks-toggle.e2e.ts` (A-N31 writes and
  removes the entry); the not-due, OpenCode-only and both-unticked cases in the preferences module's welcome tests
  (ISSUE-222, ISSUE-223).
- **`--revert-integrations`** removes the Host-written Claude hook entry with foreign entries byte-kept (ADR-016 item 7):
  `src/host/wiring/revertIntegrations.test.ts`, `revertIntegrations.os.test.ts`,
  `src/ui-main/hostLauncher/revertIntegrations.test.ts`, `revertIntegrations.os.test.ts` (ISSUE-225).
- **"Answer an observed Codex question" still equals the pre-cut build** (through `LegacyAskRelay`, origin
  `legacy-ask-channel`): `src/legacy-bridge/LegacyAskRelay.answer.test.ts` "[ADR-001] the answer of an observed Codex
  question through the relay equals the pre-cut build", now through the router's qualified route.

| Suite                                                                      | Command                                                                                | Internal build                                     | OS      | Result                                       | Date       |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------- | ------- | -------------------------------------------- | ---------- |
| Ask parity, router, broker, dual-source (local, before the internal build) | `pnpm vitest run src/ui-main src/legacy-bridge src/preload src/renderer src/contracts` | branch `feat/issue-141-cut-2-route-switch` (local) | Windows | passed                                       | 2026-10-14 |
| cut-2 L9 (local, before the internal build)                                | `pnpm build && pnpm exec playwright test -c playwright.config.ts e2e/cut-2`            | branch `feat/issue-141-cut-2-route-switch` (local) | Windows | passed, 8 cases (cut 0 and cut 1: 17 passed) | 2026-10-14 |
| Release lanes of the cut-2 internal build (TC-141-04)                      |                                                                                        |                                                    | Windows |                                              |            |
| Release lanes of the cut-2 internal build (TC-141-04)                      |                                                                                        |                                                    | macOS   |                                              |            |
| Release lanes of the cut-2 internal build (TC-141-04)                      |                                                                                        |                                                    | Linux   |                                              |            |

## Intended differences

| Behaviour                                                                     | Legacy build                                                                                                                            | This step                                                                                                                                                                                                                       | Decided by                                                              |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Ask parity: a dialog already answered in the terminal (`resolved-permission`) | today's hook-only registry held the dialog open until the transcript moved past it and pressed the key into whatever the console showed | the Host re-reads the transcript first, finds the call resolved and presses nothing; the card closes as answered elsewhere                                                                                                      | ADR-012 item 3; 13 FM-082                                               |
| Ask parity: a subagent's pending call only (`sidechain-pending`)              | today's registry keyed the dialog by session and pressed the key                                                                        | the Host never matches a sidechain call: no card, no key                                                                                                                                                                        | ADR-012 item 3                                                          |
| Ask parity: two pending calls of one tool (`two-pending-same-tool`)           | today's registry pressed the key for whichever call was drawn                                                                           | which call the dialog is for cannot be told: no card, no key (never a guess)                                                                                                                                                    | ADR-012 item 3                                                          |
| Ask parity: an observed Claude question (`pending-question`)                  | today's hook-only registry held a permission dialog open and pressed the key                                                            | the keystroke channel answers no question (fixture meta `observedQuestion: "none"`): no permission card and no key for it                                                                                                       | ADR-012 item 3; ADR-011 item 4; OQ-05                                   |
| First answer wins                                                             | each answer path decided on its own                                                                                                     | one broker per ask: the first answer to reach it wins, a second is `not-open`                                                                                                                                                   | ADR-010 items 4, 5; INV-72                                              |
| Answered elsewhere                                                            | a card stayed until the next board poll dropped it                                                                                      | the Host closes the ask (`ask.closed`), and the card gives way to the composer with no notice                                                                                                                                   | ADR-010 item 6; US-OBS-004.AC09; US-ASK-006.AC06                        |
| A stale submit                                                                | today's runtime answered "no longer open" and the panel showed it                                                                       | a `not-open` outcome renders no verdict on the card, the card stays as the Host reports it, and the "Answers:" record drawn at Submit is withdrawn (`useDwarfMessaging.withdrawAnswer`)                                         | ADR-010 item 5; US-ASK-006.AC09 (PO decision 2026-09-28 #28)            |
| A refused answer's words                                                      | the panel printed today's runtime's own sentence                                                                                        | `AnswerOutcome` carries a reason code, never a sentence, so the panel prints today's own "That answer could not be delivered."                                                                                                  | ADR-010 item 5; `14` §3.4                                               |
| Allow and Deny only                                                           | —                                                                                                                                       | a permission is answered only Allow or Deny, checked at the seam A gate                                                                                                                                                         | ADR-010 item 2; INV-73                                                  |
| No card for a provider with no answer channel                                 | —                                                                                                                                       | an ask with `channel: 'none'` draws no card                                                                                                                                                                                     | ADR-010 item 3; ADR-011 item 4; OQ-05, OQ-42                            |
| The current step survives a reopen                                            | a reopened window started a walk at its first question                                                                                  | the Host keeps the step (A-N07 `setAskStep`); partial picks live in the UI session store only                                                                                                                                   | OQ-03; ADR-010 item 9; ADR-033 item 4                                   |
| First-run consent step                                                        | none: the tray's "Instant updates (Claude hooks)" opt-in wrote today's entry                                                            | when Claude Code is installed the step shows on the first open of this build and whenever an old-app entry is found, with `offered: ['claude-hooks']` only (OpenCode joins in 4a); Activate is the consent and the only way out | OQ-68; OQ-70; AMENDMENT-7; AMENDMENT-9; ADR-016 item 5                  |
| An old-app Claude hook entry                                                  | today's installer owned it and today's listener answered it                                                                             | never adopted silently: left as is until the step's answer, its calls refused `401` at the Host ingress; accept replaces it with DwarfAI's own entry, decline reverts it                                                        | ADR-016 items 5–7; `18` C-21; `21` §4                                   |
| Keystroke path: Deny on macOS outside tmux                                    | today's runtime pressed Esc into whatever window was in front                                                                           | Esc is refused there, and the card offers "Jump to terminal" (never a key into an unverified window)                                                                                                                            | owner, 2026-10-14 (accepted difference; ADR-014); keystroke relay #1288 |
| Keystroke path: Deny on Linux in tmux                                         | today's runtime refused every Esc                                                                                                       | Deny works (Esc sent to the session's own pane)                                                                                                                                                                                 | lead, 2026-10-14 (intended improvement); keystroke relay #1288          |
| Keystroke path: Esc on Windows                                                | focus the console window, then SendKeys                                                                                                 | Esc is written by process id as a `VK_ESCAPE` console input record; proven against a stub, a live Claude dialog on the maintainer's machine pending                                                                             | lead, 2026-10-14 (intended); keystroke relay #1288                      |

## Routes moved in this step

Rows of `src/ui-main/ipc/routes.ts` this step changes (ids of `14-ipc-contract.md` §2). Every other row keeps its cut-1
route. A-N33 stays unrouted (`'generation-2'`).

| Row                                                                     | Qualifier                      | Route before                           | Route after                                                                    | Shape    |
| ----------------------------------------------------------------------- | ------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------ | -------- |
| A-40 `answerDwarfQuestion`, A-41 `answerDwarfPermission` (CHANGE)       | none (Host AskIds)             | `legacy` through `LegacyAskRelay`      | `host`, `since: 'cut-2'`, `parity: 'passed'` (B-M30, B-M31)                    | `target` |
| A-40, A-41                                                              | `origin: 'legacy-launch'`      | (one `legacy` route, above)            | `legacy` through the shape adapter `LegacyAnswerShapeAdapter`, `parity: 'n/a'` | `target` |
| A-40, A-41                                                              | `origin: 'legacy-ask-channel'` | (one `legacy` route, above)            | `legacy` through the shape adapter `LegacyAnswerShapeAdapter`, `parity: 'n/a'` | `target` |
| A-N07 `setAskStep` (NEW)                                                | none                           | unrouted (`unrouted.ts`, step `cut-2`) | `host`, `since: 'cut-2'`, `parity: 'passed'` (B-M32)                           | `target` |
| A-N31 `setClaudeHooksEnabled`, A-N32 `answerWelcome` (NEW, AMENDMENT-7) | none                           | unrouted (`unrouted.ts`, step `cut-2`) | `host`, `since: 'cut-2'`, `parity: 'passed'` (B-M39, B-M40)                    | `target` |

The qualifier of an A-40/A-41 call is read from its AskId by the root (`createAnswerQualifier`): a `legacy:` id carries
`LegacyAskRelay`'s origin of that ask (`legacy-ask-channel` when the relay holds none now, which the adapter answers
`not-open`), any other id none. The seam A gate parses a call routed to the shape adapter with the adapter's own request
schema: the `14` request with a `legacy:` AskId (`21` §3). The renderer answers both card sources in the `14` shapes, one
UUIDv7 `requestId` per submit; the generated preload hands the request across unchanged.

What `21` §2 lists as "Switched off in legacy" is switched off in today's composition (`LegacyRuntimeRoute.ts`, through
`src/legacy-bridge/legacyClaudeHooksSwitch.ts`) while A-40/A-41 route away from their pre-cut-2 route
(`legacyClaudeHooksComposed(ROUTES)` in `src/ui-main/index.ts`): today's `HookChannel` (the hook installer and its
restore) is not built, and the shared loopback listener's Claude events reach nothing, so today's observed-Claude
permission registry and keystroke path stay empty. The listener and its OpenCode plugin route stay composed until 4a.
An old-app entry's call finds no Claude route there: with only the OpenCode route open the listener answers `404`, and
with no route open its port is not bound.

Rollback (`21` §2 cut 2 "Rollback", §2.1 item 1; `src/ui-main/ipc/rollbackTable.ts`): a cut-2 rollback build folds each
A-40/A-41 route back into one `legacy` row with today's shape, so today's Claude hook half is composed again, and it
withdraws A-N31 and A-N32 (no route in that build, `RouteTable.withdrawn`), so the Host never turns its Claude hook
entry on while today's installer is composed (one writer, `21` §1 item 4, §4). Lead decision, 2026-10-14. Before that
build starts, the newer build's `--revert-integrations` removes the entry the Host wrote (`21` §2.1 item 2b). The build
also sets `CUT_2_ROLLBACK` (`src/contracts/strangler/rollback.ts`, as `CUT_1_ROLLBACK` for cut 1), which the Host reads
in `src/host/wiring/cut2Rollback.ts` only: the first-run step offers no option there, so it is not due (`07` S41.09,
hidden until built, `21` §1 item 8), and the Host's config writer refuses every install, so the Claude hook entry keeps
one writer; its Claude hooks target leaves the old app's (today's installer's) entry alone (`keepOldAppEntries`), so
neither a Reset nor the boot settlement of an unverified row removes it (verifier finding, 2026-10-14;
`ClaudeHooksConfigWriter.test.ts` "with old-app entries kept…"). A-40 and A-41 fold into one unqualified `legacy` row
that keeps the target shape through `LegacyAnswerShapeAdapter` (the build keeps this tree's preload and renderer), and
the root binds that adapter wherever the table names it (`ipc-routing.contract.test.ts` "in a cut-2 rollback build the
renderer's own A-40/A-41 payloads reach today's runtime…"). Proven in `src/host/wiring/cut2Rollback.test.ts` (broken on purpose: a rollback build that still offers the
option fails "a rollback build offers no first-run option") and pinned to the table in
`src/ui-main/ipc/ipc-routing.contract.test.ts` ("the cut-2 rollback setting is on if and only if…"; broken on purpose:
the setting on in a normal build fails it).

Asks left by the cut-2 build (#1293, follow-up of the ISSUE-141 verification): an observed session outlives the Host
(`07` S6.17), so an ask the cut-2 build opened can still be `open` when the rollback build's Host boots, while no route
answers a Host `AskId` there (`INVALID_PARAMS`). With `CUT_2_ROLLBACK` on, the Host settles every ask left `open` or
`answering` at boot as a request it no longer holds (`07` S6.11, S6.20, machine 6's `reconcileAfterRestart`): it closes
answered elsewhere with no notice, so no unanswerable card is shown (hidden until built, `21` §1 item 8). No new state,
reason or event. Proven in `src/host/wiring/cut2Rollback.test.ts` (broken on purpose: a rollback build that leaves the
ask open fails "a rollback build closes every ask the cut-2 build left live") and
`src/host/modules/asking/application/askRestart.test.ts`.

Dialog precedence (lead decision, 2026-10-14; ADR-002 D7, OQ-63): Stop everything and quit's confirmation opens above
every other dialog, whichever opened first, the first-run step included, which has no close and no skip
(US-SET-012.AC06). Dialogs open at once stack (`src/renderer/src/lib/overlay/dialogStack.ts`): only the top one is
drawn above, hears the keys and holds the focus; the ones beneath stay open, `inert` and `aria-hidden`, until it
closes. Quitting before an answer leaves the step due for the next window (`07` S41.08). Proven in
`src/renderer/src/components/stopEverything/StopEverythingOverWelcome.test.ts` and
`e2e/cut-2/first-run-step-ui.e2e.ts` "Stop everything and quit is reachable while the first-run step is open". From
cut 2 a case that installs the Claude stub on a fresh profile and then uses the Panel answers the due step first, with
nothing ticked, as a person does (`e2e/_harness/firstRunStep.ts`); the step is due wherever Claude Code is installed,
the runner's own included when a case passes no stubs.

## Spikes and variant recorded

| Spike | Record                   | Outcome                                                                                                                                                                                                        |
| ----- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SP-11 | `spike-results/SP-11.md` | partial: the hook-decision route is not adopted, so the keystroke exception stays (`channel: 'hook-keystroke'`, ADR-012 item 3). The hook-decision issue ISSUE-135 is closed as not needed (owner, 2026-10-14) |
| SP-09 | `spike-results/SP-09.md` | passed by owner waiver (2026-10-14) on the exit criterion's second branch: OpenCode reports `answeredElsewhere: false` (`21` §9)                                                                               |

Variant: `offered` is `['claude-hooks']` in this step (AMENDMENT-9, OQ-70): the first-run step offers only Claude Code,
even with OpenCode installed, and the boot legacy check skips the `opencode-plugin` target until 4a.

Package gaps decided for this step:

- **G1, the ingress port at the first boot.** ADR-016 item 3 has the ingress port chosen when an integration is enabled,
  while `16` §8.2 starts the hook ingress at boot step 6. The Host persists its port (`app_meta.ingress_port`) at the
  first boot (ISSUE-140), so the first-run step's Activate has a port to write. This is why ISSUE-140 cannot ship
  without this switch: with A-N32 unrouted, the step that the first boot makes due had no way out
  (`e2e/cut-2/first-run-step-ui.e2e.ts` "the step is never a trap"; proven by breaking A-N32's composition, which left
  the step on screen). Decided by: lead, 2026-10-14.
- **S14.10, rewriting the entry when the port changes,** was not built when the step was switched: a taken port at a later
  boot gave a new port, and the entry written earlier was not rewritten. Decided by: lead, 2026-10-14 (follow-up). Built
  since (#1289): after boot step 6 binds the ingress, the Host's own entry of an `on-verified` integration that names
  another port is written again through the config writer engine (backup, fresh token, read-back, the consent on
  record), replacing DwarfAI's own entry only; an old-app entry is never written, an integration that is off or
  `on-unverified` is left alone, and a cut-2 rollback build never rewrites. The check runs at every bind, so a rewrite a
  full disk refused is made at the next boot.

Real-CLI evidence (`21` §4 row "Claude hook entry", TC-141-03): the Claude CLI treats a `401` from the Host ingress, or no
answer from the old app's Claude route, as a non-blocking hook failure. Run by the owner in the opt-in real-CLI lane
(`17` §5.5); never CI, never an agent.

| Field                        | Value |
| ---------------------------- | ----- |
| Claude Code version          |       |
| OS                           |       |
| `401` at the Host ingress    |       |
| No answer from the old route |       |
| Run by and date              |       |
| Evidence (log or record)     |       |

## Open items

- **The Settings → Integrations row for A-N31** is not composed in this tree (`useClaudeHooksSettings` has no
  component); `e2e/cut-2/claude-hooks-toggle.e2e.ts` calls A-N31 through the renderer's `window.api`.

## Soak record for the deletion

The step's retirement work unit (ISSUE-142) merges only after this internal build met the step's exit criteria on the
three OSes and then ran for 7 days of normal use with no blocking problem (the soak, OQ-71).

| Field                        | Value     |
| ---------------------------- | --------- |
| Exit criteria met on Windows |           |
| Exit criteria met on macOS   |           |
| Exit criteria met on Linux   |           |
| Soak build                   |           |
| Soak start                   |           |
| Soak end                     |           |
| Blocking problems            |           |
| Retirement or deletion issue | ISSUE-142 |

## Cut-2 retirement (ISSUE-142)

Candidate decision (`21` §6): composition removed, evidence: `pnpm vitest run src/ui-main/ipc/ipc-routing.contract.test.ts`
(`describe('cut-2 retirement (21 §2 cut 2)')`, green on the ISSUE-142 branch; broken on purpose: a `HookChannel` left
composed, or the listener's Claude events handed to `noteHookEvent`, fails it). Today's hook installer and its channel,
the Claude route of the shared loopback listener, the observed-Claude permission registry and the keystroke path are no
longer composed by `LegacyRuntimeRoute.ts`, whatever the route table; `legacyClaudeHooksSwitch.ts` and the root's
`legacyClaudeHooksComposed` are deleted, so a cut-2 rollback build no longer composes today's Claude hook half (from
here cut 2 rolls forward only, `21` §2.1). The listener stays composed for the OpenCode plugin route until 4a. The legacy
files (`src/main/hooks/**`, `src/main/textDelivery/permissionKeys.ts`, the observed-Claude path of
`src/main/runtime/runtime.ts`) leave with the legacy tree in cut 5. The work unit merges only once the soak record above
is filled.
