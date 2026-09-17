# Apply progress: opencode-observer

Change: `opencode-observer` · Tracking issue: **#444** · Artifact store: openspec, repo-local ·
Delivery: `exception-ok`, `size:exception` — ONE PR for the whole change, committed per work unit.

Strict TDD is active (`openspec/config.yaml`). This file is the cumulative record across batches;
merge into it, never overwrite it, on a later apply run.

## Status

49 tasks total. **12/49 done** (PR 1 complete). PR 2, PR 3, PR 4 remain.

## TDD Cycle Evidence

| Task | RED | GREEN | REFACTOR | Notes |
| --- | --- | --- | --- | --- |
| PR 1 (1.1–1.12) | N/A | N/A | N/A | Evidence/fixtures/docs slice — "nothing compiles against this slice; RED/GREEN does not apply" (tasks.md header for PR 1) |

PR 2 onward will carry real RED → GREEN → REFACTOR rows as each task lands.

## Work Unit Evidence — PR 1

| Evidence | Value |
| --- | --- |
| Focused test command and exact result | `pnpm test` (full suite, no test targets this slice yet): 262 files / 7049 passed, 2 skipped / 5054 total — unchanged from pre-slice baseline |
| Runtime harness command/scenario and exact result | N/A — PR 1 is documents and fixtures only, no runtime surface (per tasks.md) |
| Rollback boundary | `docs/opencode-format.md`, `src/main/providers/__fixtures__/opencode/`, the `specs/opencode-session-topology/spec.md` delta — revert this commit alone, no other file touched |

## PR 1 — Evidence and fixtures — COMPLETE

- [x] 1.1 Tracking issue #444 confirmed (orchestrator-opened); every commit subject in this change uses `(#444)`.
- [x] 1.2 Measurement already closed positive in tasks.md before this apply run.
- [x] 1.3 `docs/opencode-format.md` created: version floor 1.18.31, `[V]`/`[I]` legend, rows 1, 2, 3, 4, 5, 10 with verdicts, negative results section.
- [x] 1.4 Row 3 residue (interactive TUI, `session_message`/`session_input` stay empty) and Row 4 (positive, worker beside foreman) folded into the same document.
- [x] 1.5 `src/main/providers/__fixtures__/opencode/opencode-schema.sql` — the four read tables (`session`, `message`, `part`, `event`) plus real indexes; FKs to `project`/`event_sequence` (unread) stripped.
- [x] 1.6 `opencode-unknown-schema.sql` — four renamed tables, proves every query degrades to `[]`.
- [x] 1.7 Four `message.data` fixtures: `message-user.json`, `message-assistant-streaming.json`, `message-assistant-toolcalls.json`, `message-assistant-stop.json`.
- [x] 1.8 Six `part.data` fixtures: `part-text.json`, `part-reasoning.json`, `part-tool.json`, `part-step-start.json`, `part-step-finish.json`, `part-unknown.json`.
- [x] 1.9 Row-4 topology fixtures: `session-parent.json`, `session-child.json` (carries `parent_id`, `agent: "general"`, same `directory`, `variant` key in `model`), `part-task-tool.json`.
- [x] 1.10 `src/main/providers/__fixtures__/opencode/README.md` — every redaction stated, `session.agent` called out as a user-configured value that was replaced.
- [x] 1.11 `specs/opencode-session-topology/spec.md` amended: "Row 4 unobserved" scenario replaced by "Row 4 closed positive", removal stated out loud in a blockquote, every other scenario left intact.
- [x] 1.12 Seven CI checks run: typecheck clean, lint clean, format:check clean on every file this slice touched (pre-existing openspec planning docs from earlier phases — `design.md`, `exploration.md`, `measurements-2026-09-17.md`, `proposal.md`, `opencode-provider/exploration.md`, `config.yaml` — are NOT prettier-clean and were left untouched: they predate this apply run and reformatting someone else's phase artifact is outside this task's assigned surface; noted as a risk below), skill-sync --check clean, `pnpm test` 7049 passed / 5 skipped (baseline, no new tests this slice), `pnpm build` succeeded. Privacy guard: the `PRIVACY_GUARD_PATTERN` secret is not available in this local session, so the exact CI command could not be run; every fixture and doc was manually checked against the placeholder table (`j`, `placeholder-host`, `Sample-Project`, repeated-digit ids) instead.

## Deviations from design

None for PR 1 — the fixture/doc set matches D1/D7/D9/D10 and the `opencode-store-evidence` spec.

## Risks / follow-ups

- Pre-existing openspec planning artifacts from earlier SDD phases fail `prettier --check` (see 1.12 above). Not fixed here; flagged for whoever finalizes/archives this change, since reformatting another phase's content is outside apply's assigned task surface.
- Privacy guard could not be run with the real CI pattern locally (secret-gated); relied on manual placeholder review per `skills/privacy-guard/SKILL.md`.

## Remaining tasks

PR 2 (2.1–2.11), PR 3 (3.1–3.21), PR 4 (4.1–4.6) — 37 tasks remain.
