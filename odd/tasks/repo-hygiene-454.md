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

- [x] **T1 — A committed pre-commit hook refuses an unformatted staged file.** Route: direct inline
      (single mechanical script plus two small documentation edits; no unresolved design decision).
      POSIX `sh` script: collect staged files (`git diff --cached --name-only --diff-filter=ACMR
      -z`), filter to what prettier handles (`--ignore-unknown`), run `pnpm exec prettier --check`
      on them, exit non-zero with a message naming the exact command to fix and re-stage. `prepare`
      script in `package.json` sets `core.hooksPath` (added, never run — see Constraints).
      `CONTRIBUTING.md` documents why and the `--no-verify` opt-out.

      Evidence (direct invocation, never through `git commit`; `core.hooksPath` never set):
      - (a) before the script existed: `git config --get core.hooksPath` → exit 1 (unset);
        `.git/hooks/pre-commit` inactive; staged a deliberately unformatted `scratch-hook-test.ts`
        — nothing refused it.
      - (b) with the script staged (mode 100755 via `git update-index --chmod=+x`) and the same
        unformatted file still staged: `sh scripts/git-hooks/pre-commit` → exit 1, printed
        `pnpm exec prettier --write scratch-hook-test.ts scripts/git-hooks/pre-commit` /
        `git add scratch-hook-test.ts scripts/git-hooks/pre-commit`.
      - (c) after `pnpm exec prettier --write scratch-hook-test.ts` and re-staging:
        `sh scripts/git-hooks/pre-commit` → exit 0 ("All matched files use Prettier code style!").
      - Cleanup: `git restore --staged scratch-hook-test.ts` then deleted the file; tree clean.

      Commit: `665bc98` — `chore(hooks): refuse a commit with an unformatted staged file, locally (#454)`.
- [x] **T2 — Delete `currentMaterialRow` and its four tests.** Route: direct inline (deletion plus
      one import fix in two already-understood files; TDD inapplicable per Constraints).
      Removed the function, its doc comment, and the now-unused `MineTier` import from `vault.ts`;
      removed the `currentMaterialRow` import and the `describe('currentMaterialRow', …)` block from
      `vault.test.ts`, replaced with a test-safety removal note (matching the `oreCount`/
      `TOKENS_PER_ORE` precedent in `economy.test.ts`) naming why and where the surviving coverage
      (`vaultRows`) lives. `rg currentMaterialRow src` still matches that one prose comment — no
      functional/import reference remains, which is the same shape as the existing `oreCount`/
      `TOKENS_PER_ORE` mentions the census tool's own skill treats as correct.

      Census (`node skills/test-safety/assets/test-census.mjs`, working tree vs HEAD):
      `src/renderer/src/lib/vault/vault.test.ts` 17 → 13, delta −4. The four removed tests:
      1. "returns the row for the mine's current tier once it has reached a whole unit"
      2. "returns undefined once the current tier has not reached a whole unit yet, even with
         older materials in the ledger"
      3. "treats an absent breakdown as nothing mined"
      4. "returns only the current tier's own row, never a total across materials"

      `pnpm vitest run src/renderer/src/lib/vault/vault.test.ts` → 13 passed, 0 failed.
      `pnpm typecheck:web` → clean. `pnpm exec eslint vault.ts vault.test.ts` → no issues.

      Commit: `a67c68f` — `fix(vault): delete currentMaterialRow, its four tests are gone with it (#454)`.
- [x] **T3 — One rule for tests that cross the process boundary, and three tests that follow it.**
      Route: direct inline (four already-understood files, no unresolved design decision — the
      rule was already decided by the issue text). Added the paragraph to `AGENTS.md`'s "Boundaries
      that must survive", right after the `contracts.ts` paragraph it extends (#77): a test file may
      cross main ↔ renderer only to pin a deliberate copy equal, with a comment beside the import
      naming the copy; production code never does.

      Amendments, one per file:
      - `panelBounds.test.ts` — its existing `interiorColumnWidth`/`DESIGN_INTERIOR_WIDTH`/
        `SHELL_CONTENT_INSET` import from the renderer's `sceneSizing` had no comment; added one
        naming what it pins ("the derived columns" below) and citing the new rule. No test changed.
      - `window.test.ts` — its comment explaining the removed import was itself stale: written
        2026-09-03 10:29 for #90, it says the guarantee "moved to panelBounds.test.ts, which holds
        the MINE COLUMN to `MIN_PANEL_SIZE.width` and the copied scene chrome to
        `PANEL_CHROME.width`" — but both constants were deleted from `sceneSizing.ts` by #137
        (13:55 the same day) and #153 (14:49) replaced the fixed pairing with the derived one
        `panelBounds.test.ts` now pins. Verified via `git blame` and `git log -S"MIN_PANEL_SIZE"`
        before touching it (AGENTS.md's "Verified versus assumed"). Corrected the comment to name
        the current destination and constants, and to say explicitly why this file holds no
        cross-process import today (nothing left to pin). No test changed.
      - `world.test.ts` — already agrees with the rule (`VEIN_ANCHORS`/`REST_ANCHORS`/
        `POST_ANCHORS` are hard-coded from the renderer's `sceneLayout.ts` with a comment saying
        why: the main process must not reach into renderer art, and a change there should fail this
        test loudly). No amendment needed or made; stated here rather than silently skipped.

      `node skills/skill-sync/assets/sync.mjs --check` → `AGENTS.md already up to date (10 skill(s))`,
      exit 0. `AGENTS.md` is 216 lines (budget 300).

      Census (working tree vs HEAD): `panelBounds.test.ts` 68 → 68 (0), `window.test.ts` 68 → 68
      (0) — comment-only amendments, no test statement lost or added; `world.test.ts` untouched.
      `pnpm vitest run panelBounds.test.ts window.test.ts world.test.ts` → 157 passed, 0 failed.
      `pnpm exec eslint panelBounds.test.ts window.test.ts` → no issues.

      Commit: `TBD`.

## Acceptance

Invoking the hook script directly with an unformatted staged `.ts` file exits non-zero and prints
the fix command; with the file formatted it exits 0. `currentMaterialRow` has no reference left in
`src/`. `AGENTS.md` carries the rule under its existing boundaries section and stays under 300
lines. All seven checks green.

## Checks

The seven checks `CONTRIBUTING.md` lists, in CI's order, plus the per-file test census from
`skills/test-safety/SKILL.md` on every test file touched.

**Known environmental failure on this branch:** this is a linked git worktree, so
`src/main/runtime/runtime.test.ts` fails 77 cases whose diffs contain this checkout's branch name
(#477, being fixed on a sibling branch). Those, and only those, are not this change's.

## Delivery

Strategy: `ask-on-risk` (default). Forecast: ~150–200 authored changed lines across T1–T3. Native
review (RDD, on) runs per work-unit commit against `--base-ref main --committed-only`.

## Progress

Created 2026-09-21. Worktree `DwarfAI-Miners-worktrees/fix-454`, branch `chore/repo-hygiene-454`
off `main` 1be0e19.
