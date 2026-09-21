# Jev launch routing (#509)

Branch: `feat/jev-launch-routing` (from `main` at 1be0e19). Engram mirror: topic `odd/jev-launch-routing/tasks`.

## Objective

A **Jev** option in AddPanel, available once the user has entered their own TypeSafe API key in
Settings, that picks provider, model and effort from the prompt itself. The decision is shown before
it is acted on and can be overridden. Every failure degrades to the pickers' current values, and says
so.

## Problem and why

Provider, model and effort are per-prompt decisions but the pickers are set before the prompt
exists, so they stay wherever they were last left. The panel already knows what is installed, which
models each provider offers and which effort levels it accepts; it still makes the person answer.
See issue #509 for the full argument and evidence.

## Scope

In: the API-key setting (enter, change, clear), the routing decision at launch, its display, its
override, its fallback, and the privacy documentation the new outbound call requires.

Out: MCP delegation (#511), sessions the app did not start (#512), turn-result capture (#510),
editing other tools' configuration.

## Constraints

- **Worktrees only from T2 on.** T1 runs on `feat/jev-launch-routing` in the root checkout (accepted
  once, 2026-09-21). Every later task gets its own branch from `main` in a sibling worktree under
  `../DwarfAI-Miners-worktrees/<branch>`, with its own CodeGraph index; the root stays on `main`
  because other agents work there.

- The user enters, changes and clears **their own** key. The app never ships or generates one.
- The key never reaches the renderer; only "a key is configured" and the routing decision do.
- The key is stored encrypted with Electron `safeStorage`. Where the OS offers no encryption the
  Jev option is disabled with the reason visible; no plaintext fallback.
- The Jev call runs in main behind a port with a hand-written fake; no `vi.mock`.
- Choice set derived at call time from what the app can launch now (`launchProviders.ts`,
  `listAgentModels`, `PROVIDER_EFFORT_LEVELS`), never a hardcoded list.
- Wire types in `src/shared/contracts.ts`, re-exported from both barrels (bug #77).
- Settings-editable values use a per-setting JSON store under userData (audio pattern), not
  `AppConfig`; the setting must be reachable from a packaged app.
- `docs/privacy.md` currently states the app has no outbound HTTP client. This feature changes that
  and the doc plus the Settings UI must say so.
- Three platforms, any non-empty subset of providers; no observable difference between them.
- Comments state constraint and why, in the register of `contracts.ts`.

## TDD

Mode: **strict** (source: user global CLAUDE.md "Strict TDD Mode: enabled" and `skills/tdd`).
Runner: `pnpm test` (vitest run); single file: `pnpm vitest run <path>`. RED observed before
implementation, then GREEN, then REFACTOR.

## Checks per task (CI order)

```
pnpm typecheck
pnpm lint
pnpm format:check
node skills/skill-sync/assets/sync.mjs --check
pnpm test
pnpm build
```

Plus the per-file test census from `skills/test-safety` on every touched test file, and the
privacy-guard pattern on anything tracked.

## Delivery

Strategy: `ask-on-risk` (default). Forecast ≈ 1400 authored changed lines across five tasks, above
the ~400 budget. Chain strategy chosen by the user on 2026-09-21: **`stacked-to-main`** — one PR per
task against `main`, each mergeable on its own. Running count: 1752 (T1) + 989 (T2) + ≈680 (T3, tests and doc included) — each task its own PR. RDD: **off**
since 2026-09-21 — the user ran `gentle-ai review mode disable` when the T1 candidate (assessed
`high`) asked for consent; no native review runs from here on, and verification is the ordinary
checks plus, for the high tier, an independent verifier beside the writer's own run.

## Tasks

- [x] **T1 — API key setting.** Encrypted key store (`safeStorage`, per-setting file under
      userData) with load/save/clear; `JevSettings` wire shape in `contracts.ts` exposing only
      `configured: boolean` and an `unavailableReason`; IPC get/set/clear; preload methods; a
      `JevSettings.vue` section in `SettingsPanel.vue` with the privacy notice, wired through
      `App.vue` like audio. Route: delegated writer (4+ files). Trigger: writer + mapping.
- [x] **T2 — Router port and request builder.** `JevRouterPort` + SDK adapter
      (`@typesafe-ai/sdk`) + fake; pure builder that turns prompt + launchable providers + catalogue +
      effort levels into the System One request within the documented token budget; typed result with
      confidence and a fallback reason. Route: delegated writer. Verify the SDK surface against the
      official docs first.
- [x] **T3 — `routeLaunch` IPC.** Main handler with its own timeout, fallback to the submitted
      pickers, never a provider the app cannot launch; result validated by `parseLaunchTuning`.
      Route: inline or delegated by size.
- [x] **T4 — AddPanel Jev option.** Hidden or disabled-with-reason without a key; decision card
      shown before launch, editable; "chosen by Jev" legible on the launched session; fallback message.
      Route: delegated writer.
- [x] **T5 — Docs.** `docs/privacy.md` "What it transmits" rewritten honestly, README
      configuration entry, `config-layering` skill note if a new rule emerged. Route: inline.

## Acceptance criteria

- Jev option hidden or visibly disabled with the reason when no key is set or storage is unavailable.
- The key can be entered, replaced and cleared from Settings; the renderer never sees its value.
- Trivial and hard prompts from the same mine produce different launches.
- The decision is shown before it is acted on and can be overridden.
- Unreachable, rate-limited or low-confidence Jev still launches with the pickers' values and says so.
- The chosen provider is never one the app cannot launch.
- Works with any non-empty subset of providers, on Windows, macOS and Linux.

## Progress and evidence

**T1** — route: delegated writer (mapping and writer triggers fired: 20 files). Commits on
`feat/jev-launch-routing`: `a6fd071` (store, port, contracts, barrels, IPC, preload) and `bc41601`
(JevSettings section, composable, SettingsPanel and App wiring). Writer evidence: RED observed then
GREEN on all 7 test files; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, skill-sync check,
`pnpm test` (281 files, 7713 tests passed, 5 skipped) and `pnpm build` green; test census +66 with
no statements lost. Orchestrator corrections before committing: the privacy notice no longer claims
the key never leaves the machine (it is the bearer token of the TypeSafe request), and four
comments that pointed at #511 now point at #509. Native review: assessed `high`
(`process_boundary` in `contracts.test.ts`); the user disabled RDD at the consent prompt, so the
off path applies. Independent verifier (fresh worker, read-only): **pass-with-notes** — all six
checks re-run green except `pnpm format:check`, which flagged only this document (fixed in the
docs commit below); `readKey()` reaches no IPC channel, no log and no renderer code; no plaintext
fallback; all five contracts symbols re-exported from both barrels; the persisted file holds only
base64 ciphertext and `clear()` removes it; no `process.platform` branching; test counts matched
the writer's exactly.

**T2 design decision** (recorded here because it departs from the issue's literal wording): one
System One request with two questions instead of three. `model` is a Choice over
`<provider>:<model>` keys derived from the providers launchable right now, and the provider is
derived from the chosen key, so the choice is launchable and the model is in its catalogue by
construction. `effort` is a Score over a fixed four-level difficulty rubric, mapped locally onto
each provider's own effort ladder. A separate `provider` Choice was dropped because two
independent answers could disagree, and resolving that would need a rule nobody chose.

**T1 delivery** — PR #513, merged into `main` (`6599376`).

**T2** — route: delegated writer in worktree `feat-jev-router-port` (branch `feat/jev-router-port`
from `main` at `1be0e19`). Commit `e748632`: `src/main/jev/` with the port, the pure request
builder (`buildJevRouteRequest`, `mapEffortScore`), the SDK adapter (`createTypesafeJevRouter`,
injected `fetch`, silent logger, 8 s per attempt, one retry, `JEV_MIN_CONFIDENCE = 0.5`) and
`FakeJevRouter`; `@typesafe-ai/sdk` 0.6.0 added. Writer evidence: RED then GREEN on both new test
files (35 tests); six checks green; census +27. Orchestrator correction: an unverified claim that
TypeSafe's docs use a chars-per-token estimate was removed from a comment. Native assessment:
`medium` (generated region of `AGENTS.md`), so writer self-verification plus the orchestrator's
readback and spot check. Decision gap the writer returned instead of inventing: no wall-clock
budget above the SDK's retries — resolved in T3. PR #515, merged into `main` (`53a4b7f`).

**T3 (writer report)** — route: delegated writer, worktree
`../DwarfAI-Miners-worktrees/feat-jev-route-launch` (branch `feat/jev-route-launch` from `main` at
`53a4b7f`). Built the `jev:route` IPC, main side only, per the task brief:

- `src/shared/contracts.ts` — `JevFallbackReason` lifted from `jevRouterPort.ts` (now the wire
  vocabulary too); `JevRouteLaunchRequest { prompt }` and its boundary parser
  `parseJevRouteLaunchRequest` (throws, capped at the existing `MAX_DWARF_TEXT_CHARS` rather than a
  new number — a route request carries the same prompt a launch would); `JevRouteLaunchResult`
  (decision | fallback, never the prompt/key/token usage); `IPC_CHANNELS.routeJevLaunch: 'jev:route'`.
  Every new symbol re-exported from both barrels (`src/main/domain/types.ts`,
  `src/renderer/src/types.ts`).
- `src/main/jev/jevRouterPort.ts` — `JevFallbackReason` now imported from `../domain/types` and
  re-exported, so `typesafeJevRouter.ts`/`fakeJevRouter.ts` needed no changes.
- `src/main/jev/routeLaunch.ts` (new) + `.test.ts` (new) — `createJevLaunchRouter`. Builds the
  request from a freshly-asked provider/model list every call, races `router.route()` against its
  own `AbortController` timer (default 15000ms, overridable) so a launch can never wait past this
  app's own budget whatever the SDK's retries do underneath, validates a decision with
  `parseLaunchTuning` plus a "still launchable" belt-and-braces check, and never throws (unexpected
  errors log `[jev] Route request failed after <ms>ms` — no prompt — and fall back to
  `invalid-response`).
- `src/main/index.ts` — composed `createTypesafeJevRouter`/`createJevLaunchRouter` beside the
  existing key store, registered `ipcMain.handle(IPC_CHANNELS.routeJevLaunch, ...)` (a refused
  payload falls back rather than throwing an IPC error), added the channel to
  `removeIpcHandlers()`.
- `src/preload/index.ts` (+ `.test.ts`) — `routeJevLaunch`, parsed client-side with the same shared
  parser, same discipline as `setJevApiKey`.

RED→GREEN evidence: `src/main/jev/routeLaunch.test.ts` (new, 11 cases) failed with
`Cannot find module './routeLaunch'` before the implementation existed; `src/shared/contracts.test.ts`
(+5 cases) failed with `parseJevRouteLaunchRequest is not a function`; `src/preload/index.test.ts`
(+3 cases) failed with `api.routeJevLaunch is not a function`. All three green after implementation.

Verification (all in the worktree): `pnpm typecheck` clean; `pnpm lint` — no issues; `pnpm
format:check` — flagged the two new/changed test files, fixed with `pnpm format` (`prettier
--write`), re-check clean; `node skills/skill-sync/assets/sync.mjs --check` — up to date; `pnpm
test` — 284 files / 7767 tests passed (2 files / 5 tests skipped, pre-existing); `pnpm build` —
green (main, preload, renderer). `node skills/test-safety/assets/test-census.mjs` — net +19 test
statements across the 3 touched test files (`routeLaunch.test.ts` new +11, `contracts.test.ts` +5,
`preload/index.test.ts` +3), no file lost test statements.

Decisions made beyond the brief: (1) the total-budget timeout races the router's own promise
against an independent `AbortController` timer rather than trusting every router implementation to
honour the signal — the budget is enforced by this service regardless of what the SDK adapter does
with the signal it is handed. (2) the optional `now` clock is used only to note elapsed time in the
one warn line an unexpected error produces (never the prompt), giving it a real, testable purpose
rather than sitting unused. (3) buildJevRouteRequest's two skip reasons (`no-launchable-provider`,
`budget-exceeded`) pass straight through as `JevFallbackReason` members rather than through a second
mapping, since the two unions already agree. Nothing was left partial or blocked; T4 (AddPanel Jev
option) is the next task and is out of this one's scope (no `src/renderer/src/components/**` or
composables touched).

**T3 (orchestrator)** — readback of `routeLaunch.ts`, the `index.ts` wiring and the contracts block;
spot check re-ran the Jev, contracts and preload test files (350 passed) and `pnpm typecheck`. One
comment edited to name where the wall-clock decision is recorded instead of pointing at "history".
Commit and PR recorded in the Engram mirror; PR opened against `main` under the standing push-and-PR
authorization.

**T4 (writer report)** — route: delegated writer, worktree
`../DwarfAI-Miners-worktrees/feat-jev-addpanel` (branch `feat/jev-addpanel` from `main` at `4f8f5f7`).
Built the Add Panel's own Jev option, renderer only, per the task brief:

- `src/renderer/src/lib/launch/launchState.ts` — a `jev: JevState` field on `LaunchState`
  (`availability: 'hidden' | 'unavailable' | 'ready'` derived from `JevSettings`, `unavailableReason`,
  the person's own `enabled` toggle for the panel session, a `routing` phase
  `idle | asking | decided(JevDecision) | fellBack(reason, confidence?)`, and `previousChoice` — the
  pickers a decision is about to overwrite). Five pure transitions: `setJevSettings`, `toggleJev`,
  `jevAsked`, `jevAnswered`, `clearJevDecision`, plus a `shouldAskJev` predicate `submit` reads. A
  decision applies through the SAME `chooseProvider`/`chooseModel`/`chooseEffort` paths a person's own
  click uses, so the row under the composer needs no second rendering path for "Jev chose this" versus
  "I chose this"; a fallback touches no picker. `clearJevDecision` restores `previousChoice` and is the
  one function behind both the decision card's Dismiss control and every prompt edit — an ask or a
  decision about one prompt does not outlive it.
- `src/renderer/src/composables/useAgentLaunch.ts` — `open()` now asks `getJevSettings()` alongside
  `listAgentProviders()`/`listAgentModels()`, all three fired together through a new `safelyAsk` helper
  (catches a synchronous throw from a missing bridge member exactly like a rejected promise, so the
  three could be asked in parallel without losing the per-member safety the old sequential try/catches
  had). `submit()` gained one detour: when `shouldAskJev` is true it asks first, applies a decision and
  STOPS (return before any launch), or falls through to the ordinary launch on a fallback — reading
  `state.value.jev.routing.phase === 'decided'` after applying the answer, not the raw IPC result,
  so a decision that arrived after the prompt was edited mid-flight (and was therefore already dropped
  back to idle) cannot silently swallow that Enter. A rejected/missing `routeJevLaunch` becomes a
  fallback with reason `'invalid-response'`. `setPrompt` now also calls `clearJevDecision` on every
  keystroke. New exports: `jev`, `toggleJevEnabled`, `dismissJevDecision`.
- `src/renderer/src/components/launch/AddPanel.vue` — new `jev: JevState` prop, new `toggle-jev`/
  `dismiss-jev` emits. Absent with no key configured; disabled with main's reason (duplicated from
  `JevSettings.vue`'s own `UNAVAILABLE_MESSAGES` deliberately, so both surfaces explain
  `encryption-unavailable` in the same words) when `unavailable`; a pressable toggle when `ready`. An
  "Asking Jev…" status line while asking, which also blocks a second Enter from resubmitting. A
  decision card (provider label off the SAME source the chip row resolves it from, never the CLI
  binary name; model label off the model picker's own catalogue, falling back to the raw id; effort;
  confidence as a percentage; a truncated-prompt note; Dismiss). A fallback line, placed OUTSIDE the
  launched/composer split on purpose — it has to survive into the spawning/detached view, because a
  fallback's whole point is that the launch still happened and the panel says so. No new colour
  literals: every new class reuses tokens and box shapes already in this file or in `JevSettings.vue`.
- `src/renderer/src/MessagePanelWindow.vue` — wired `jev`/`toggleJevEnabled`/`dismissJevDecision` into
  `<AddPanel>` beside the existing `modelPicker`/`effortPicker` wiring. The task brief named `App.vue`
  for this; the real mount site is `MessagePanelWindow.vue` (`AGENTS.md`'s own "TWO roots" split, and
  confirmed by `codegraph_explore`), so the wiring went there instead.

RED→GREEN evidence: `launchState.test.ts` (+22 statements, new `describe('the Jev option (#509)', …)`)
failed on `setJevSettings is not a function` / `Cannot read properties of undefined (reading
'availability')` before the state existed, 72/72 green after. `useAgentLaunch.test.ts` (+14, new
`describe('Jev launch routing (#509)', …)`) failed on `toggleJevEnabled is not a function` /
`Cannot read properties of undefined (reading 'value')`, 52/52 green after. `AddPanel.test.ts` (+18,
new `describe('the Jev option', …)`) failed on missing `.jev-toggle`/`.jev-status`/`.jev-decision`/
`.jev-fallback` elements and an unguarded second Enter reaching `submit`, 62/62 green after.

Verification (all in the worktree): `pnpm typecheck` — clean after adding `getJevSettings`/
`routeJevLaunch` to `useAgentLaunch.test.ts`'s shared `stubApi` base object (the override-only pattern
typechecked at the call site but not against the helper's own inferred return type); `pnpm lint` — no
issues; `pnpm format:check` — flagged the three new/changed test files, fixed with `pnpm format`
(`prettier --write`), re-check clean; `node skills/skill-sync/assets/sync.mjs --check` — up to date;
`pnpm test` — 284 files / 7832 tests passed (2 files / 5 tests skipped, pre-existing per T3's note);
`pnpm build` — green (main, preload, renderer). `node skills/test-safety/assets/test-census.mjs` — net
+54 test statements across the 3 touched test files (`launchState.test.ts` +22, `AddPanel.test.ts`
+18, `useAgentLaunch.test.ts` +14), no file lost test statements. `MessagePanelWindow.test.ts` (not
touched, but exercises the real `AddPanel` mount) re-run separately: 98/98 green, unaffected because
its own `window.api` stub has no `getJevSettings`, so `safelyAsk` degrades that surface to `hidden`
exactly as a bridge that cannot answer already degrades providers/models there.

Decisions beyond the brief, returned rather than invented silently: (1) `clearJevDecision` restores
`previousChoice` on EVERY call, not only from the explicit Dismiss button — the brief named one
function for both "on prompt edit or panel close" and the Dismiss control's own restore, and treating
an edited prompt as abandoning the suggestion (reverting the pickers, not just hiding the card) reads
as the more honest option: a decision was about the OLD prompt, and carrying its picker values forward
onto a new one it never evaluated would look live when it is not. (2) Manually re-choosing a chip,
model or effort after a decision is showing does not itself clear the card — only an edited prompt,
Dismiss, or panel close does, per the brief's own list; a stale card next to a since-changed picker is
a small rough edge the brief did not ask this task to resolve. (3) `pnpm typecheck`'s failure surfaced
a pre-existing gap in `useAgentLaunch.test.ts`'s `stubApi` helper (its return type is inferred from the
base object, so an override-only member typechecks at the call site but not against the helper's own
signature) — fixed by adding `getJevSettings`/`routeJevLaunch` to the base object, following the
file's own stated reason for naming awaited members there rather than per test.

Follow-up not built, out of scope per the brief: a per-session marker on the launched dwarf saying it
was Jev-routed needs a wire field on the launch request and persistence in main, which this task's
renderer-only, no-contracts-changes scope explicitly excludes.

**T3 delivery** — PR #520, independent verifier **pass**, merged into `main` (`4f8f5f7`).

**T4 (orchestrator)** — readback of the pure `jev` slice in `launchState.ts`, the `submit` detour in
`useAgentLaunch.ts`, the `MessagePanelWindow.vue` wiring and the template hooks in `AddPanel.vue`;
spot check re-ran the four renderer test files (284 passed) and `pnpm typecheck`. Confirmed that
the fallback line renders independently of the launch phase and is pinned by a test in
`submitted-spawning`, so "launched with your pickers' values" is actually visible after the launch
it explains. Accepted the writer's two judgment calls: `clearJevDecision` restores the pickers on
every invalidation, and a manual re-pick leaves the card standing because the card itself invites
that edit. Follow-up recorded, not built: a per-session "Jev-routed" marker on the launched dwarf
needs a wire field on the launch request and persistence in main.

**T4 delivery** — PR #521, CI green. Independent verifier: **pass-with-notes**, one medium finding
accepted and fixed in `b2dcbb5`: a second `submit()` during the Jev ask was blocked only by the
composer's Enter guard, so in state it could launch on the unapplied pickers and let the late
decision rewrite them behind a started session; `submit` now refuses during `asking`, pinned by a
composable-level test written first (RED observed, then GREEN). Two low notes recorded, not acted
on: close-with-live-decision relies on `closedLaunch()` structurally and has no dedicated test, and
the fallback line's visibility after launch is pinned for `submitted-spawning` only.

**T5 (writer report)** — route: inline, worktree
`../DwarfAI-Miners-worktrees/docs-jev-privacy` (branch `docs/jev-privacy` from `main` at `4f8f5f7`).
Documentation only, no source changes; read T1–T3's merged code in `main` plus T4's still-open
`feat/jev-addpanel` (`AddPanel.vue`, `useAgentLaunch.ts`) for the exact UI copy and flow, since T5
was scheduled to run before T4 merges.

- `docs/privacy.md` — rewrote "What it transmits": the old "no outbound HTTP client" opening claim
  is now false, so it states there is exactly one, names the one call
  (`https://api.typesafe.ai/v1/systemone`, `typesafeJevRouter.ts`, URL pinned in
  `typesafeJevRouter.test.ts`) and the two conditions that gate it, then what leaves (prompt,
  trimmed to Jev's budget; the launchable providers and their models; the fixed effort rubric; the
  API key as bearer token), what never leaves (pinned by `routeRequest.test.ts`'s own
  `'carries nothing about this machine but the prompt itself'` test), what comes back and how it is
  validated before ever reaching the renderer, when the call never happens, and TypeSafe's own
  retention language sourced from its Privacy Policy and DPA (primary sources, quoted rather than
  paraphrased — no fixed retention period is published for a System One request specifically, so
  none is claimed). Also updated "What it stores, and where" for `jev-api-key-v1.json` (ciphertext
  only, `{}` on clear, no plaintext fallback) and the file-count sentence (twelve written + one
  read), and softened the intro's "everything happens on your machine" to name the one exception.
- `README.md` — added a Configuration-section paragraph: the Jev key is a secret, not a layered
  setting, so `.env`/`config-v1.json` never carry it; set from Settings only; stored encrypted;
  links `docs/privacy.md#what-it-transmits`.
- `skills/config-layering/SKILL.md` — added "A secret is not a setting either", recording
  `jevApiKey.ts` as the second thing (beside the simulated-valley switch) that never enters the
  three layers, and the two rules a secret needs that a preference does not: no plaintext fallback,
  ever, and an undecryptable file degrades to unconfigured rather than blocking startup. Frontmatter
  untouched.

Verification: `pnpm format:check` clean (prettier reformatted `docs/privacy.md`'s tables once,
`pnpm exec prettier --write` applied, re-check clean); `pnpm typecheck` clean; `pnpm test` — 284
files / 7771 tests passed, 5 skipped (unchanged from T3's count, as expected for a docs-only
change); `node skills/skill-sync/assets/sync.mjs --check` — already up to date (10 skills), no
regeneration needed since no frontmatter changed.

Could not verify from a primary source: an exact retention _period_ (in days) for a System One
request specifically — TypeSafe's Privacy Policy and DPA both use open-ended "as long as
necessary/reasonably necessary" language rather than a number, so the document says that rather
than inventing a figure.

**T5 (orchestrator)** — read the rewritten "What it transmits", the stores table entry, the README
paragraph and the skill section against the code they cite. Removed two "on the T4 branch at the
time of writing" qualifiers so the document reads as final once both PRs are in. The docs branch
was fast-forwarded onto `feat/jev-addpanel` so both edits to this document land in order; its PR
shows only the docs diff once #521 merges.

## Next step

All five tasks are done. Remaining, as separate work: the per-session "Jev-routed" marker on the
launched dwarf (wire field on the launch request plus persistence in main), and #510/#511/#512
(turn-result capture and the MCP delegation server), which the user deferred.
