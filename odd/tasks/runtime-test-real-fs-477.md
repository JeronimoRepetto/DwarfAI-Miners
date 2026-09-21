# runtime.test.ts never reads the repository it runs in (#477)

## Objective

`pnpm test` is green from a linked git worktree. No test constructs `AgentRuntime` over the real
filesystem or the host's platform adapters, and the project-root walk stops when it leaves the path
it was given instead of reading the process cwd.

## Problem

Measured 2026-09-18 (#477): from a linked worktree `runtime.test.ts` reports `77 failed | 305 passed`;
a plain clone of the same commit passes all 382. Blocks that build `AgentRuntime` without `fs` or
`platformAdapters` receive the defaults at `src/main/runtime/runtime.ts:967-974` — the real `NodeFs`
and the real host's adapters. The worktree fold walk (`resolveProjectRoot`,
`src/main/projects/worktree.ts:104-146`) then climbs a Windows-shaped fixture cwd with POSIX
`dirname` until it degenerates to `.`, which in a linked worktree is the checkout's own `.git`
**file**. The real `commondir` and `HEAD` are read and the checkout's branch name appears inside the
assertions. A plain clone has a `.git` directory, so the walk stops at once and nothing leaks.

This breaks CONTRIBUTING.md's "Deterministic fakes, no network, no credentials" rule, and every
agent working in a worktree by convention sees a red suite it did not cause.

## Why this shape and not another

- **Delete the defaults rather than add a guard.** Production's one composition root
  (`src/main/index.ts`) already passes both `fs` and `platformAdapters`. The defaults exist only so
  tests may omit them, which is exactly the omission that leaks. Making both required is the fix
  that removes code: the type stops the omission at every construction site, today and in the
  future.
- **The walk guard is a bug of its own, fixed once.** A walk whose `dirname` stops changing, or
  which reaches `.`, has already left the path it was given. Stopping there is correct in
  production too; reading the process cwd never was.
- **No new helper machinery.** Reuse the shared fixture helpers `runtime.test.ts` already has
  (the #470 blocks pass `worktreePlatformAdapters()`); extend one helper to also inject a `FakeFs`
  rather than inventing a parallel one.

## Scope

**Authorized:** `src/main/runtime/runtime.ts` (the two defaults and the options type),
`src/main/runtime/runtime.test.ts`, `src/main/projects/worktree.ts` and `worktree.test.ts`, any other
test file `pnpm typecheck` names because it constructs `AgentRuntime` without the two options
(amend only), `src/main/index.ts` only if typecheck proves it needs a change (it should not),
and this document.

**Amended during T1, both within the letter of the rule above:**
`src/main/providers/registry.test.ts` — typecheck named it (2 `AgentRuntime` constructions, `fs`
already given, `platformAdapters` missing). `src/main/index.ts` — typecheck proved it DID need a
change: the composition root never actually passed `fs`/`platformAdapters` explicitly, relying
entirely on the two defaults this task deletes; see Progress for what moved there.
**One file the authorized list did not name:** `src/main/platform/fakePlatformAdapters.ts` (new).
The plan's own text says to reuse the shared fixture `runtime.test.ts` already has rather than
invent a parallel one; the first attempt did that literally — `registry.test.ts` imported
`worktreePlatformAdapters` straight from `runtime.test.ts` — and it broke the suite: vitest
re-executes every `describe`/`it` a test file's module graph reaches, so importing one `.test.ts`
from another re-runs the whole imported file's suite under the importer too (`registry.test.ts`
reported 420 tests instead of ~6). The fix keeps the exact same function, verbatim, and only moves
it beside `platformAdapters.ts` — the same relationship `fakeFs.ts` has to `fsLike.ts` — so both
test files import a plain module with no test side effects. Reported here rather than left silent.

**Out of scope:** any behaviour change in the runtime beyond the constructor options; the
`FsLike`/`NodeFs` adapters; #454 item 3 (the general rule for boundary-crossing tests).

## Constraints

- Strict TDD, source: the maintainer's global configuration. Runner: `pnpm vitest run <file>`.
  RED for T1 is the observed 77 failures in this linked worktree before any edit; record the exact
  count and one diff line carrying the branch name. GREEN is the same file passing here.
- `test-safety`: `runtime.test.ts` and `worktree.test.ts` are append-and-amend only. Run the
  per-file test census before and after; no test may disappear. Amending ~90 constructions to pass
  two options is an amendment, not a deletion, but say so.
- `privacy-guard`: fixtures keep their invented paths and users; nothing from this host.
- `platform-ports`: every `AgentRuntime` in tests names its platform explicitly.
- Technical artifacts in English. Comments state the constraint and the why.
- Conventional Commits, imperative, subject ends with `(#477)`, no attribution trailers.

## Tasks

- [x] **T1 — `fs` and `platformAdapters` become required on `AgentRuntimeOptions`; every test
      injects them.** Route: delegated (writer). Delete the two defaults at `runtime.ts:967-974`,
      let `pnpm typecheck` enumerate every site, give each a `FakeFs` and an explicit platform
      through the existing shared helper. GREEN: `runtime.test.ts` passes in this worktree, and
      `pnpm typecheck` is clean. Done — see Progress.
- [ ] **T2 — `resolveProjectRoot` stops when its walk leaves the path it was given.** Route:
      delegated (same writer). A test in `worktree.test.ts` with a fake fs and a POSIX `dirname`
      over a Windows-shaped cwd asserts the walk never asks the fs about `.` (or any path outside the
      given root) and answers "no repository" instead. Then the guard: stop when `dirname(p) === p`
      or the walk reaches `.`. Existing walk tests keep passing.

## Acceptance

From this linked worktree: `pnpm vitest run src/main/runtime/runtime.test.ts` passes every case
that passed on a plain clone (382), and the whole `pnpm test` is green with no diff mentioning this
branch's name. From the main checkout the suite is unchanged.

## Checks

The seven checks `CONTRIBUTING.md` lists, in CI's order, plus the per-file test census from
`skills/test-safety/SKILL.md` on `runtime.test.ts` and `worktree.test.ts`.

**Known environmental failures on this branch:** none. The 77 `runtime.test.ts` failures are the
defect under repair, not an environmental failure to excuse.

## Delivery

Strategy: `ask-on-risk` (default). Forecast: ~250–450 authored changed lines, most of them
mechanical option injection in `runtime.test.ts`; if the correct fix crosses ~400 that is expected
and not a reason to split artificially. Native review (RDD, on) runs per work-unit commit against
`--base-ref main --committed-only`.

## Progress

Created 2026-09-21. Worktree `DwarfAI-Miners-worktrees/fix-477`, branch
`fix/runtime-test-real-fs-477` off `main` 1be0e19.

### T1 — done, 2026-09-21

**RED did not reproduce as written, and that is recorded rather than papered over.** The plan
expected `pnpm vitest run src/main/runtime/runtime.test.ts` to show the 77 failures measured on
2026-09-18 on a macOS host. Run first, unedited, in this linked worktree: `414 passed | 0 failed`
(`rtk proxy pnpm vitest run src/main/runtime/runtime.test.ts`). Root cause, read from the code
rather than guessed: `createPlatformAdapters()`'s own default is `options.platform ??
currentPlatform()` (`platformAdapters.ts:292`) — on the macOS host the 77 failures were measured on,
EVERY construction that omits `platformAdapters` defaults to `darwin`, so `resolveProjectRoot`'s walk
uses POSIX `dirname` against this suite's Windows-shaped fixture cwds (`'C:\\work\\project'`) and
degenerates to `'.'` almost everywhere. This machine is `win32`; the same omitted-`platformAdapters`
sites default to REAL `win32` `dirname`, which does not degenerate on a backslash path, so the walk
correctly finds nothing and returns early — no leak, no failure, on every one of them. The defect
is host-dependent, not absent. Proved directly rather than left as a theory: a throwaway test (never
committed, deleted immediately after) calling `resolveProjectRoot('C:\\work\\project', new NodeFs(),
'linux')` — the one explicit non-`win32` platform this suite already used without an `fs` override,
at the `'refuses to launch OpenCode before ever probing its own detector'` block — returned

```
+       "root": "C:/Users/j/Desktop/DwarfAI-Miners",
+       "worktree": { "branch": "fix/runtime-test-real-fs-477", "path": "C:\\work\\project" },
```

i.e. this checkout's own real path and this branch's own real name, read off the real disk, on this
host, before any edit — the same class of leak the issue describes, reproduced directly rather than
through the specific 77-count. `pnpm typecheck` served as the real RED for the mechanical part of
T1, exactly as the plan's Method section already named it: clean before, then it named every one of
the ~90+2 construction sites once the two defaults were deleted.

**What changed.** `runtime.ts`: `fs`/`platformAdapters` required on `RuntimeOptions`; the
`options.fs ?? new NodeFs()` / `options.platformAdapters ?? createPlatformAdapters(...)` composition
deleted outright (not guarded); `darwinConsoleInput`/`linuxConsoleInput` options removed from
`RuntimeOptions` too — they existed only to feed that now-deleted composition, and index.ts already
computes the same two settings locally, so they moved to index.ts's own `createPlatformAdapters`
call instead of staying as dead options nobody reads. `runtime.test.ts`: every `new AgentRuntime(`
site given an explicit `fs`/`platformAdapters` via a TypeScript-AST codemod (not written by hand;
verified after by re-running the same codemod in dry-run mode until it reported zero remaining
sites) — 82 of 97 sites touched, 15 already had both. `registry.test.ts`: 2 sites, `platformAdapters`
added (both already had `fs`). `fakePlatformAdapters.ts`: new, holds `worktreePlatformAdapters()`
moved verbatim out of `runtime.test.ts` — see Scope for why. `index.ts`: DID need a change, contrary
to the plan's expectation — it never passed `fs`/`platformAdapters` at all, relying entirely on the
two defaults. Now composes `home`/`fs`/`appPaths` once and passes all three plus a `platformAdapters`
built by the same `createPlatformAdapters(...)` call the deleted default used to make, on identical
terms (same `relayModel`, `relayTimeoutMs`, `fs`, `cliOverrides`, and the same darwin/linux
console-input overrides, now composed here instead of forwarded through `RuntimeOptions`).

**One test-safety-relevant amendment beyond mechanical option injection.** Deleting the `fs` default
surfaced a genuine pre-existing race in `'does not write a row for every poll of the same unchanged
project'`: it never overrode `tiers`, so a background tier walk (#41) raced its own three `refresh()`
calls. Over the real `NodeFs` this used to default to, the walk's real disk I/O apparently never
completed within the test's own synchronous poll loop, so `knownTier` stayed `undefined` throughout
— by accident, not by anything the test asserted. Over the now-explicit `FakeFs`, the same walk
finishes fast enough to land mid-sequence, and a tier's first measurement forces its own write
(`projectObserver.ts`'s "a first measurement never waits" rule) — a second, legitimate write the
throttle assertion (`toHaveBeenCalledTimes(1)`) was never testing for. Fixed by settling a
dedicated `TierService` before constructing the runtime, the same idiom `vaultRuntime` already uses
a few hundred lines above it in the same file — not by loosening the assertion. No case was removed.

**Census** (`node skills/test-safety/assets/test-census.mjs`): `runtime.test.ts` 415 → 415 (0),
`registry.test.ts` 6 → 6 (0). Net 0; no file lost test statements. (415 written vs 414 vitest-reported
is `it.each`/case-count skew the census tool documents as expected, not a discrepancy — unchanged
before and after this task.)

**GREEN observed:** `pnpm typecheck` clean (`tsc` + `vue-tsc`, no errors). `runtime.test.ts` +
`registry.test.ts` + `worktree.test.ts` together: 439 passed, 0 failed. Full `pnpm test`: 7647
passed, 5 skipped (pre-existing, unrelated), 0 failed, 278 files passed + 2 skipped. `pnpm lint`:
clean. `pnpm format:check`: clean (prettier already matched on every touched file). `node
skills/skill-sync/assets/sync.mjs --check`: `AGENTS.md already up to date`. `pnpm build`: succeeded
(confirms `fakePlatformAdapters.ts`'s `vitest` import never reaches the production bundle — it is
only ever imported from test files). Privacy guard: `PRIVACY_GUARD_PATTERN` is not set in this
environment (a maintainer/CI secret), so the literal command could not run; `git diff` and the new
file were read by eye against the placeholder table instead — no real path, host or username found.
Commit: recorded at the top of T2's Progress entry below (this document is part of T1's own commit,
so it cannot carry that commit's own hash).
