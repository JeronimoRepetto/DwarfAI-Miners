# Tasks: OpenCode observer — draw OpenCode sessions as dwarfs

Change: `opencode-observer` · Phase: sdd-tasks · Date: 2026-09-17 · Inputs: `design.md` (settled
architecture), the four specs under `specs/`, `proposal.md`, `measurements-2026-09-17.md`.

Strict TDD is on: every behaviour task is a **RED** test task followed by its **GREEN** task.
Test files this change did not create are **append-and-amend only** (`test-safety`); each amendment
task names the assertion it changes. Slice boundaries are the design's D9 PR slicing.

## Review Workload Forecast

| Field                   | Value                                                                     |
| ----------------------- | ------------------------------------------------------------------------- |
| Estimated changed lines | 1,430–1,880 authored (PR 1 ~475, PR 2 ~453, PR 3 ~699, PR 4 ~103)         |
| 400-line budget risk    | High                                                                      |
| 800-line budget risk    | Medium — PR 3 lands at ~699 and PR 1 rose to ~475 with the row-4 fixtures |
| Chained PRs recommended | Yes                                                                       |
| Suggested split         | PR 1 → PR 2 → PR 3 (→ PR 3b if over 800) → PR 4                           |
| Delivery strategy       | ask-on-risk                                                               |
| Chain strategy          | pending — orchestrator's call                                             |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

**PR 3 is the one to watch.** The design's trim: if it forecasts above 800 at apply time, split
topology (D4 — tasks 3.9, 3.10) into **PR 3b**; it is additive and independently revertible, and a
board that draws every OpenCode session as a root is honest until it lands. Measurement row 4 is
closed positive, so PR 3b is a review-load split, not an evidence gate. Contract, config, registry
row and compile sites cannot be split
(`PROVIDER_REGISTRY` is a `Record<DwarfProvider, …>`; `OpenCodeProvider.kind` is a `DwarfProvider`).

### Suggested Work Units

| Unit | Goal                                                      | PR   | Focused test command                  | Runtime harness                                                                                 | Rollback boundary                                                            |
| ---- | --------------------------------------------------------- | ---- | ------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1    | Evidence: format doc, redacted fixtures, spec amendment   | PR 1 | N/A — no code compiles against it yet | N/A: documents and fixtures only, no runtime surface                                            | `docs/opencode-format.md`, `__fixtures__/opencode/`, the topology spec delta |
| 2    | Pure store/parse/state modules + cursor helper            | PR 2 | `pnpm test src/main/providers`        | N/A: modules unreferenced by production until PR 3                                              | `src/main/providers/opencode/` + the `feedWindow.ts` export                  |
| 3    | `'opencode'` on the wire, provider, registry, launch gate | PR 3 | `pnpm test src/main src/shared`       | `npx opencode-ai` one turn in a project folder, `pnpm dev`: dwarf appears, works, rests, leaves | The contract arm and every site in D5's two tables                           |
| 4    | User-facing docs rows                                     | PR 4 | N/A — prose only                      | Read README + `docs/guide.md` against the shipped panel                                         | The four doc files                                                           |

Commit subjects end with the issue number (`AGENTS.md`); until task 1.1 lands, use `(#TBD)`.

---

## PR 1 — Evidence and fixtures (~475 lines; the design estimated 300–420 before row 4 closed positive)

Nothing compiles against this slice; RED/GREEN does not apply. `opencode-store-evidence` spec.

- [x] 1.1 Open the tracking issue for `opencode-observer` (orchestrator runs it) and replace `#TBD` in every later commit subject. Note in the issue body, for the later `opencode-held` change and not this one, that the OpenCode TUI spawns its server as a **separate process** (two run ids per launch in `log/opencode.log`: "loading tui config" and "creating instance") — files: none · dep: none · ~0 — tracking issue **#444**; every commit subject in this change uses `(#444)`.
- [x] 1.2 **MEASUREMENT — CLOSED POSITIVE, 2026-09-17.** Row 4: a live interactive-TUI turn delegating through the `task` tool produced a child `session` row whose `parent_id` is the parent session's id, with `agent: "general"`, the same `directory`, its own tokens/cost/messages/parts and a `variant` key inside its `model` JSON; the parent carries a `part` with `tool: "task"`, `state.status: "completed"`. **No live measurement remains open for this change.** · dep: none · ~0
- [x] 1.3 Create `docs/opencode-format.md` in `docs/codex-v2-format.md`'s register: build string 1.18.31, measurement date, host OS, `[V]`/`[I]` legend, the version floor, every row's verdict (1, 2, 3, 4, 5, 10) and the negative rows (no `storage/` tree, no pid column, no per-session JSONL, no `permission` row and no `session_message`/`session_input` row in the measured interactive turn). Paths described generically, never a real one; no guard pattern reproduced (`privacy-guard`) — files: `docs/opencode-format.md` · dep: 1.1 · ~170
- [x] 1.4 Write the two newly closed rows into that document. Row 3 residue: the measured turn was the **interactive TUI** (proven by the two run ids per launch in `log/opencode.log`) and `session_message` / `session_input` stayed empty even so — on 1.18.31 an interactive turn writes `session`, `message`, `part` and `event` only, so the feed reads `message` × `part` and there is no second read path to add. Row 4: positive, with its consequence — a worker is drawn beside its foreman · dep: 1.3 · ~18
- [x] 1.5 Create `src/main/providers/__fixtures__/opencode/opencode-schema.sql` from the measured DDL, foreign keys to unread tables stripped as `__fixtures__/codex/state-schema.sql:1-3` does · dep: 1.1 · ~45
- [x] 1.6 Create `__fixtures__/opencode/opencode-unknown-schema.sql`: same file name, tables renamed — the degradation fixture the evidence spec requires, committed regardless of row 2 · dep: 1.1 · ~12
- [x] 1.7 Create the four redacted `message.data` blob fixtures: `message-user.json`, `message-assistant-streaming.json` (no `time.completed`), `message-assistant-toolcalls.json` (`finish: 'tool-calls'`), `message-assistant-stop.json` · dep: 1.1 · ~60
- [x] 1.8 Create the six redacted `part.data` blob fixtures: `part-text.json`, `part-reasoning.json`, `part-tool.json`, `part-step-start.json`, `part-step-finish.json`, `part-unknown.json` (synthetic, unknown `type`) · dep: 1.1 · ~50
- [x] 1.9 Create the redacted **row-4 topology fixtures** now that the row is positive: `session-parent.json` and `session-child.json` (the child carrying `parent_id`, `agent: "general"`, the same `directory`, and a `model` JSON with the `variant` key), plus `part-task-tool.json` — the parent's `tool: "task"` part with `state.status: "completed"` · dep: 1.1 · ~55
- [x] 1.10 Create `__fixtures__/opencode/README.md` as `__fixtures__/antigravity/README.md` does, stating every redaction — including that **`session.agent` in the measured row is a user-configured agent name and was replaced**, plus `j`, `placeholder-host`, `Sample-Project`, repeated-digit ids · dep: 1.7, 1.8, 1.9 · ~45
- [x] 1.11 Amend `specs/opencode-session-topology/spec.md`: the "Row 4 unobserved — no populated parent on the measured build" scenario is replaced by a positive one — a `task`-tool delegation writes a child `session` row with `parent_id`, so a worker is drawn beside its foreman in the same mine. **State the removal out loud** in the delta and keep every other scenario intact (append-and-amend) · dep: 1.4 · ~20
- [x] 1.12 Run the seven CI checks in order (privacy guard, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `node skills/skill-sync/assets/sync.mjs --check`, `pnpm test`, `pnpm build`) and report PR 1 done · dep: 1.3–1.11 · ~0 — typecheck/lint/format:check(own files)/skill-sync/test(7049 passed)/build all green; privacy guard pattern secret unavailable locally, manually verified against the placeholder table (`j`, `placeholder-host`, `Sample-Project`, repeated-digit ids)

**No live measurement remains open.** Rows 1, 2, 3, 4, 5 and 10 all carry a recorded verdict, so no
task in PR 2, PR 3 or PR 4 is blocked on evidence.

## PR 2 — Pure modules (~453 lines)

No contract change; nothing here is referenced by production until PR 3. `opencode-session-feed`.

- [x] 2.1 **RED** `src/main/providers/opencode/store.test.ts`: `opencodeDbPath` / `opencodeWalPath` build `opencode.db` and `opencode.db-wal` from a POSIX root and a Windows root, asserted through `node:path.join` (`pathPortability.test.ts:8-15` idiom). Fixture: none · dep: PR 1 · ~30
- [x] 2.2 **GREEN** `opencode/store.ts` — two pure builders, `node:path.join`, never a hand-joined separator · dep: 2.1 · ~18
- [x] 2.3 **RED** `opencode/parse.test.ts` (message half): each of the four `message-*.json` fixtures parses to its typed record; `parseOpenCodeModel` reads `{"id","providerID"}` → `id` and ignores the extra `variant` key a delegated child's `model` carries [V row 4]; a non-JSON string → `null`; **`message.data.parentID` is never surfaced as a parent** · dep: 2.2 · ~55
- [x] 2.4 **GREEN** `opencode/parse.ts` — `parseOpenCodeMessageData`, `parseOpenCodeModel`; `JSON.parse` inside `try/catch`; unknown shape → `null` · dep: 2.3 · ~45
- [x] 2.5 **RED** `parse.test.ts` (part + feed half): the six `part-*.json` fixtures; `part-unknown.json` → `null`; feed rows ordered by `time_created, id`; `reasoning` parts absent from the feed; `tool` parts become `activity` lines spelled as Codex's; `step-*` emit nothing; `lastAssistantText` is the newest `text` part of the newest assistant message; redaction is NOT applied here · dep: 2.4 · ~70
- [x] 2.6 **GREEN** `parse.ts` — `parseOpenCodePartData`, `openCodeFeedRows`, `lastAssistantText` · dep: 2.5 · ~55 — **deviation**: `domain/permissionSummary.ts`'s `TOOL_ACTIVITY_KINDS` table gained one entry, `glob: 'search'` (the one OpenCode tool name measured [V], row 4), so a tool part can produce an activity line at all through the shared `toolActivityLine` mechanism the design says to reuse ("spelled as Codex's are"); not in design's File Changes table, called out here per the apply skill's deviation rule
- [x] 2.7 **RED** `opencode/state.test.ts` against `MemorySqlite` seeded from `opencode-schema.sql`: archived rows (`time_archived IS NOT NULL`) excluded; `parent_id` read; `MAX(seq) GROUP BY aggregate_id`; newest assistant message per session; `message` × `part` join order; and the same four queries against `opencode-unknown-schema.sql` answering `[]` with no throw · dep: 2.6 · ~70
- [x] 2.8 **GREEN** `opencode/state.ts` (`readOpenCodeSessions`, `readOpenCodeEventSeqs`, `readOpenCodeNewestAssistant`, `readOpenCodeMessages`, every helper tolerating `all()` → `[]`) and `opencode/stateSeed.ts` reading the schema and blob fixtures into `MemorySqlite` seeds, as `codex/stateSeed.ts` does · dep: 2.7 · ~70
- [x] 2.9 **RED** append to `src/main/providers/feedWindow.test.ts`: the cursor-resolution step currently private inside `readFeedPage` resolves a cursor against redacted rows, and reports `reachedStart` — append-and-amend, no existing case touched · dep: 2.8 · ~25
- [x] 2.10 **GREEN** `feedWindow.ts`: extract that step as an exported pure helper and have `readFeedPage` call it — behaviour unchanged for Codex, Claude and Antigravity · dep: 2.9 · ~15 — `cursorIndex` already stood alone inside `readFeedPage`; the only change needed was `export`
- [x] 2.11 Run the seven CI checks in order, then the per-file test census (`node skills/test-safety/assets/test-census.mjs`) on `feedWindow.test.ts` and paste its output · dep: 2.1–2.10 · ~0 — see apply-progress.md for the full census output (net +45 across 4 files, feedWindow.test.ts +3, no file lost test statements); typecheck/lint/format/skill-sync/test(7094 passed)/build all green

## PR 3 — Contract growth, provider, wiring (~699 lines)

`opencode-session-detection` and `opencode-session-topology`. Every test file below except the four
new ones is **append-and-amend**.

- [x] 3.1 **RED** amend `src/shared/contracts.test.ts:62`: the pinned `DWARF_PROVIDERS` list gains `'opencode'` — **stated amendment**, an existing assertion changing value · dep: PR 2 · ~6
- [x] 3.2 **GREEN** `src/shared/contracts.ts:135` — `'opencode'` in `DWARF_PROVIDERS`. No new wire symbol, so neither barrel changes (`main/domain/types.ts:131,152`, renderer barrel) · dep: 3.1 · ~2
- [x] 3.3 **RED** append to `src/main/config/config.test.ts` and `configFile.test.ts`, beside the existing precedence cases: `OPENCODE_STORE_ROOT` wins over the file key `providers.opencode.storeRoot`, blank falls through to the file rather than past it, and the default `~/.local/share/opencode` is identical for a fixed `home` on `win32`, `darwin` and `linux` with `process.platform` never read · dep: 3.2 · ~45
- [x] 3.4 **GREEN** `src/main/config/config.ts`: `OpenCodeConfig`, `ProviderConfigs.opencode`, `defaultConfig:195`, `readOpenCodeConfig` (`readTrimmed`), `loadConfig:405` entry. Reachable from the packaged `userData` file, not only `.env` (`config-layering`); bad shape degrades and warns, a path has no bad value at load time · dep: 3.3 · ~35
- [x] 3.5 **RED** create `opencode/opencodeProvider.test.ts` (liveness, D3) on `FakeFs` + `MemorySqlite` + injected `now`: appears within one scan; `working` while the newest assistant message lacks `time.completed`; still `working` after `finish: 'tool-calls'`; `working` when only `event.seq` advanced; the dwarf turns `'waiting'` once `time.completed` is set with `finish: 'stop'`; a stuck streaming row settles after `BUSY_WINDOW_MS` without a `seq` advance; `SessionStatus 'waiting'` is never reported (it is `busy`/`idle` only); missing root, missing db and unknown schema each → `[]` with no throw; unchanged db/wal sizes → zero `openReadOnly` calls; a worker leaves after the short `dwarfSilenceWindowMs`, a root after the long one; `onBeforeRead` mid-scan stability (#12) · dep: 3.4 · ~120
- [x] 3.6 **GREEN** `opencode/opencodeProvider.ts` `scan`: stat gate, `openReadOnly`, the three state reads, liveness, `Dwarf` build (`id` `opencode:<id>`, `cwd` from `session.directory` normalised with `node:path`, empty directory drops the session per the #166 guard, `name` from `agent`, `model` from the model JSON, `'unknown'` attendance, no `tokensObserved`), generation swap on success only · dep: 3.5 · ~110
- [x] 3.7 **RED** append to `opencodeProvider.test.ts` (feed): `lastMessage` is the newest assistant text and absent when none exists; `feed`/`feedPage` return `null` for an unknown id; paging older than the oldest row reports `reachedStart`; a secret in a user turn is redacted and a cursor built from the redacted row still matches; an unparseable `data` blob drops that row from the feed but not the session; the store vanishing between scan and read → `feed` `[]` and `feedPage` an empty page with `reachedStart: true`; `transcriptPath` → `undefined`; `textDelivery` → `null` · dep: 3.6 · ~70
- [x] 3.8 **GREEN** `opencodeProvider.ts` `feed`/`feedPage`/`transcriptPath`/`textDelivery` over `readOpenCodeMessages` → `openCodeFeedRows` → `redactSecrets` → `trimFeed` / the PR 2 cursor helper + `feedPageOf` · dep: 3.7 · ~50
- [x] 3.9 **RED** append to `opencodeProvider.test.ts` (topology, D4): a child with `parent_id` is ranked below the root and carries `parentId: 'opencode:<parent>'`; its parent is promoted `'foreman'` after the whole scan; a parent keeps `foreman` once the child is gone; a `parent_id` naming an absent session still publishes the child and invents no parent; a null `parent_id` is a root `foreman`; `message.data.parentID` is never read as topology. Fixtures: the measured `session-parent.json` / `session-child.json` pair from 1.9 · dep: 3.8 · ~45 — topology logic was already correct from 3.6 (parent set computed before the per-session loop, since all sessions are read in one query); these tests confirmed it green on first run
- [x] 3.10 **GREEN** topology in `opencodeProvider.ts` via a `parentSessions` set applied after the scan (`codexProvider.ts:954-974`); the child takes the short `dwarfSilenceWindowMs`, the promoted parent keeps the long one. **Split point for PR 3b if the slice forecasts above 800.** · dep: 3.9 · ~30 — folded into 3.6's single-pass implementation (see 3.9 note); no PR 3b split was needed at final size
- [x] 3.11 **RED** create `opencode/opencodeProviderRegistry.test.ts` as `codex/codexProviderRegistry.test.ts`: the row wires `storeRoot` through `expandPath` · dep: 3.10 · ~25 — written against `PROVIDER_REGISTRY.opencode` directly (codex's own file tests its SQLite registry, not `providers/registry.ts`'s row; `registry.test.ts` already asserts the table exhaustively over `DWARF_PROVIDERS`)
- [x] 3.12 **GREEN** `src/main/providers/registry.ts:107` — one factory row; no platform, no probe, no held-session lookup · dep: 3.11 · ~8
- [x] 3.13 **RED** append a POSIX-root OpenCode case to `src/main/providers/pathPortability.test.ts` — append-and-amend, no existing case touched (passes on 2.2's builders; it pins the provider's path surface against future edits) · dep: 3.12 · ~12
- [x] 3.14 **RED** append to `src/main/sessionLaunch/launch.test.ts` (the `buildLaunchArgs` arm throws `NOT_LAUNCHABLE` and invents no argv), `src/main/domain/launchProviders.test.ts` (`installed && !launchable` → `NOT_LAUNCHABLE`; **`LAUNCHABLE_PROVIDERS` does not grow — `launchProviders.test.ts:84` is unchanged**) and `launchTuning.test.ts` (`PROVIDER_EFFORT_LEVELS.opencode` is `[]`) · dep: 3.13 · ~35 — also amended `launchProviders.test.ts`'s "reports every known provider" case (stated amendment: 3-entry arrays → 4, DWARF_PROVIDERS grew)
- [x] 3.15 **GREEN** the four compile-site arms: `launchProviders.ts:91` `PRODUCT_NAME.opencode: 'OpenCode'`; `launchTuning.ts:76` `[]`; `launch.ts:259` refusing `case`; `src/renderer/src/lib/delivery/actionBar.ts:50` `LAUNCH_COMMAND.opencode: 'opencode run'` · dep: 3.14 · ~10
- [x] 3.16 **RED** append to `src/main/sessionLaunch/launchRunner.test.ts` (`launchClaudeSession({ provider: 'opencode' })` returns `{ launched: false, error: NOT_LAUNCHABLE }` and the detector fake records **zero** `detect` calls) and to `src/main/runtime/runtime.test.ts` (`launchAgent('opencode')` refuses the same way) · dep: 3.15 · ~30 — the runtime.test.ts case exercises the runtime's real default `launchSession` composition (platformAdapters.cliDetector), not an injected fake, so it proves the actual wiring
- [x] 3.17 **GREEN** `launchRunner.ts:612` — a `LAUNCHABLE_PROVIDERS.includes(provider)` gate **before** `detector.detect`, cheapest refusal first. The gate is absent today; this closes it for every non-launchable provider, not only OpenCode · dep: 3.16 · ~8
- [x] 3.18 **RED** append a case to `src/main/domain/agentModelCatalog.test.ts` for `unavailableOpenCodeModelCatalog()` (`source: 'none'`, `efforts: []`), and **amend `runtime.test.ts`**: the order assertion (now at a shifted line after the #444 gate test was appended earlier in the file) gains `'opencode'` last, and the five `toHaveLength(3)` assertions become `toHaveLength(4)` — **stated amendments**, five existing assertions changing value · dep: 3.17 · ~30
- [x] 3.19 **GREEN** `src/main/domain/agentModelCatalog.ts` `unavailableOpenCodeModelCatalog()` and the fourth entry in `runtime.ts:3418` `listAgentModels` · dep: 3.18 · ~20
- [x] 3.20 Wrap `readOpenCodeEventSeqs` in `pollProfiler.measureSync` and documented the tick-cost fallback in `docs/opencode-format.md` (no maintainer store exists yet to measure against — instrumentation only, no narrowing applied) · dep: 3.19 · ~8
- [x] 3.21 Run the seven CI checks in order, then the per-file test census on **every** amended test file — output pasted in apply-progress.md · dep: 3.1–3.20 · ~0

**skill-sync, confirmed:** `sync.mjs` builds the `main/` tree bullet from `readdirSync('src/main')`,
one level deep. `src/main/providers/opencode/` is nested under `providers`, which the bullet already
lists, so **the generated region does not change** and no `MAIN_TREE_GLOSSES` entry is needed.
`sync.mjs --check` still runs as CI check 5 in every slice.

## PR 4 — Documentation rows (~103 lines)

- [x] 4.1 `README.md` lines 42 / 84 / 160 / 201 / 258: status line, support matrix, Provider support table — observed, not launchable · dep: PR 3 · ~25 — also fixed a now-stale "All three providers can be read and launched" claim in `docs/guide.md` discovered while editing the same section
- [x] 4.2 `docs/guide.md`: provider list, §Providers in depth (no ore, no Send/Kick, the panel feed is the reading surface, `OPENCODE_CLI_PATH` for a broken PATH shim, `XDG_DATA_HOME` deliberately unread) and the config table at `:678` for `providers.opencode.storeRoot` · dep: 4.1 · ~45
- [x] 4.3 `docs/privacy.md:30`: a "What it reads" bullet for `opencode.db` · dep: 4.1 · ~8
- [x] 4.4 `docs/provider-formats.md`: a pointer row to `docs/opencode-format.md` · dep: 4.1 · ~10
- [x] 4.5 State the topology outcome where users read it: `docs/guide.md` §Providers in depth and the `docs/session-topology-and-roles.md` pointer gain the measured row-4 result — a `task`-tool delegation draws a worker beside its foreman in the same mine · dep: 4.2 · ~15
- [x] 4.6 Run the seven CI checks in order and report the change done · dep: 4.1–4.5 · ~0 — typecheck/lint/format:check/skill-sync/test(7135 passed)/build all green; privacy guard manually reviewed (docs-only slice, no paths/identifiers introduced)
