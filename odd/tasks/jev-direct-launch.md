# Jev direct-launch UX (#523)

Branch: `feat/jev-direct-launch` (from `main` at f73af3d), worktree
`../DwarfAI-Miners-worktrees/feat-jev-direct-launch`. Engram mirror: topic
`odd/jev-direct-launch/tasks`. Issue: https://github.com/JeronimoRepetto/DwarfAI-Miners/issues/523

## Objective

Make the "Let Jev choose" toggle a full entry path: it unlocks the composer without a provider
chip; one Enter shows Jev's decision (unchanged, overridable), a second Enter launches; an
"Auto-accept Jev's choice" checkbox collapses that to a single Enter; and any Jev failure never
launches blindly and never loses the typed prompt.

## Problem and why

`composerEnabled()` (launchState.ts) ignores `state.jev` entirely, so Jev — the feature that
exists to choose the provider — still demands a provider pick to unlock typing. And #509's
fallback ("launch on the pickers' values") has no values to fall back to when the Jev path was
the only pick. See issue #523 for the full statement.

## Scope

In: `composerEnabled`/`launchPhase`/`canSubmit` gate semantics, `JevState.autoAccept`, the
`submit()` detour, the AddPanel checkbox and conditional fallback copy, `MessagePanelWindow`
wiring, tests in `launchState.test.ts` / `useAgentLaunch.test.ts` / `AddPanel.test.ts`, the
amendment to the local design source `docs/dwarfai-miners-design/screens/launch.md`.

Out: contracts/preload/main changes (none needed), persisted settings, #510/#511/#512.

## Accepted decisions (from the user, 2026-09-21)

- Auto-accept is a panel-session checkbox, default off, visible exactly when the Jev toggle is
  (API key set → `availability === 'ready'`); forced off when availability stops being ready.
- Jev failure with no chip chosen: no launch, reason shown, prompt preserved, manual chip path
  remains available. Failure with a chip already chosen keeps #509's fall-through launch.
- `chooseProvider === null` at submit time must become an explicit refusal, never a silent return.

## Constraints

- Renderer only; `composerEnabled` change must leave toggle-off behaviour byte-identical.
- Test-safety: existing test files are append-and-amend; report the per-file census.
- Comments in the register of `launchState.ts`'s #509 block; no `vi.mock`; house idioms per
  `skills/tdd`.
- One work-unit commit on the branch, Conventional Commit, subject ends with `(#523)`, no AI
  attribution. Push/PR remain the user's decisions.

## TDD

Mode: **strict** (carried from `odd/tasks/jev-launch-routing.md`; source: user global policy +
`skills/tdd`). Runner: `pnpm test`; single file: `pnpm vitest run <path>`. RED before each
implementation step, then GREEN, then REFACTOR.

## Checks (CI order)

```
pnpm install   # worktree bootstrap — DONE 2026-09-21 (3.5s)
pnpm typecheck
pnpm lint
pnpm format:check
node skills/skill-sync/assets/sync.mjs --check
pnpm test
pnpm build
```

Plus per-file test census on every touched test file.

## Delivery

Strategy: `ask-on-risk` (carried). Forecast ≈ 300–400 authored lines (impl + tests) — single
slice, single PR when opened. RDD: off (user's clone-wide setting since 2026-09-21); verification
is the checks above.

## Tasks

- [x] **T1 — state machine + submit flow + UI + tests.** Route: delegated writer (writer trigger,
      4+ non-trivial files). Evidence: RED/GREEN per test batch, checks green.
- [x] **T2 — design-source gate amendment** (`screens/launch.md`, untracked local). Route: same
      writer, after T1 is green.
- [x] **T3 — work-unit commit + full CI-order checks + census.** Route: same writer; parent spot
      check re-runs one reported command.

### T1 behaviour spec (issue #523, binding)

1. `toggleJev` on (with `availability === 'ready'`) unlocks the composer with no chip
   (`composerEnabled`, and therefore `launchPhase`/`canSubmit`, reach the same states a chosen
   chip reaches). Toggle off with no chip re-locks; nothing typed is lost.
2. Enter asks Jev; a decision applies provider/model/effort to the pickers and stops there —
   the existing card flow is unchanged; second Enter launches.
3. New `JevState.autoAccept` (session-only, default false, forced off when not `ready` —
   mirrors `enabled`). With autoAccept true, the Enter that receives a `decision` applies it
   and launches immediately (the `decided → return` guard becomes conditional). A fallback is
   never auto-accepted — there is no decision to accept.
4. Fallback with no chip: no launch, an explicit refusal line naming the reason AND saying the
   prompt was kept, manual path reopens. The existing "Launched with your pickers' values."
   sentence stands ONLY when a chip had been chosen (its #509 case).
5. `submit()`'s silent `choice === null` return becomes an honest refusal (phase
   `prompt-ready` now includes the Jev-unlocked no-chip case; entering it while Jev cannot
   answer must say so, never swallow the Enter).
6. No wire/preload/main changes. AddPanel gets the checkbox beside the toggle;
   MessagePanelWindow wires its event.

## Progress and evidence

- 2026-09-21: worktree created at f73af3d, `pnpm install` green (3.5s). Issue #523 published
  with label `enhancement`. Feature doc + mirror created; writer launched for T1–T3.
- 2026-09-21: **T1 complete** (writer). Three TDD waves, each RED-then-GREEN on the focused
  vitest file before the next was written:
  - `launchState.test.ts` wave 1 (composer unlock/re-lock/phases): RED 2 failed / 76 passed
    (composer locked with toggle on; phase stuck at `provider-selection`) → GREEN 78.
    Wave 2 (`autoAccept`, `launchedOnFallback`): RED 11 failed (`toggleJevAutoAccept is not a
function`, fields absent) → GREEN 90.
  - `useAgentLaunch.test.ts`: RED 5 failed (same TypeError ×4; the late-answer Enter silently
    swallowed — `error` stayed null) → GREEN 60.
  - `AddPanel.test.ts` + `MessagePanelWindow.test.ts`: RED 6 failed (`.jev-auto` absent; the
    no-chip fallback line still claimed "Launched with your pickers' values.") → GREEN 167.
- 2026-09-21: **T2 complete.** `screens/launch.md` gates section gained
  "Jev's toggle as the supplier choice (maintainer amendment, 2026-09-21, #523)" stating the
  stand-in rule, the collapsed confirm and the no-chip refusal. The design folder is
  git-ignored and was absent from this worktree; it was recreated as a junction to the same
  canonical target the root checkout's junction carries (maintainer's local source), so the
  amendment landed in the single source and stays out of the commit, as expected.
- 2026-09-21: **T3 complete.** Full CI-order checks: `pnpm typecheck` green; `pnpm lint` green;
  `pnpm format:check` green (prettier `--write` applied to `MessagePanelWindow.test.ts` only,
  inside this task's zone); `node skills/skill-sync/assets/sync.mjs --check` green;
  `pnpm test` — 7862 passed / 5 skipped / 3 failed, all three failures
  `src/main/platform/unixFocus.test.ts` "spawn cat ENOENT" reproduced identically on the clean
  base (f73af3d, verified by stash round-trip) — a pre-existing Windows-host environment
  failure, not this diff; `pnpm build` green. Per-file test census (before → after):
  launchState 72→90, useAgentLaunch 53→60, AddPanel 55→61, MessagePanelWindow 100→101 —
  net +32, zero removals. T3 is the single work-unit commit
  `feat(launch): let the Jev toggle open the composer, with auto-accept and a prompt kept on
failure (#523)` on `feat/jev-direct-launch`, parent `f73af3d`; its own hash cannot sit inside
  its own tree, so the identity is recorded here by subject and parent and the hash is
  reported to the parent and the Engram mirror (`odd/jev-direct-launch/tasks`).
