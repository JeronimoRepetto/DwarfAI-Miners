# Repo hygiene: a prettier pre-commit hook, delete `currentMaterialRow`, one rule for cross-process tests (#454)

## Objective

Three things the repository already knows are wrong or unfinished stop being instructions and
become facts: a commit with an unformatted staged file is refused locally; the dead
`currentMaterialRow` and its four tests are gone; and the rule for a test that imports across the
main ↔ renderer boundary is written once in `AGENTS.md` and followed by the three tests that today
handle it three ways.

## Problem

- On 2026-09-17 three agents committed files prettier rejects, although `AGENTS.md` and
  `CONTRIBUTING.md` both say to run the seven checks in CI order. PR #451 went red on it. An
  instruction that fails three times in a day needs a mechanism, not a repetition.
- `src/renderer/src/lib/vault/vault.ts:111` `currentMaterialRow` says of itself "NOTHING CALLS THIS
  TODAY … delete it and the four tests below it" once the mine card rebuild lands. It landed (#136);
  the only importer is `vault.test.ts`.
- `src/main/shell/panelBounds.test.ts:11-12` imports from `renderer/src/lib/scene/sceneSizing`;
  `window.test.ts:256` removed the same import and says so; `world.test.ts` hard-codes the value
  with a comment. Same need, three answers, no written rule.

## Why this shape and not another

- **Fixes that delete or mechanise; none that add machinery.** The hook is one committed POSIX `sh`
  script (git runs hooks through its own `sh` on Windows too) wired by `core.hooksPath`, no new
  dependency; `simple-git-hooks` + `lint-staged` would be two packages to do what six lines do.
  CI's `format:check` stays the backstop.
- **The hook checks, it does not rewrite.** `prettier --check` on the staged files, and a refusal
  that names the exact runnable exit: `pnpm exec prettier --write <files>` then re-stage. A hook
  that silently rewrites what the person staged hides the change from them.
- **The rule goes into the section that already owns boundaries** (`AGENTS.md`, "Boundaries that
  must survive", currently line 96), as one short paragraph, not a new section. `AGENTS.md` is 204
  of its 300-line budget.

## Scope

**Authorized:** a new `scripts/git-hooks/pre-commit` (or the equivalent path the writer justifies),
`package.json` (a `prepare` script that sets `core.hooksPath`, nothing else), `CONTRIBUTING.md`
(why the hook exists, the `--no-verify` emergency opt-out), `src/renderer/src/lib/vault/vault.ts`
and `vault.test.ts`, `AGENTS.md` (the boundaries section only, never inside generated markers),
`src/main/shell/panelBounds.test.ts`, `src/main/shell/window.test.ts`, the `world.test.ts` the issue
names (locate it), and this document.

**Out of scope, stated rather than silently dropped:** the optional duplicates the issue lists
(`normalize(path)` in the two fake fs files, `lastSegment` vs `projectNameForPath`); any change to
what CI runs; activating the hook in this shared `.git` during the session (see Constraints).

## Constraints

- **Do NOT activate the hook in this checkout's `.git`.** This worktree shares its `.git` directory
  with two sibling worktrees whose writers are committing right now; `core.hooksPath` lives in the
  shared config and would gate their commits mid-flight. Do not run the `prepare` script, do not set
  `core.hooksPath`, do not write into `.git/hooks`. Verify the script by invoking it directly (see
  T1). Activation happens when anyone runs `pnpm install` after merge, and the maintainer decides.
- Strict TDD where a test can exist (source: the maintainer's global configuration; runner:
  `pnpm vitest run <file>`). T1's RED/GREEN is the direct invocation of the hook script against a
  deliberately unformatted staged file: refused before the script exists, refused with the named
  exit once it does, accepted once formatted. T2 is a deletion: TDD is inapplicable; the proof is
  the census and the suite. T3 amends tests: run each file.
- `test-safety`: `vault.test.ts` loses exactly four tests, named in the commit body and in this
  document. `panelBounds.test.ts`, `window.test.ts` and `world.test.ts` are amended, never
  reduced; state every amendment.
- `skill-sync`: after editing `AGENTS.md`, `node skills/skill-sync/assets/sync.mjs --check` must
  pass; never edit inside its generated markers.
- `privacy-guard`: nothing from this host in any tracked file.
- Technical artifacts in English. Comments state the constraint and the why.
- Conventional Commits, imperative, subject ends with `(#454)`, no attribution trailers.

## Tasks

- [x] **T1 — A committed pre-commit hook refuses an unformatted staged file.** Route: direct inline (single mechanical script plus two small documentation edits; no unresolved design decision). POSIX `sh` script: collect staged files (`git diff --cached --name-only --diff-filter=ACMR -z`), filter to what prettier handles (`--ignore-unknown`), run `pnpm exec prettier --check` on them, exit non-zero with a message naming the exact command to fix and re-stage. `prepare` script in `package.json` sets `core.hooksPath` (added, never run — see Constraints). `CONTRIBUTING.md` documents why and the `--no-verify` opt-out.

      Evidence, all by direct invocation, never through `git commit`, `core.hooksPath` never set. Before the script existed: `git config --get core.hooksPath` exited 1 (unset), `.git/hooks/pre-commit` was inactive, and staging a deliberately unformatted `scratch-hook-test.ts` was not refused. With the script staged (mode 100755 via `git update-index --chmod=+x`) and that same file still staged, `sh scripts/git-hooks/pre-commit` exited 1 and printed `pnpm exec prettier --write scratch-hook-test.ts scripts/git-hooks/pre-commit` and `git add scratch-hook-test.ts scripts/git-hooks/pre-commit`. After `pnpm exec prettier --write scratch-hook-test.ts` and re-staging, the same invocation exited 0 ("All matched files use Prettier code style!"). Cleanup: `git restore --staged scratch-hook-test.ts`, then the file was deleted; tree left clean. Commit: `665bc98` — `chore(hooks): refuse a commit with an unformatted staged file, locally (#454)`.

- [x] **T2 — Delete `currentMaterialRow` and its four tests.** Route: direct inline (deletion plus one import fix in two already-understood files; TDD inapplicable per Constraints). Removed the function, its doc comment, and the now-unused `MineTier` import from `vault.ts`; removed the `currentMaterialRow` import and the `describe('currentMaterialRow', …)` block from `vault.test.ts`, replaced with a test-safety removal note (matching the `oreCount`/`TOKENS_PER_ORE` precedent in `economy.test.ts`) naming why and where the surviving coverage (`vaultRows`) lives. `rg currentMaterialRow src` still matches that one prose comment — no functional or import reference remains, the same shape as the existing `oreCount`/`TOKENS_PER_ORE` mentions the test-safety skill itself treats as correct.

      Census (`node skills/test-safety/assets/test-census.mjs`, working tree vs HEAD): `src/renderer/src/lib/vault/vault.test.ts` 17 → 13, delta −4. The four removed tests: "returns the row for the mine's current tier once it has reached a whole unit"; "returns undefined once the current tier has not reached a whole unit yet, even with older materials in the ledger"; "treats an absent breakdown as nothing mined"; "returns only the current tier's own row, never a total across materials". `pnpm vitest run src/renderer/src/lib/vault/vault.test.ts` → 13 passed, 0 failed. `pnpm typecheck:web` → clean. `pnpm exec eslint vault.ts vault.test.ts` → no issues. Commit: `a67c68f` — `fix(vault): delete currentMaterialRow, its four tests are gone with it (#454)`.

- [x] **T3 — One rule for tests that cross the process boundary, and three tests that follow it.** Route: direct inline (four already-understood files, no unresolved design decision — the rule was already decided by the issue text). Added the paragraph to `AGENTS.md`'s "Boundaries that must survive", right after the `contracts.ts` paragraph it extends (#77): a test file may cross main ↔ renderer only to pin a deliberate copy equal, with a comment beside the import naming the copy; production code never does.

      Amendments, one per file. `panelBounds.test.ts`: its existing `interiorColumnWidth`/`DESIGN_INTERIOR_WIDTH`/`SHELL_CONTENT_INSET` import from the renderer's `sceneSizing` had no comment; added one naming what it pins ("the derived columns" below) and citing the new rule — no test changed. `window.test.ts`: its comment explaining the removed import was itself stale — written 2026-09-03 10:29 for #90, it says the guarantee "moved to panelBounds.test.ts, which holds the MINE COLUMN to `MIN_PANEL_SIZE.width` and the copied scene chrome to `PANEL_CHROME.width`", but both constants were deleted from `sceneSizing.ts` by #137 (13:55 the same day) and #153 (14:49) replaced the fixed pairing with the derived one `panelBounds.test.ts` now pins. Verified with `git blame` and `git log -S"MIN_PANEL_SIZE"` before touching it (AGENTS.md's "Verified versus assumed"). Corrected the comment to name the current destination and constants and to say explicitly why this file holds no cross-process import today — no test changed. `world.test.ts`: already agrees with the rule (`VEIN_ANCHORS`/`REST_ANCHORS`/`POST_ANCHORS` are hard-coded from the renderer's `sceneLayout.ts` with a comment saying why: the main process must not reach into renderer art, and a change there should fail this test loudly) — no amendment needed or made, stated here rather than silently skipped. `node skills/skill-sync/assets/sync.mjs --check` → `AGENTS.md already up to date (10 skill(s))`, exit 0. `AGENTS.md` is 216 lines (budget 300). Census (working tree vs HEAD): `panelBounds.test.ts` 68 → 68 (0), `window.test.ts` 68 → 68 (0) — comment-only amendments, no test statement lost or added; `world.test.ts` untouched. `pnpm vitest run panelBounds.test.ts window.test.ts world.test.ts` → 157 passed, 0 failed. `pnpm exec eslint panelBounds.test.ts window.test.ts` → no issues. Commit: `01b59e4` — `docs(agents): write the rule for a test that crosses process boundaries (#454)`.

- [x] **T4 — Independent verifier follow-up: three fixes to the hook script and its docs.** Route: direct inline (one mechanical script fix plus one documentation sentence, no unresolved design decision). Fix 1 (should-fix): the printed `prettier --write`/`git add` fix command word-split on a staged path containing a space, so running it verbatim failed. `scripts/git-hooks/pre-commit` now builds the printed path list by converting the NUL-delimited staged list to one path per line, individually single-quoting each (embedded `'` escaped with the `'\''` idiom), and joining with spaces — still POSIX `sh`, no bashisms. Fix 2 (follow-up): a missing `pnpm` made the hook fail closed but print "prettier rejected" although prettier never ran; the script now checks `command -v pnpm` first and, if absent, names the real cause and exits 1. Fix 3 (follow-up): `CONTRIBUTING.md`'s hook paragraph gained one sentence telling a maintainer how to check (`git ls-files -s scripts/git-hooks/pre-commit` should show `100755`) and restore (`git update-index --chmod=+x scripts/git-hooks/pre-commit`) the tracked executable bit, since POSIX git silently skips a non-executable hook.

      Evidence, all by direct invocation, `core.hooksPath` never set. Space-path fix: staged `scratch dir/my file.ts` (deliberately unformatted, hook script itself left unstaged for this run so the printed command has one target). `sh scripts/git-hooks/pre-commit` exited 1 and printed `pnpm exec prettier --write 'scratch dir/my file.ts'` / `git add 'scratch dir/my file.ts'`. Running that printed command exactly as printed exited 0 (formatted and re-staged). `sh scripts/git-hooks/pre-commit` again exited 0 ("All matched files use Prettier code style!"). Three exit codes: 1, 0, 0. Missing-`pnpm` fix: staged a second unformatted scratch file, ran the hook with a `PATH` filtered to exclude pnpm's only shim directory (`/c/Users/jeron/AppData/Roaming/npm`, confirmed via `command -v pnpm` exiting 1 on that `PATH`) — the hook exited 1 and printed "pnpm not found on PATH, so staged files could not be checked with prettier. Install pnpm, or skip this check for a genuine emergency with `git commit --no-verify`.", never the misleading "prettier rejected" text. Plain case re-checked afterward (no space, `pnpm` present): still refuses an unformatted file and prints a correctly single-quoted command. All three scratch fixtures and the scratch directory were unstaged and deleted afterward; tree left clean. `pnpm format:check` and `pnpm lint` both re-run clean after the fix. Commit: this same commit (a hash cannot name itself; see `git log` for `chore/repo-hygiene-454`'s tip).

## Acceptance

Invoking the hook script directly with an unformatted staged `.ts` file exits non-zero and prints
the fix command; with the file formatted it exits 0. `currentMaterialRow` has no reference left in
`src/`. `AGENTS.md` carries the rule under its existing boundaries section and stays under 300
lines. All seven checks green.

## Checks

The seven checks `CONTRIBUTING.md` lists, in CI's order, plus the per-file test census from
`skills/test-safety/SKILL.md` on every test file touched.

**Known environmental failure on this branch:** documented as `src/main/runtime/runtime.test.ts`
failing ~77 cases whose diffs carry this checkout's branch name (#477, fixed on a sibling branch).
Checked explicitly and not observed here: `pnpm vitest run src/main/runtime/runtime.test.ts` → 414
passed, 0 failed, and the full `pnpm test` run showed 0 failures across all 280 files. Whatever
fixed #477 is already on `main` at this branch's base (`1be0e19`).

## Delivery

Strategy: `ask-on-risk` (default). Forecast: ~150–200 authored changed lines across T1–T3. Native
review (RDD, on) runs per work-unit commit against `--base-ref main --committed-only`.

## Progress

Created 2026-09-21. Worktree `DwarfAI-Miners-worktrees/fix-454`, branch `chore/repo-hygiene-454`
off `main` 1be0e19.

All three tasks done, one work-unit commit each: T1 `665bc98`, T2 `a67c68f`, T3 `01b59e4`. Full verification run after T3, in CI order: `pnpm typecheck` clean; `pnpm lint` no issues; `pnpm format:check` all files formatted correctly (after fixing this document's own formatting — a genuine Prettier markdown non-idempotency: `prettier --write` followed by `prettier --check` on the same file kept disagreeing with itself whenever a list item held 3+ blank-line-separated paragraphs, confirmed with a minimal repro outside the repo; fixed by merging each task's evidence and commit line into a single second paragraph per item, verified stable across two write/check cycles); `node skills/skill-sync/assets/sync.mjs --check` up to date; `pnpm test` 278 passed, 2 skipped (280 files), 7643 passed, 5 skipped (7648 tests), 0 failed — including `runtime.test.ts` (414/414), so the documented #477 environmental failure was not observed on this base; `pnpm build` succeeded. Privacy guard: the `PRIVACY_GUARD_PATTERN` secret is unavailable locally, so this was a manual review instead of the CI command — grepped every touched file for the maintainer's account name and for absolute host paths; the only matches are the project's existing public identity (GitHub handle, Ko-fi link, bundle id, author block), unchanged by this branch, and no host-specific path leaked into any tracked file.

T4 (this same commit) addresses an independent verifier's review of the pushed branch: the printed fix command breaking on a staged path with a space, a missing-`pnpm` failure printing a misleading cause, and a missing maintainer note on restoring the hook's tracked executable bit. `pnpm format:check` and `pnpm lint` re-run clean; `core.hooksPath` remained unset and `.git/hooks` untouched throughout.

### Verification of record, 2026-09-21

**Parent spot check.** Four commits plus the correction `54d953b`, all Conventional Commits, no
attribution trailers, clean tree. Re-ran `pnpm vitest run` on the three touched test files: 146
passed, 0 failed. `sync.mjs --check` up to date; `AGENTS.md` at 216 lines. `core.hooksPath` unset
and `.git/hooks` untouched throughout, as required by the shared `.git`.

**Native review (RDD): frozen, not closed.** `gentle-ai review assess` rated the candidate `high`
(`executable_mode` on `scripts/git-hooks/pre-commit`); consent was granted and a four-lens
transaction started (`review-0c68e1d7c065cacd`). `review-readability` was admitted; `review-risk`
and `review-resilience` failed with the same provider-side refusal seen on #502; the fourth capture
was refused with `rdd_disabled` because the maintainer turned the global switch off. The transaction
is frozen. No receipt exists; delivery follows ordinary repository policy.

**Independent verifier (Sonnet, read-only), the RDD-off path for a `high` candidate:**
`pass-with-follow-ups`, then one correction. The verifier reproduced a real defect in the first hook:
the printed fix command word-split a staged path containing a space, so the named exit did not run.
`54d953b` quotes each path individually (POSIX `sh`, `'\''` idiom), names the real cause when `pnpm`
is not on PATH instead of blaming prettier, and documents how to check and restore the executable
bit in `CONTRIBUTING.md`. The parent then reproduced the space-path case by direct invocation:
refusal exit 1 with `pnpm exec prettier --write 'scratch dir/my file.ts'`, the printed command ran
(exit 0), the re-run accepted (exit 0), scratch removed, tree clean.

Everything else the verifier confirmed independently: pnpm runs `prepare` on install and CI's only
workflow never runs `git commit`, so `core.hooksPath` being set there is harmless; census
`vault.test.ts` 17 → 13 with the four named tests, `panelBounds.test.ts` and `window.test.ts`
68 → 68; the corrected `window.test.ts` history claim matches the real commit timestamps of #137
and #153; `world.test.ts` already complied. All checks green (typecheck, lint, format:check,
sync --check, test 7643 passed, build). Not verified: the hook under a real macOS `/bin/sh` or
Linux `dash`; it is bashism-free by static reading only.

Next step: the pull request. Activation of the hook happens on the next `pnpm install` after merge.
