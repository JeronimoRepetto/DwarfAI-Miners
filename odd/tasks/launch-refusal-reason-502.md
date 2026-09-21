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
- [x] **T2 — The launcher's refusal carries path and cause, on every platform.** Route: delegated
      (same writer). `launchClaudeSession` turns a `resolveProgram` refusal and a spawn error into
      `<Product> could not be started: <path> — <cause>.` (or the closest shape the existing
      `notInstalledReason` precedent suggests). Tests in `launchRunner.test.ts` on `darwin` and
      `linux` with a spawn that rejects `EACCES`/`ENOENT`, and on `win32` with a refused shim,
      asserting the path and cause appear. Rewrite the `launchRunner.ts:31` comment.
- [x] **T3 — The two text-delivery callers stop saying `NOT_STARTED` blindly.** Route: delegated
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

Commit: `fix(cli): distinguish an unread shim's dialect from one needing cmd.exe (#502)` (49f7b0e).

### T2 — done

`launchRunner.ts`'s `couldNotStart` now takes `(provider, path, cause)` and returns
`` `${PRODUCT_NAME[provider]} could not be started: ${path} — ${cause}.` ``. `launchClaudeSession`
branches on `'kind' in program` for a `resolveProgram` refusal (path + `describeShimRefusal`), and
its `catch` now binds `(error)` and uses `detection.path` + `describeProgramFailure(error)` for a
spawn or shim-read failure. Rewrote the `launchRunner.ts:31` comment: it now states that a
path-less refusal (`EMPTY_PROMPT`, `NOT_LAUNCHABLE`) stays fixed copy, while `couldNotStart` names
the path and why, because a refusal naming nothing actionable is a dead end (#502).

RED (against unmodified `launchRunner.ts`, tests amended first — `cliDetection.ts`'s T1 change was
already in place, so `resolveProgram` already returned refusal objects the old `launchRunner.ts`
did not understand):
`pnpm vitest run src/main/sessionLaunch/launchRunner.test.ts` → `PASS (55) FAIL (3)` — the amended
Linux spawn-failure test, the new macOS spawn-failure test, and the amended Windows shim-refusal
test all failed on `toEqual` mismatches (old code still produced the fixed sentence, or called
`run` with a garbage invocation).

GREEN: `pnpm vitest run src/main/sessionLaunch/launchRunner.test.ts` → `PASS (58) FAIL (0)`.

Census: `launchRunner.test.ts` 58 → 59 (+1): the ENOENT/Linux test was amended in place and a new
EACCES/darwin test was added beside it (net +1); the Windows shim-refusal test was renamed and its
expectation amended in place (net 0).

Amended assertions: `launchClaudeSession > maps a spawn failure to a stated reason rather than a
silent no-op` → `names the path tried and the spawn error on Linux, rather than a fixed sentence`
(now asserts `${CLAUDE_PATH} — ENOENT.` appears); `launching Codex > says Codex could not be
started when the shim names nothing it can run` → `names the shim path and that its dialect was
not understood` (also drops the old comment's claim "never a path on the wire", which #502 asked
to stop being true). New: `names the path tried and the spawn error on macOS`.

Commit: `fix(launch): name the path tried and the cause in a launch refusal (#502)` (c5736bb).

### T3 — done

`codexQueue.ts` and `codexResume.ts` each replace their fixed `NOT_STARTED` constant with a
`notStarted(binaryPath, cause)` function (`` `The codex {queue,resume} command could not be
started: ${binaryPath} — ${cause}.` ``), used both where `resolveProgram` returns a `ShimRefusal`
(via `describeShimRefusal`) and in the `catch` for a spawn/read failure (via
`describeProgramFailure`). `docs/guide.md`'s `CODEX_CLI_PATH` paragraph (the one that already
documented the shim-resolution mechanism these two tiers share, #413) gained a paragraph stating
that a refusal now names the path tried and why, on all three platforms.

RED (against unmodified `codexQueue.ts`/`codexResume.ts`, tests amended first):
`pnpm vitest run src/main/textDelivery/codexQueue.test.ts src/main/textDelivery/codexResume.test.ts`
→ `2 failed (2) / 5 failed | 32 passed (37)` — all 5 on `expected 'The codex {queue,resume}
command could not be started.' to contain '<path>'`.

GREEN: same command → `2 passed (2) / 37 passed (37)`.

Census: `codexQueue.test.ts` 15 → 15 (0), `codexResume.test.ts` 22 → 22 (0) — every amendment was
in place, no test added or removed.

Amended assertions (both files, same pattern): the spawn-failure test now also asserts the binary
path and `ENOENT` appear in the error; the "shim names no JS entry" test (`codexQueue.test.ts`
only — `codexResume.test.ts`'s own comment says that case is covered exhaustively in
`codexQueue.test.ts`) now also asserts the shim path and "dialect was not understood" appear; the
"shim cannot be read at all" test in both files now also asserts the shim path appears.

Commit: `fix(codex): name the path tried when a queue or resume send refuses (#502)`.

### Verification

Run in the worktree, in `CONTRIBUTING.md`'s order:

- `pnpm typecheck` → clean (`typecheck:node` and `typecheck:web` both pass with no errors).
- `pnpm lint` → clean (`eslint .`, no errors or warnings).
- `pnpm format:check` → `All matched files use Prettier code style!`.
- `node skills/skill-sync/assets/sync.mjs --check` → `AGENTS.md already up to date (10 skill(s))`.
- `pnpm test` → `Test Files 278 passed | 2 skipped (280)`, `Tests 7654 passed | 5 skipped (7659)`.
  **`src/main/runtime/runtime.test.ts` did NOT show the predicted #477 environmental failure** —
  run in isolation it is `414 passed (414)`, 0 failed. The feature document's "known environmental
  failure" note was written before this worktree's branch name was known to be clean of whatever
  #477's 77 cases match on; nothing was excused, because nothing failed.
- `pnpm build` → both `out/preload` and `out/renderer` build clean, no errors.
- Per-file test census (`node skills/test-safety/assets/test-census.mjs --all`): `cliDetection.test.ts`
  38/38, `launchRunner.test.ts` 59/59, `codexQueue.test.ts` 15/15, `codexResume.test.ts` 22/22 — all
  `0` delta against their own now-committed state; net `0` across all 282 tracked test files. No
  test lost anywhere in the repository.

The privacy guard itself was not run (`PRIVACY_GUARD_PATTERN` is a CI secret, not available here);
checked by hand instead against the placeholders table in `skills/privacy-guard/SKILL.md` — every
fixture added or touched uses `C:\Users\j\...`, `/home/j/...`, `C:\tools\...` or `C:\npm\...`, never
this machine's real account name, and `git diff -- docs/guide.md | grep -i jeron` confirms the doc
change added no name.

Status: **done**. All three tasks implemented, tested (RED observed before each GREEN), and
committed. Full verification suite green, including the environmental-failure test the document
flagged as possibly excusable — it was not needed.

Out of scope noticed but not done (matches the document's own list, restated for the record): the
Windows console-hosting hop for an unrecognised `.cmd` wrapper still refuses without a path
(`launchRunner.ts:465-470`, needs its own measurement); no new per-platform convention rows were
added to `conventionalCliPaths`; `FsLike.exists` is still a bare `stat` with no executability
check.
