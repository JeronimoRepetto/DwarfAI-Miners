# A launch refusal names what could not be run and why, on all three platforms (#502)

## Objective

When the launcher cannot run the program detection found, the refusal the panel shows names the
path it tried and the cause, instead of the fixed sentence `<Product> could not be started.`

## Problem

Two collapses feed one opaque sentence:

- `resolveProgram` (`src/main/platform/cliDetection.ts:215-224`) answers `undefined` for two
  different facts on Windows: a `.cmd`/`.bat` shim whose text is not the npm/pnpm `cmd-shim`
  dialect (`resolveShimTarget` finds no quoted `.js` entry), and an entry that still carries a `%`
  variable only `cmd.exe` could expand.
- The `catch` in `launchClaudeSession` (`src/main/sessionLaunch/launchRunner.ts:672-674`) discards
  every spawn error on every platform — `ENOENT`, `EACCES`, a `#!` naming an absent interpreter —
  and returns `couldNotStart(provider)`.

Both callers of `resolveProgram` in text delivery do the same: `codexQueue.ts:149-150` and
`codexResume.ts:324-325` return `NOT_STARTED` with no cause.

The precedent for the right shape is one block above the catch: a missing CLI gets
`notInstalledReason(provider)` plus detection's own `reason` (`launchRunner.ts:626-634`).

## Why this shape and not another

- **A message fix, not machinery.** The information already exists at the line that drops it:
  `resolveShimTarget` knows which of its two `return undefined` it took, and the spawn error carries
  `code` and `path`. Threading them through is plumbing; no new state, flag or verb.
- **The rule "Fixed copy, and never a path" (`launchRunner.ts:31`) changes on purpose.** The
  maintainer's stated expectation in #502 is that the refusal names the path it tried. A refusal
  that names nothing the person can act on is a dead end; #502 treats a dead end as the highest
  severity class. Rewrite that comment to state the new rule and why, do not leave it contradicted.
- **One platform is not a special case.** The cause-carrying catch is the part that helps macOS and
  Linux today; the shim-dialect reason is the Windows half on top. Both ship in this change, with
  the platform passed explicitly in every test (`platform-ports`).

## Scope

**Authorized:** `src/main/platform/cliDetection.ts` and its test, `src/main/sessionLaunch/launchRunner.ts`
and its test, `src/main/textDelivery/codexQueue.ts` and `codexResume.ts` and their tests, the
`docs/` page that documents launch refusals (find it; do not create a new page), and this document.

**Out of scope, stated rather than silently dropped** (#502's directions 2–4, each a follow-up):

- Spawning an unrecognised `.cmd` wrapper directly on Windows through the console-hosting hop
  (needs its own measurement, `launchRunner.ts:465-470`).
- New convention rows per platform (Homebrew, npm-global) in `conventionalCliPaths`.
- An executability check behind the fs port (`FsLike.exists` is a bare `stat`).

## Constraints

- Strict TDD, source: the maintainer's global configuration. Runner: `pnpm vitest run <file>` for
  RED/GREEN per file, `pnpm test` for the suite. Observe RED before each implementation.
- `test-safety`: the test files touched exist already; append and amend, never delete. State every
  amended assertion in Progress.
- `privacy-guard`: fixtures use invented paths and users (`C:\Users\j\...`, `/home/j/...`), never
  the host's.
- Technical artifacts in English. Comments state the constraint and the why, in the register of
  `contracts.ts`.
- Conventional Commits, imperative, subject ends with `(#502)`, no attribution trailers.

## Tasks

- [x] **T1 — `resolveProgram` says which of its two refusals it took.** Route: delegated (writer).
      Replace the collapsed `undefined` with a result that distinguishes "shim found, dialect not
      understood" from "entry still needs cmd.exe", carrying the shim path. Tests in
      `cliDetection.test.ts` on `win32` with a fake fs: a `.cmd` whose text names no `.js` entry,
      and one whose entry survives expansion with a `%` still in it. A recognised `cmd-shim` and a
      POSIX bare name keep their current behaviour, asserted.
- [ ] **T2 — The launcher's refusal carries path and cause, on every platform.** Route: delegated
      (same writer). `launchClaudeSession` turns a `resolveProgram` refusal and a spawn error into
      `<Product> could not be started: <path> — <cause>.` (or the closest shape the existing
      `notInstalledReason` precedent suggests). Tests in `launchRunner.test.ts` on `darwin` and
      `linux` with a spawn that rejects `EACCES`/`ENOENT`, and on `win32` with a refused shim,
      asserting the path and cause appear. Rewrite the `launchRunner.ts:31` comment.
- [ ] **T3 — The two text-delivery callers stop saying `NOT_STARTED` blindly.** Route: delegated
      (same writer). `codexQueue.ts` and `codexResume.ts` surface the same reason. Tests amended in
      their files; docs page updated to describe what a refusal now says.

## Acceptance

Windows: a `claude.cmd` earlier on PATH than the npm-global install whose text is
`@python "%~dp0\wrapper.py" %*` → the panel says the shim at that path was found and not understood.
macOS/Linux: a non-executable `claude` earlier on PATH → the panel names the path and the OS cause.
On all three, a correct install keeps launching exactly as before, and `pnpm test` is green.

## Checks

The seven checks `CONTRIBUTING.md` lists, in CI's order, plus the per-file test census from
`skills/test-safety/SKILL.md` on every test file touched.

**Known environmental failure on this branch:** this is a linked git worktree, so
`src/main/runtime/runtime.test.ts` fails 77 cases whose diffs contain this checkout's branch name
(#477, being fixed on a sibling branch). Those, and only those, are not this change's. Any other
failing test is.

## Delivery

Strategy: `ask-on-risk` (default). Forecast: ~300 authored changed lines across T1–T3. Native
review (RDD, on) runs per work-unit commit against `--base-ref main --committed-only`.

## Progress

Created 2026-09-21. Worktree `DwarfAI-Miners-worktrees/fix-502`, branch
`fix/launch-refusal-reason-502` off `main` 1be0e19.

### T1 — done

`resolveShimTarget` now returns `ShimTarget | ShimRefusal`, where `ShimRefusal` is
`{ kind: 'dialect-not-understood', shimPath }` (no quoted `.js` entry at all) or
`{ kind: 'needs-cmd-exe', shimPath, entry }` (an entry survived expansion still carrying a `%`).
`resolveProgram` threads the same union through instead of collapsing both to `undefined`. Added
`describeShimRefusal` (the refusal in words) and `describeProgramFailure` (a caught spawn/read
error's own errno code, or its message) — both exported for the three callers T2/T3 update.

RED (against unmodified `cliDetection.ts`, `cliDetection.test.ts` amended first):
`pnpm vitest run src/main/platform/cliDetection.test.ts` → `PASS (29) FAIL (9)` — the 2 amended
`resolveShimTarget` refusal tests, the 2 amended/new `resolveProgram` refusal tests, and 5 new
tests for `describeShimRefusal`/`describeProgramFailure` (not yet exported). All failed with
`expected undefined to deeply equal {...}` or `is not a function`, as expected.

GREEN: `pnpm vitest run src/main/platform/cliDetection.test.ts` → `PASS (38) FAIL (0)`.

Census (`node skills/test-safety/assets/test-census.mjs --all`): `cliDetection.test.ts` 32 → 38
(+6): 2 amended in place (refusal shape, no count change), +1 new (`resolveProgram` needs-cmd-exe,
mirroring the existing `resolveShimTarget` case), +5 new (`describeShimRefusal` ×2,
`describeProgramFailure` ×3). No test lost.

Amended assertions: `resolveShimTarget > answers undefined for a shim that names no JS entry...`
→ `names the shim path and "dialect not understood" for a shim that names no JS entry`;
`resolveShimTarget > answers undefined when the entry hangs on a variable...` → `names the shim
path and the unexpanded entry when a variable still needs cmd.exe`; `resolveProgram > answers
undefined, never a guess, when the shim names no JS entry` → `names the shim path and "dialect not
understood" when the shim names no JS entry`. All three kept their original scenario; only the
expected shape changed from `undefined` to the new refusal object.

Commit: `fix(cli): distinguish an unread shim's dialect from one needing cmd.exe (#502)`.
