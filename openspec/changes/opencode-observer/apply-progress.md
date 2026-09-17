# Apply progress: opencode-observer

Change: `opencode-observer` · Tracking issue: **#444** · Artifact store: openspec, repo-local ·
Delivery: `exception-ok`, `size:exception` — ONE PR for the whole change, committed per work unit.

Strict TDD is active (`openspec/config.yaml`). This file is the cumulative record across batches;
merge into it, never overwrite it, on a later apply run.

## Status

49/49 tasks done. All four PR slices complete.

## TDD Cycle Evidence

| Task                                  | RED                                                                                                                                        | GREEN                                                                                                                                                     | REFACTOR                                                                                                                                                                                                                                                                                                   | Notes                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| PR 1 (1.1–1.12)                       | N/A                                                                                                                                        | N/A                                                                                                                                                       | N/A                                                                                                                                                                                                                                                                                                        | Evidence/fixtures/docs slice — "nothing compiles against this slice; RED/GREEN does not apply" (tasks.md header for PR 1) |
| 2.1/2.2 `store.ts`                    | `store.test.ts` written; ran red — `Cannot find module './store'`                                                                          | `store.ts` (`opencodeDbPath`, `opencodeWalPath`) — 4/4 pass                                                                                               | none needed                                                                                                                                                                                                                                                                                                |                                                                                                                           |
| 2.3/2.4 `parse.ts` message half       | `parse.test.ts` message describe blocks; red — `Cannot find module './parse'`                                                              | `parseOpenCodeMessageData`, `parseOpenCodeModel` — 10/10 pass                                                                                             | Refactored both to accept the raw JSON string via a shared `parseJsonRecord` helper once the part+feed half needed it (state.ts hands over unparsed TEXT); message-half tests re-ran green unchanged                                                                                                       |                                                                                                                           |
| 2.5/2.6 `parse.ts` part+feed half     | Appended part/feed describe blocks; red — `parseOpenCodePartData`/`openCodeFeedRows`/`lastAssistantText`/row types missing                 | `parseOpenCodePartData`, `openCodeFeedRows`, `lastAssistantText` — 25/25 pass (whole file)                                                                | `permissionSummary.ts`'s `TOOL_ACTIVITY_KINDS` gained one entry (`glob: 'search'`) so a tool part can produce a line at all — see deviation note in tasks.md 2.6                                                                                                                                           |                                                                                                                           |
| 2.7/2.8 `state.ts` + `stateSeed.ts`   | `state.test.ts` against `MemorySqlite`; red — `Cannot find module './state'`                                                               | `readOpenCodeSessions`, `readOpenCodeEventSeqs`, `readOpenCodeNewestAssistant`, `readOpenCodeMessages` — 13/13 pass                                       | Two fixes mid-GREEN: (a) test fixtures needed a `session` row inserted first — `message`/`part` carry real FK constraints `node:sqlite` enforces; (b) `readOpenCodeMessages` reads DESC+LIMIT for the newest N then reverses to the ascending `time_created, id` order the design and the test both expect |                                                                                                                           |
| 2.9/2.10 `feedWindow.ts` export       | Appended `cursorIndex` describe block to `feedWindow.test.ts`; red — `cursorIndex is not a function`                                       | Added `export` to the already-standalone `cursorIndex` — 57/57 pass (whole file)                                                                          | none needed                                                                                                                                                                                                                                                                                                |                                                                                                                           |
| 3.1/3.2 `contracts.ts`                | Amended `contracts.test.ts:62`'s pinned array; red — expected 4 entries, got 3                                                             | Added `'opencode'` to `DWARF_PROVIDERS` — 170/171 pass, only the amended assertion moved                                                                  | none needed                                                                                                                                                                                                                                                                                                |                                                                                                                           |
| 3.3/3.4 `config.ts`                   | Appended `config.test.ts`/`configFile.test.ts` cases; red — `providers.opencode` undefined                                                 | `OpenCodeConfig`, `readOpenCodeConfig`, `defaultConfig`/`loadConfig` entries — 114/114 pass                                                               | none needed                                                                                                                                                                                                                                                                                                |                                                                                                                           |
| 3.5/3.6 `opencodeProvider.ts` scan/D3 | New `opencodeProvider.test.ts` (discovery+liveness+retention+#12); red — module missing                                                    | `OpenCodeProvider.scan()` — 14/14 pass first GREEN pass, then a barrel-omission fix (below)                                                               | Discovered `dwarfSilenceWindowMs` was never re-exported by `main/domain/types.ts` (only `dwarfSilenceWindowKey` was) — added it, a pre-existing barrel gap no main-process file had needed until now                                                                                                       |                                                                                                                           |
| 3.7/3.8 `opencodeProvider.ts` feed    | Appended feed describe block; red — 4/20 failing (lastMessage, feedPage missing, redaction marker)                                         | `feed`/`feedPage`/`lastMessage` wired over `state.ts`+`parse.ts`+`feedWindow.ts` — 20/20 pass                                                             | Fixed one wrong test literal (`'REDACTED'` → `'[redacted]'`, the real `REDACTED` constant)                                                                                                                                                                                                                 |                                                                                                                           |
| 3.9/3.10 topology                     | Appended topology describe block (measured row-4 fixture pair + 3 more cases); ran GREEN immediately                                       | N/A — logic already correct from 3.6's single-pass `parentSessions` population                                                                            | Confirms the single-pass design (all sessions read in one query) needed no separate "post-scan promotion" pass, unlike Codex's incremental discovery                                                                                                                                                       |                                                                                                                           |
| 3.11/3.12 registry row                | New `opencodeProviderRegistry.test.ts`; red — `PROVIDER_REGISTRY.opencode is not a function`                                               | Added the registry row — 9/9 pass (registry.test.ts + new file)                                                                                           | Fixed a stale-clock test bug (session row needs `timeUpdatedMs` near `Date.now()` since the registry-built provider uses the real clock)                                                                                                                                                                   |                                                                                                                           |
| 3.13 pathPortability pin              | Appended OpenCode path case; ran GREEN immediately (builders already correct)                                                              | N/A                                                                                                                                                       | none needed                                                                                                                                                                                                                                                                                                |                                                                                                                           |
| 3.14/3.15 compile-site arms           | Appended cases to `launch.test.ts`, `launchProviders.test.ts`, `launchTuning.test.ts`; red — 2 failing (undefined effort levels, no throw) | `PRODUCT_NAME.opencode`, `PROVIDER_EFFORT_LEVELS.opencode: []`, `buildLaunchArgs`'s refusing arm, `actionBar.ts`'s `LAUNCH_COMMAND.opencode` — 70/70 pass | `launchProviders.test.ts`'s "installed && !launchable" case passed even before the GREEN step, since `agentProviderList` was already generic over `DWARF_PROVIDERS`/`LAUNCHABLE_PROVIDERS`                                                                                                                 |                                                                                                                           |
| 3.16/3.17 launch gate                 | Appended to `launchRunner.test.ts` and `runtime.test.ts`; red — both failing (no gate, wrong error text)                                   | `LAUNCHABLE_PROVIDERS.includes(provider)` gate before `detector.detect` in `launchClaudeSession` — 57/57 and 376/376 pass                                 | none needed                                                                                                                                                                                                                                                                                                |                                                                                                                           |
| 3.18/3.19 model catalogue             | Appended `agentModelCatalog.test.ts` case, amended `runtime.test.ts`'s order + 5 length assertions; red — 1 failing (function missing)     | `unavailableOpenCodeModelCatalog()` + `runtime.ts`'s 4th catalogue entry — 395/395 pass                                                                   | none needed                                                                                                                                                                                                                                                                                                |                                                                                                                           |

## Work Unit Evidence — PR 2

| Evidence                                          | Value                                                                                                                                                                                                                                    |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focused test command and exact result             | `pnpm exec vitest run src/main/providers/opencode/ src/main/providers/feedWindow.test.ts src/main/domain/permissionSummary.test.ts` — 42 (opencode/) + 57 (feedWindow) pass; permissionSummary.test.ts unaffected by the new table entry |
| Runtime harness command/scenario and exact result | N/A — PR 2's own modules are "unreferenced by production until PR 3" (tasks.md PR 2 header); no runtime surface exists yet                                                                                                               |
| Rollback boundary                                 | `src/main/providers/opencode/{store,parse,state,stateSeed}.ts` + their `.test.ts` siblings, the `feedWindow.ts`/`feedWindow.test.ts` export, and the one `permissionSummary.ts` table entry — revert this slice's commit alone           |

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

## Work Unit Evidence — PR 3

| Evidence                                          | Value                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focused test command and exact result             | `pnpm test src/main src/shared` — 267 files / 7135 passed, 5 skipped (full suite; PR 3 touches too many cross-cutting files for a narrower command to be meaningful)                                                                                                                                                                                                                                                                               |
| Runtime harness command/scenario and exact result | N/A this apply session — no live `npx opencode-ai` install/run available in this sandbox. `pnpm build` succeeded (electron-vite build, 923ms); a real `npx opencode-ai` turn + `pnpm dev` check is left for the maintainer/verify phase per the design's own runtime-harness column                                                                                                                                                                |
| Rollback boundary                                 | The contract arm (`contracts.ts:135`+test), `config.ts`'s `OpenCodeConfig` block, `src/main/providers/opencode/{opencodeProvider,opencodeProviderRegistry}.ts(.test.ts)`, `registry.ts`'s row, the six compile/gate sites (`launchProviders.ts`, `launchTuning.ts`, `launch.ts`, `actionBar.ts`, `launchRunner.ts`, `agentModelCatalog.ts`+`runtime.ts`), and `permissionSummary.ts`'s one added table entry — revert this slice's commit(s) alone |

Test census (`node skills/test-safety/assets/test-census.mjs`), run against HEAD (the PR 2 commit):

```
file                                                          before   after  delta
------------------------------------------------------------------------------------
src/main/config/config.test.ts                                    56      59  +3
src/main/config/configFile.test.ts                                28      30  +2
src/main/domain/agentModelCatalog.test.ts                         18      19  +1
src/main/domain/launchProviders.test.ts                           11      13  +2
src/main/domain/launchTuning.test.ts                              20      21  +1
src/main/providers/opencode/opencodeProvider.test.ts               0      25  +25  (new file)
src/main/providers/opencode/opencodeProviderRegistry.test.ts       0       3  +3  (new file)
src/main/providers/pathPortability.test.ts                         6       8  +2
src/main/runtime/runtime.test.ts                                 377     378  +1
src/main/sessionLaunch/launch.test.ts                             35      36  +1
src/main/sessionLaunch/launchRunner.test.ts                       57      58  +1
src/shared/contracts.test.ts                                      94      94  0

net +42 across 12 file(s).

No file lost test statements.
```

Full seven-check run for PR 3: typecheck (node+web) clean; lint clean; format:check clean on every touched source file (pre-existing openspec planning docs still excluded, see PR 1 risk note); skill-sync --check clean; `pnpm test` 7135 passed / 5 skipped; `pnpm build` succeeded. Privacy guard: same as PR 1/PR 2, manually reviewed (no real paths/usernames/hostnames introduced — all fixtures and test data use placeholders already established).

## Work Unit Evidence — PR 1

| Evidence                                          | Value                                                                                                                                                                         |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focused test command and exact result             | `pnpm test` (full suite, no test targets this slice yet): 262 files / 7049 passed, 2 skipped / 5054 total — unchanged from pre-slice baseline                                 |
| Runtime harness command/scenario and exact result | N/A — PR 1 is documents and fixtures only, no runtime surface (per tasks.md)                                                                                                  |
| Rollback boundary                                 | `docs/opencode-format.md`, `src/main/providers/__fixtures__/opencode/`, the `specs/opencode-session-topology/spec.md` delta — revert this commit alone, no other file touched |

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
- PR 3 deviation: `main/domain/types.ts` (the main-process barrel) did not re-export the `dwarfSilenceWindowMs` function — only `dwarfSilenceWindowKey` and `DWARF_SILENCE_WINDOW_MS` were re-exported, and only the renderer barrel had the function. This is a pre-existing gap (no main-process provider needed it before OpenCode), fixed by adding the one missing re-export line, following the exact AGENTS.md convention for barrel omissions. Called out per the apply skill's deviation rule even though it is a fix rather than new content.
- No live `npx opencode-ai` install was available in this apply session to exercise the design's own runtime harness ("`npx opencode-ai` one turn in a project folder, `pnpm dev`: dwarf appears, works, rests, leaves"). All behavior is proven against the measured fixtures (`measurements-2026-09-17.md`) and `MemorySqlite`/`FakeFs`; a real end-to-end check is recommended before/during `sdd-verify` or by the maintainer directly.
- Maintainer questions still open per design's Open Questions: row 3 residue (interactive TUI vs `opencode run` writing `session_message`/`session_input` — treated as closed per the addendum in `measurements-2026-09-17.md`), `tokensObserved`/ore (Q3, deliberately omitted in this slice), and the `readOpenCodeEventSeqs` poll-cost narrowing (instrumented only, not narrowed — see 3.20).

## PR 4 — Documentation rows — COMPLETE

- [x] 4.1 `README.md`: status line, Highlights bullet, first-run bullet, support-matrix row (`OpenCode session detection`), Provider support table row (`Read: yes, Launch: no, Hold: no`), and the "Session-data layouts" caveat bullet.
- [x] 4.2 `docs/guide.md`: the "Observer" bullet's provider list, a new OpenCode paragraph in §Providers in depth (no ore, no Send/Kick/Boost, the panel's own feed is the reading surface, `OPENCODE_CLI_PATH` for a broken PATH shim, `XDG_DATA_HOME` deliberately unread), the config table (`OPENCODE_STORE_ROOT`, `OPENCODE_CLI_PATH`) — and fixed a now-stale "All three providers can be read and launched" sentence found in the same section.
- [x] 4.3 `docs/privacy.md`: intro sentence and a new "What it reads" bullet for `opencode.db`, read-only.
- [x] 4.4 `docs/provider-formats.md`: a pointer row in the §5 confidence-summary table to `docs/opencode-format.md`.
- [x] 4.5 Topology outcome stated where users read it: the OpenCode paragraph in `docs/guide.md` names the row-4 result, and `docs/session-topology-and-roles.md` gained a short "Update (#444)" note confirming the anticipated model held for a third provider.
- [x] 4.6 Seven CI checks: typecheck (node+web) clean, lint clean, format:check clean, skill-sync --check clean, `pnpm test` 7135 passed / 5 skipped (no test files touched — docs only), `pnpm build` succeeded. Privacy guard manually reviewed (no paths, usernames or hostnames introduced).

## Final summary

All 49 tasks across PR 1–4 are complete. Four commits on `feat/opencode-observer` cover the whole
change: `ef02e6c` (evidence/fixtures + SDD artifacts), `e22358d` (pure store/parse/state modules),
`a02e44f` (contract growth, provider, wiring), `71d0afd` (documentation rows). Per this run's
delivery decision (`exception-ok` / `size:exception`), all of this lands as ONE pull request — the
orchestrator pushes and opens it; nothing here does.

## Remediation — verify findings

Verify (`verify-report.md`, evidence_revision `sha256:3a28c155…`, verdict **FAIL**) found two
critical findings. This section records their fixes; no other finding was in remediation scope.

### CRITICAL 1 — false redaction (privacy)

- **What was wrong**: `src/main/providers/__fixtures__/opencode/README.md` stated the maintainer's
  configured OpenCode agent nickname "is replaced here with the same placeholder throughout". It
  was not — the machine's real configured agent name appeared verbatim in five fixture files,
  `parse.test.ts` (7 occurrences), `docs/opencode-format.md:58` and
  `measurements-2026-09-17.md:99,126`. CI's guard greps four hardcoded literals and this value is
  none of them — the exact class `privacy-guard` warns a green build does not cover.
- **What changed**: every occurrence now reads `sample-agent` (9 files); the README paragraph
  names what the files actually carry (`sample-agent` standing in for the configured nickname,
  `general` — OpenCode's built-in subagent name — for the measured delegated child); the two
  "(the agent name OpenCode ran as)" parentheticals in `docs/opencode-format.md` and the
  measurements log now say "a placeholder for", so the measurement record stays true next to the
  substituted value.
- **Tests that prove it**: `pnpm exec vitest run src/main/providers/opencode` — 5 files, 69/69
  passed with the new placeholder (`parse.test.ts` 25/25), plus a repo-wide grep for the old value
  (tracked and untracked files, `node_modules`/`.git`/`out` excluded) printing zero files.
- **Commit**: `0569e53` `fix(opencode-observer): scrub the machine identifier from fixtures and
  document the true contents (#444)`.

### CRITICAL 2 — retention neutralised by the store-wide WAL mtime

- **What was wrong**: `opencodeProvider.ts`'s per-session `activityMs` included
  `walStat?.mtimeMs`. `opencode.db-wal` is one file for the whole store, so any session's write
  refreshed every session's `activityMs` — in the normal multi-session case no dwarf ever went
  stale, contradicting D3's own "store growth proves writes somewhere, not which session; it only
  gates cost".
- **RED (test first)**: appended `drops a frozen session even while another session keeps the
  store WAL hot` to `opencodeProvider.test.ts`'s retention describe — two root sessions, the
  frozen one's facts still, the active one's `time_updated` moved to the new now, the shared WAL
  re-added with its mtime stamped at the new now (`FakeFs.addFile` stamps a fixed mtime, so the
  WAL is registered with the future time directly). Run before the fix it **failed** with
  `AssertionError: expected [ 'ses_frozen', 'ses_active' ] to deeply equal [ 'ses_active' ]` — the
  frozen dwarf survived on the shared WAL's freshness, exactly the reported defect.
- **GREEN**: removed `walStat?.mtimeMs ?? 0` from the `Math.max` (the WAL still gates re-read cost
  through sizes, D2; a comment at the site records why the term is deliberately absent). The new
  test passed.
- **Knock-on seeds, stated out loud**: nine existing tests failed after the fix — every one a seed
  without a fresh per-session timestamp that the WAL floor had been carrying (`sessionInsert`
  defaults `time_updated` to 0; the row-4 fixtures' measured `time_updated` is a year stale
  against the test clock). Amended per `test-safety`: eight seeds gained `timeUpdatedMs: NOW`
  (the size-gate discovery case, never-waiting, mid-scan stability, the feed `seededSession`
  helper, the orphan, the null-parent root, both foreman-after-crew inserts, the worker-retention
  parent) and the row-4 test's clock now stands at `MEASUREMENT_NOW`, a minute after the fixtures'
  own `time_updated`. **No assertion was weakened, deleted or skipped** — each amendment is
  commented in place with `#444`. Side effect: the feed's "no reply yet" case is no longer
  vacuously satisfied, since the session now genuinely publishes.
- **Tests that prove it**: `pnpm exec vitest run src/main/providers/opencode` — 5 files, **70/70**
  passed.
- **Commit**: this commit — `fix(opencode-observer): never let the store-wide WAL mtime count as
  per-session activity (#444)`.

### Checks run for the remediation

| Check                                                              | Result                                                                                          |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `pnpm exec vitest run src/main/providers/opencode`                 | ✅ 5 files, 70/70 passed                                                                         |
| `node skills/test-safety/assets/test-census.mjs --base main`       | ✅ exit 0 — no file lost test statements (net +88 across 16 files; `opencodeProvider.test.ts` 0→26 as a new file vs main) |
| `pnpm typecheck`                                                   | ✅ exit 0 (node + web)                                                                           |
| `pnpm lint`                                                        | ✅ exit 0                                                                                        |

The full suite and `pnpm build` were deliberately not run — remediation scope is the two
criticals and their blast radius only.
