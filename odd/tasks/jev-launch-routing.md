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
task against `main`, each mergeable on its own. Running count: 1752 (T1, two commits). RDD: **off**
since 2026-09-21 — the user ran `gentle-ai review mode disable` when the T1 candidate (assessed
`high`) asked for consent; no native review runs from here on, and verification is the ordinary
checks plus, for the high tier, an independent verifier beside the writer's own run.

## Tasks

- [x] **T1 — API key setting.** Encrypted key store (`safeStorage`, per-setting file under
      userData) with load/save/clear; `JevSettings` wire shape in `contracts.ts` exposing only
      `configured: boolean` and an `unavailableReason`; IPC get/set/clear; preload methods; a
      `JevSettings.vue` section in `SettingsPanel.vue` with the privacy notice, wired through
      `App.vue` like audio. Route: delegated writer (4+ files). Trigger: writer + mapping.
- [ ] **T2 — Router port and request builder.** `JevRouterPort` + SDK adapter
      (`@typesafe-ai/sdk`) + fake; pure builder that turns prompt + launchable providers + catalogue +
      effort levels into the System One request within the documented token budget; typed result with
      confidence and a fallback reason. Route: delegated writer. Verify the SDK surface against the
      official docs first.
- [ ] **T3 — `routeLaunch` IPC.** Main handler with its own timeout, fallback to the submitted
      pickers, never a provider the app cannot launch; result validated by `parseLaunchTuning`.
      Route: inline or delegated by size.
- [ ] **T4 — AddPanel Jev option.** Hidden or disabled-with-reason without a key; decision card
      shown before launch, editable; "chosen by Jev" legible on the launched session; fallback message.
      Route: delegated writer.
- [ ] **T5 — Docs.** `docs/privacy.md` "What it transmits" rewritten honestly, README
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

## Next step

T1 is complete on `feat/jev-launch-routing`; opening its PR against `main` is the user's call.
T2 writer running in `../DwarfAI-Miners-worktrees/feat-jev-router-port` (branch
`feat/jev-router-port` from `main`).
