# Apply progress: opencode-observer

Change: `opencode-observer` · Tracking issue: **#444** · Artifact store: openspec, repo-local ·
Delivery: `exception-ok`, `size:exception` — ONE PR for the whole change, committed per work unit.

Strict TDD is active (`openspec/config.yaml`). This file is the cumulative record across batches;
merge into it, never overwrite it, on a later apply run.

## Status

49 tasks total. **23/49 done** (PR 1 and PR 2 complete). PR 3, PR 4 remain.

## TDD Cycle Evidence

| Task | RED | GREEN | REFACTOR | Notes |
| --- | --- | --- | --- | --- |
| PR 1 (1.1–1.12) | N/A | N/A | N/A | Evidence/fixtures/docs slice — "nothing compiles against this slice; RED/GREEN does not apply" (tasks.md header for PR 1) |
| 2.1/2.2 `store.ts` | `store.test.ts` written; ran red — `Cannot find module './store'` | `store.ts` (`opencodeDbPath`, `opencodeWalPath`) — 4/4 pass | none needed | |
| 2.3/2.4 `parse.ts` message half | `parse.test.ts` message describe blocks; red — `Cannot find module './parse'` | `parseOpenCodeMessageData`, `parseOpenCodeModel` — 10/10 pass | Refactored both to accept the raw JSON string via a shared `parseJsonRecord` helper once the part+feed half needed it (state.ts hands over unparsed TEXT); message-half tests re-ran green unchanged | |
| 2.5/2.6 `parse.ts` part+feed half | Appended part/feed describe blocks; red — `parseOpenCodePartData`/`openCodeFeedRows`/`lastAssistantText`/row types missing | `parseOpenCodePartData`, `openCodeFeedRows`, `lastAssistantText` — 25/25 pass (whole file) | `permissionSummary.ts`'s `TOOL_ACTIVITY_KINDS` gained one entry (`glob: 'search'`) so a tool part can produce a line at all — see deviation note in tasks.md 2.6 | |
| 2.7/2.8 `state.ts` + `stateSeed.ts` | `state.test.ts` against `MemorySqlite`; red — `Cannot find module './state'` | `readOpenCodeSessions`, `readOpenCodeEventSeqs`, `readOpenCodeNewestAssistant`, `readOpenCodeMessages` — 13/13 pass | Two fixes mid-GREEN: (a) test fixtures needed a `session` row inserted first — `message`/`part` carry real FK constraints `node:sqlite` enforces; (b) `readOpenCodeMessages` reads DESC+LIMIT for the newest N then reverses to the ascending `time_created, id` order the design and the test both expect | |
| 2.9/2.10 `feedWindow.ts` export | Appended `cursorIndex` describe block to `feedWindow.test.ts`; red — `cursorIndex is not a function` | Added `export` to the already-standalone `cursorIndex` — 57/57 pass (whole file) | none needed | |

## Work Unit Evidence — PR 2

| Evidence | Value |
| --- | --- |
| Focused test command and exact result | `pnpm exec vitest run src/main/providers/opencode/ src/main/providers/feedWindow.test.ts src/main/domain/permissionSummary.test.ts` — 42 (opencode/) + 57 (feedWindow) pass; permissionSummary.test.ts unaffected by the new table entry |
| Runtime harness command/scenario and exact result | N/A — PR 2's own modules are "unreferenced by production until PR 3" (tasks.md PR 2 header); no runtime surface exists yet |
| Rollback boundary | `src/main/providers/opencode/{store,parse,state,stateSeed}.ts` + their `.test.ts` siblings, the `feedWindow.ts`/`feedWindow.test.ts` export, and the one `permissionSummary.ts` table entry — revert this slice's commit alone |

Test census (`node skills/test-safety/assets/test-census.mjs`), run against HEAD (the PR 1 commit):

```
file                                       before   after  delta
-----------------------------------------------------------------
src/main/providers/feedWindow.test.ts          45      48  +3
src/main/providers/opencode/parse.test.ts       0      25  +25  (new file)
src/main/providers/opencode/state.test.ts       0      13  +13  (new file)
src/main/providers/opencode/store.test.ts       0       4  +4  (new file)

net +45 across 4 file(s).

No file lost test statements.
```

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

- PR 1: none — the fixture/doc set matches D1/D7/D9/D10 and the `opencode-store-evidence` spec.
- PR 2: `domain/permissionSummary.ts`'s `TOOL_ACTIVITY_KINDS` table gained one entry, `glob: 'search'`. Design's own "File Changes" table does not list `permissionSummary.ts`, but D1 explicitly requires OpenCode's `tool` parts to "become `activity` lines... spelled as Codex's are" — i.e. through the existing shared `toolActivityLine` mechanism — and that table is the only thing deciding whether a tool name produces a line at all. The one entry added is the one OpenCode tool name actually measured `[V]` (row 4, `measurements-2026-09-17.md`: the delegated child's own part was a real `tool: "glob"` call); an unmeasured OpenCode tool name still falls through to "no line", exactly like every other unrecognised tool already does. Flagged here per the apply skill's "note deviations, don't silently follow a different path" rule.

## Risks / follow-ups

- Pre-existing openspec planning artifacts from earlier SDD phases fail `prettier --check` (see 1.12 above). Not fixed here; flagged for whoever finalizes/archives this change, since reformatting another phase's content is outside apply's assigned task surface.
- Privacy guard could not be run with the real CI pattern locally (secret-gated); relied on manual placeholder review per `skills/privacy-guard/SKILL.md`.
- The `permissionSummary.ts` deviation above touches a file every provider's feed shares; its own test file (`permissionSummary.test.ts`) was re-run and is unaffected (existing assertions untouched, no new case added there since the OpenCode coverage lives in `opencode/parse.test.ts`).

## Remaining tasks

PR 3 (3.1–3.21), PR 4 (4.1–4.6) — 26 tasks remain.
