# Codex CLI / App session storage — investigation findings (2026-08-29)

Machine: Windows 11. Investigation is read-only; no repo files were modified. Scratch
scripts used for SQLite queries live in this same tmp dir (`codex-sqlite-*.cjs`).

## 1. Which codex is this — VERIFIED

Two genuinely different Codex products are installed and were running simultaneously:

| PID   | Image                      | Path                                                                                                                                     | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 32864 | `codex.exe`                | `...\pnpm\store\v11\links\@openai\codex\0.150.1-win32-x64\...\vendor\x86_64-pc-windows-msvc\bin\codex.exe`                               | **Classic CLI** (`codex-cli 0.150.1`, installed via pnpm/npm). `CommandLine` was empty — invoked bare, i.e. the interactive TUI, no `--working-dir` flag.                                                                                                                                                                                                                                                                                                                                                                                                           |
| 36612 | `codex.exe`                | `C:\Users\j\AppData\Local\OpenAI\Codex\bin\6ca77c4a9caa4eed\codex.exe`                                                                   | **OpenAI Codex desktop app** (Windows Store package `OpenAI.Codex_26.825.5331.0_x64`). Command line: `-c features.code_mode_host=true app-server --analytics-default-enabled -c "mcp_servers.codex_app=..."`. This is the app's **RPC/JSON server backend** (`app-server` subcommand), not the TUI event loop. `config.toml` also has `CODEX_CLI_PATH = 'C:\...\OpenAI\Codex\bin\6ca77c4a9caa4eed\codex.exe'` and a notify handler pointing at `WindowsApps\OpenAI.Codex_...\app\ChatGPT.exe` — confirming this binary belongs to the GUI app, not the CLI package. |
| 25880 | `codex-code-mode-host.exe` | same pnpm vendor dir as 32864                                                                                                            | Helper process for the `code_mode_host` feature flag enabled on the app-server's command line — a sandboxed code-execution host spawned by/for the app.                                                                                                                                                                                                                                                                                                                                                                                                             |
| 38248 | `codex-computer-use.exe`   | `...\OpenAI\Codex\runtimes\cua_node\426e88130fe66c7e\bin\node_modules\@oai\sky\bin\windows\codex-computer-use.exe`, `--parent-pid 34776` | Computer-use plugin child process. Parent PID 34776 is **not** any of the 4 given PIDs — it belongs to the Electron/host process of the desktop app (not captured in the given PID list).                                                                                                                                                                                                                                                                                                                                                                           |

`codex --version` (on PATH) reports `codex-cli 0.150.1` — the classic CLI package. This
is consistent with 32864/25880 being from the pnpm-installed vendor tree.

**Conclusion**: this machine runs both the classic CLI (TUI) _and_ the OpenAI Codex
desktop app side by side, and they are two different install trees/binaries that
happen to share `~/.codex` as CODEX_HOME. The `app-server` mode is a new RPC surface,
not the old interactive TUI.

## 2. `history.jsonl` — VERIFIED

Schema per line (JSON, one object per line): `{"session_id": "<uuid7>", "ts": <unix seconds>, "text": "<user prompt text>"}`.

Sample (first line):

```json
{
  "session_id": "01a0332c-e52e-7e82-93ad-5db880c842b4",
  "ts": 1787565001,
  "text": "Placeholder user prompt."
}
```

Sample (last line):

```json
{
  "session_id": "01a04d79-5c87-7a31-9b1a-4aacc350d6fd",
  "ts": 1788023343,
  "text": "Placeholder follow-up user prompt."
}
```

- Carries **session_id** and **timestamp** and the **raw prompt text** only.
- Does **not** carry cwd, model, or assistant replies — it's a flat, global,
  cross-session "input history" log (used for shell-style up-arrow recall / the
  desktop app's prompt suggestions), not a transcript store.
- 30 lines total in the whole file (23KB) — it is not append-only per turn; looks
  capped/rotated (or just low volume for this account).
- The last two lines' `session_id` (`01a04d79-5c87-7a31-9b1a-4aacc350d6fd`) is the
  **same thread that has a rollout file created at 14:23:14** (see §5) — i.e. this is
  the _continuation_ of an existing session, not a new one.

## 3. SQLite schema — VERIFIED

`node --version` → `v24.11.1`. `node:sqlite` (`DatabaseSync`, `{readOnly:true}`) works
fine against the live (WAL-mode) databases — no locking issues were hit; reads
transparently see WAL content. (Node emits an ExperimentalWarning, harmless.)

All five DBs use `sqlx` migrations (`_sqlx_migrations` table present in every one).

### `state_5.sqlite` — the thread/session registry (this is the one that matters most)

Table **`threads`** (136 rows) — one row per conversation thread, and it is rich:

```
id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
sandbox_policy, approval_mode, tokens_used, has_user_event, archived, archived_at,
git_sha, git_branch, git_origin_url, cli_version, first_user_message, agent_nickname,
agent_role, memory_mode, model, reasoning_effort, agent_path, created_at_ms,
updated_at_ms, thread_source, preview, recency_at, recency_at_ms, history_mode, name,
is_pinned, thread_section_id, section_position, section_entered_at_ms, project_id
```

Sample row (trimmed), the session referenced in the task background:

```json
{
  "id": "01a04d79-5c87-7a31-9b1a-4aacc350d6fd",
  "rollout_path": "C:\\Users\\j\\.codex\\sessions\\2026\\08\\29\\rollout-2026-08-29T14-23-14-01a04d79-5c87-7a31-9b1a-4aacc350d6fd.jsonl",
  "cwd": "\\\\?\\C:\\Users\\j\\Desktop\\Sample-Project",
  "source": "cli",
  "thread_source": "user",
  "model": "gpt-5.6-luna",
  "reasoning_effort": "medium",
  "cli_version": "0.150.1",
  "history_mode": "paginated",
  "tokens_used": "19290398",
  "git_sha": "dd4f96c...",
  "git_branch": "main",
  "preview": "Placeholder first user message ...",
  "recency_at_ms": "1788023343261",
  "updated_at_ms": "1788023349176"
}
```

- **cwd** is directly on the row (UNC-prefixed `\\?\C:\...`), no need to parse the JSONL.
- **model** + **reasoning_effort** are directly on the row too — no need to find a
  `turn_context` event.
- `source` is `"cli"` for user-initiated threads, `"vscode"` for the VS Code extension,
  and a **JSON blob** `{"subagent":{"thread_spawn":{"parent_thread_id":...,"depth":1,
"agent_path":"/root/<slug>","agent_nickname":"<Name>","agent_role":null}}}` for
  sub-agent threads spawned during a turn (Codex's own "Task tool" equivalent). This
  is a parent→child thread graph, mirrored in **`thread_spawn_edges`**
  (`parent_thread_id`, `child_thread_id`, `status`).
- `thread_source` distinct values seen: `user`, `subagent`, `automation`, `voice_chat`,
  `realtime_voice`, null. `vscode` is a value of the separate `source` column, not
  `thread_source` — the committed fixture's first row carries a `source` of `vscode`
  alongside a `thread_source` of `automation`
  (`__fixtures__/codex/rollout.jsonl:1`), and no registry row or rollout head was
  found with a `thread_source` of `vscode`.
- **`history_mode`** is either `legacy` (76 rows) or `paginated` (60 rows) — see §5,
  this is the key to the whole question.
- `rollout_path` is populated (and the file **still exists on disk**) for _both_
  legacy and paginated threads sampled.

Other tables in `state_5.sqlite`: `projects`/`project_roots` (multi-root project
registry for the app's project switcher), `thread_sections` (folder/grouping UI),
`thread_dynamic_tools`, `thread_artifacts` (both empty here),
`remote_control_enrollments` (0 rows — websocket remote-control feature, unused),
`external_agent_config_imports` (1 row — MCP/agent config imported from elsewhere),
and three **migration bookkeeping tables**: `backfill_state` (1 row,
`status:"complete"`, `last_success_at` from an old one-time run),
`rollout_migration_state`, `rollout_migration_skipped_rollouts` (both empty). These
confirm a one-time backfill process exists that reads old rollout files and imports
them as `paginated`-mode threads into the new cache — it explains why `legacy` and
`paginated` cli_versions overlap (e.g. `0.149.0-alpha.4.1` has both) rather than mode
being purely version-gated.

### `thread_history_1.sqlite` — the transcript cache/index (NOT the source of truth)

- **`thread_items`** (6639 rows): `thread_id, turn_id, item_id, rollout_ordinal,
created_at_ms, item_json, item_type, updated_at_ordinal`. `item_type` distinct
  values: `reasoning` (3295), `commandExecution` (1428), `mcpToolCall` (612),
  `agentMessage` (446), `fileChange` (228), `userMessage` (172), `webSearch` (154),
  `dynamicToolCall` (124), `subAgentActivity` (89), `collabAgentToolCall` (78),
  `contextCompaction` (12), `plan` (1).
  - **`agentMessage`** rows are the assistant's chat replies (`item_json.text`) — use
    these for the "speech bubble" text. Sample:
    `{"type":"agentMessage","id":"msg_...","text":"Placeholder assistant reply..."}`.
  - `userMessage` rows: `{"type":"userMessage","id":...,"content":[{"type":"text","text":"..."}]}`.
- **`thread_turns`** (169 rows): `thread_id, turn_id, rollout_ordinal, status,
error_json, started_at, completed_at, duration_ms, first_user_item_id,
final_agent_item_id, rollout_byte_offset, rollout_end_ordinal,
rollout_end_byte_offset`. `status` distinct values: `completed` (161), `failed` (4),
  `inProgress` (2), `interrupted` (2).
- **`thread_history_projection_state`** (60 rows — exactly matches the 60
  `paginated`-mode threads): `thread_id, next_rollout_byte_offset,
next_rollout_ordinal`. **This is the smoking gun**: for the known thread
  `01a04d79-...`, `next_rollout_byte_offset = 3602628`, and the actual rollout
  `.jsonl` file on disk is **exactly 3602628 bytes**. This table is a tailing
  cursor — `thread_history_1.sqlite` is built by **incrementally reading (projecting)
  the same JSONL rollout files** into queryable SQLite rows, not a replacement for
  them. `rollout_byte_offset`/`rollout_ordinal` columns throughout point back into the
  JSONL file's byte/line position.
- `thread_realtime_items` — 0 rows (presumably for voice/realtime session items).

### `logs_2.sqlite` — structured app/core log stream

Single real table **`logs`**: `id (autoincrement), ts, ts_nanos, level, target,
feedback_log_body, module_path, file, line, thread_id, process_uuid,
estimated_bytes`. 54,844 rows, 81.5MB. `target` values look like Rust module paths
(`codex_app_server::message_processor`, `codex_core::tasks`, `codex_core::session`,
`feedback_tags`, etc.) and `feedback_log_body` holds a formatted tracing-span log
line (tower/tracing style, e.g. `session_loop{thread_id=...}:submission_dispatch{...}:
interrupt received: abort current task`). `thread_id` is populated for
session-scoped log lines and null for app-server/global lines (e.g. `configRequirements/read`,
`list_models`). This is a genuine **live heartbeat signal**: the newest row's `ts`
for a given `thread_id` tells you how recently that thread had any core activity.

### `queue_1.sqlite`

`queued_items` (`id, thread_id, payload_json, queue_order, created_at_ms,
updated_at_ms`) and `queued_thread_revisions` (`revision, thread_id`) — both 0 rows
when this page was first written. It is a **per-thread message queue**, and
`followUpQueueMode = "queue"` under `[desktop]` in `config.toml` is why this page
originally called it the desktop app's. That attribution was wrong, and the correction
is measured rather than argued: on 2026-09-02, `codex queue --thread <uuid> --message
…` against a plain `source = 'cli'` TUI thread on Windows (Codex 0.151.0) exited 0,
put one row in `queued_items` with payload
`{"UserInput":{"content":[{"type":"text",…}]}}`, and the row was **gone 6-8s later**
with the message rendered in the TUI and answered. No `app-server` daemon was
involved — which matters, because `codex app-server daemon` refuses to run on
Windows at all. A plain TUI thread owns and drains its own queue.

Submission goes through the app-server RPC `thread/queue/add`
(`ThreadQueueAddParams { thread_id, input, client_user_message_id }`), added in
rust-v0.149.0 — the floor this app enforces per thread off `threads.cli_version`. The
`--thread` argument takes a session UUID **or** an exact session name, and the two
resolve differently: a UUID is a thread-store lookup (`no rollout found for thread
id …` when absent), a name requires an ACTIVE session (`No active session found
matching …`). Only the UUID form is used here.

Still unmeasured, and therefore not relied on anywhere: whether a **mid-turn** thread
drains at its "next safe point" before the turn ends, and whether a `vscode`-source
desktop thread drains at all.

A non-empty `queued_items` row for a thread is itself a liveness signal (something is
queued because the thread has not drained it yet).

### `goals_1.sqlite`

`thread_goals` (`thread_id, goal_id, objective, status CHECK IN (active, paused,
blocked, usage_limited, budget_limited, complete), token_budget, tokens_used,
time_used_seconds, ...`) and `thread_goal_continuation_deferrals` — both 0 rows here
(feature not in use in this account/session). This looks like an **autonomous
"goal"/task-runner mode** (long-running objective across many turns with a token/time
budget) — not used by the sampled session.

## 4. Liveness signal — VERIFIED with one important caveat, plus one INFERRED gap

**Reliable signal**: `thread_turns.status = 'inProgress'` (no `completed_at`) _should_
mean "turn currently running" — **but do not trust it alone**. Two `inProgress` rows
found in `thread_history_1.sqlite` right now belong to a thread from **2026-08-24**,
long finished/abandoned (its process is not among the ones listed in the task). So
`inProgress` can be a stale/orphaned row left behind by a crashed or ungracefully
closed session. Recommended liveness algorithm:

1. OS process check: is `codex.exe` (either install) / `codex-code-mode-host.exe`
   still running at all? (necessary but not sufficient — doesn't tell you _which_
   thread).
2. For a candidate thread, check the **freshest signal across three places** and use
   the max: `thread_turns.status='inProgress'` AND `started_at` recent; **or** the
   newest `logs.ts` where `logs.thread_id = <id>` is within the last N seconds
   (best heartbeat — logs are written continuously during an active turn, e.g. every
   tool call/dispatch); **or** `queue_1.sqlite.queued_items` has rows for that
   `thread_id` (a message is queued behind a running turn).
3. Cross-check against `threads.recency_at_ms` / `updated_at_ms` for "was touched
   very recently" as a coarse filter before doing the above.

**IMPORTANT GOTCHA (verified two ways — MSYS `stat` and PowerShell `Get-Item`)**:
the rollout `.jsonl` file's `LastWriteTime`/mtime **does not update** while it is
being actively appended to by a long-running session. For thread `01a04d79-...`,
`Get-Item` reports `LastWriteTime = 2026-08-29 14:27:32` and `CreationTime` identical,
yet the file is 3,602,628 bytes and its **last 4 lines carry timestamps up to
2026-08-29T17:09:09.175Z UTC** (19:09:09 local) — i.e. the file kept growing for
~4.5 hours after its reported mtime stopped moving. **Directory-mtime-based
"has this rollout stopped receiving writes" checks are unreliable on Windows for a
file kept open across a long session — track file _size_ (or tail content / line
count) instead of mtime.** This single fact plausibly explains the "wrote NOTHING
there" observation in the task background: if whoever/whatever observed the ~19:06
session checked rollout activity via directory listing timestamps, it would have
looked stale even though the file was actively growing (see §5 for the full
correction).

**Pid**: `~/.codex/process_manager/chat_processes.json` records `osPid` for
**shell commands executed by the agent inside a turn** (e.g. `pnpm -r typecheck`) —
keyed by `conversationId`/`turnId`/`itemId`, with `cwd`, `command`, `startedAtMs`. It
is **not** a PID for the codex process/session itself, and is often `null` (only
populated for some commands, and the two entries found were stale/weeks old). No
file was found that maps a thread/session id to the PID of the `codex.exe` process
serving it. **INFERRED gap**: for click-to-focus, there is no reliable
thread↔process PID mapping in this format; the best available heuristic is
"process exists" (from the OS) combined with "this thread's cwd/recency matches",
not a guaranteed 1:1 join.

## 5. Do rollouts still exist for the plain TUI? — VERIFIED, and this corrects part of the task's premise

**Rollout JSONL is not dead for any Codex mode observed here.** Concretely, for the
thread the task background describes (`01a04d79-5c87-7a31-9b1a-4aacc350d6fd`,
`source: "cli"`, `history_mode: "paginated"`):

- Its rollout file `rollout-2026-08-29T14-23-14-01a04d79-....jsonl` **exists**, is
  **3,602,628 bytes**, and its **last line is timestamped
  `2026-08-29T17:09:09.175Z`** (19:09:09 local) — i.e. it was written to right up to
  the end of the observed activity window, well past the "~19:06" cutoff in the task
  background.
- Its `thread_turns` rows show turns starting at 15:20:38, 19:06:49, and 19:09:03 —
  the **same thread continuing across the whole day**, not a new session.
- Querying `state_5.sqlite.threads` for every thread updated anywhere on the machine
  since 18:00 local today returns **exactly this one row** — no other thread (CLI or
  app-server) was created or touched in that window. There is no evidence of a
  distinct "new ~19:06 session" in the SQLite state at all; what's there is this same
  thread's continuation.
- The projection cursor (`thread_history_projection_state.next_rollout_byte_offset =
3602628`) exactly equals the file's size — proving the SQLite layer is a live tail
  of the JSONL file, not a substitute for it.

**Correction to the task background, with evidence**: the premise "a session started
~19:06 wrote NOTHING to the rollout sessions dir" does not hold for the thread this
data actually shows was active then — its rollout file was being written throughout,
confirmed by content timestamps and by the byte-identical projection cursor. The most
likely explanation, given the reproduced mtime bug in §4, is that whatever check
found "nothing new" was looking at file modification timestamps (which had frozen at
14:27:32 despite ongoing writes) rather than file size or content. The
`history.jsonl`/sqlite/`models_cache.json` touches the background lists as evidence of
the "new" session are simply the **normal side effects of any turn** in this CLI
version (0.150.1) — `history.jsonl` gets one line per user prompt regardless of
mode, `logs_2.sqlite`/`state_5.sqlite`/`thread_history_1.sqlite` get updated on every
turn as the live projection/log/registry, and `models_cache.json` is refreshed
whenever the model list is fetched (`list_models{refresh_strategy=online}` was seen
in the log tail). None of that implies the rollout JSONL mechanism was bypassed.

**If there genuinely is a second, separate app-server-driven session** with no
rollout file at all (e.g. the GUI app opening a brand-new thread rather than
continuing thread `01a04d79-...`), it was not present in `state_5.sqlite.threads` as
of the time of this investigation (query above covered "updated since 18:00" across
the whole machine, all projects). **Recommendation**: a monitoring app for this
format should still treat `rollout_path` + `history_mode`/`thread_history_1.sqlite`
projection as authoritative — every thread sampled (both `legacy` and `paginated`,
both `source=cli` and subagent threads) had a real, existing rollout file — and should
not assume any Codex mode skips JSONL entirely without further evidence. This is a
**confidence: high for what was sampled (136 threads, all projects on this
machine)**; it is **not a guarantee for every possible Codex build/mode** (the
desktop app is under active development — `cli_version` on threads only goes up to
`0.150.1`/app build `26.825.41651`, no direct evidence of a hypothetical rollout-less
mode).

## 6. Platform-independence / CODEX_HOME hints — VERIFIED (partial)

- No literal `CODEX_HOME` reference found in `config.toml` via `grep` (the file is
  simply resolved to `~/.codex` implicitly; the constant is documented upstream but
  not present as a token in this config file).
- The `[windows]` config section only holds `sandbox = "elevated"` — no
  Windows-only _storage_ path override, consistent with the DB filenames themselves
  (`state_5.sqlite`, `logs_2.sqlite`, etc.) being plain relative-to-CODEX_HOME names,
  which is very likely identical in layout on macOS/Linux (same `~/.codex/*.sqlite`
  siblings, same `sessions/YYYY/MM/DD/rollout-*.jsonl` layout) — the numeric suffixes
  (`_1`, `_2`, `_5`) look like internal schema/shard version tags rather than
  anything OS-specific.
- `config.toml` does contain many Windows-specific absolute paths for this machine's
  plugin/runtime locations (`\\?\C:\Users\j\...`, `WindowsApps\OpenAI.Codex_...`)
  — these are install-time resolved values, not something a cross-platform provider
  needs to special-case beyond "the paths look like whatever native path format the
  OS uses."
- Tangential but useful: `~/.codex/external_agent_session_imports.json` shows Codex
  actively **imports Claude Code session JSONL files** (from
  `~/.claude/projects/**/*.jsonl`) into its own thread registry
  (`imported_thread_id`, `content_sha256`, `source_modified_at`) — evidence the
  desktop app already treats `~/.claude/projects` as a known sibling data source on
  this OS, reinforcing that cross-tool session layouts are expected to coexist.

## Detection algorithm proposal for a monitoring provider

1. Enumerate `state_5.sqlite.threads` (read-only, WAL-safe) for the _thread_ view —
   this alone gives cwd, model, reasoning_effort, title/preview, git branch/sha,
   tokens_used, and the parent/child sub-agent graph (`source` JSON blob +
   `thread_spawn_edges`) without touching any JSONL.
2. For "is it live right now": join against `thread_turns` (latest row per
   `thread_id`, prefer `status IN ('inProgress')` but require its `started_at`/last
   related `logs.ts` to be within a small recency window, e.g. < 60s, to reject stale
   orphaned rows like the Aug-24 example found here), and/or the newest `logs.ts`
   for that `thread_id` in `logs_2.sqlite`, and/or presence in `queue_1.sqlite`.
   Combine with an OS process-existence check (`codex.exe`, `codex-code-mode-host.exe`,
   `codex-computer-use.exe`) as a coarse "at least something Codex is running" gate.
3. For "latest assistant text" (speech bubble): latest `thread_items` row with
   `item_type='agentMessage'` for the thread, parse `item_json.text`.
4. Do **not** rely on rollout-file mtimes for anything — use `thread_turns`/`logs`
   timestamps or file size deltas instead (§4 gotcha).
5. Fall back to parsing the rollout JSONL directly only if a thread has
   `history_mode='legacy'` and you need the full transcript body (its `item_json`
   payloads are the response items straight from the JSONL, same shapes as before) —
   but even then, thread-level metadata (cwd/model/effort/preview) is already on the
   `threads` row and doesn't require touching the file.
6. Copy-before-read is available as a fallback for lock contention, but was not
   needed in this investigation — `node:sqlite` with `{readOnly:true}` read all five
   live/WAL databases without any lock errors.

## Confidence summary

- Process identity, `history.jsonl` schema, all five SQLite schemas + row counts,
  the rollout-file-still-growing evidence, and the mtime-freeze gotcha: **verified**
  directly against this machine's live files.
- "SQLite is a projection built from JSONL, never a replacement" and "legacy vs
  paginated is a one-time backfill status, not purely version-gated": **verified**
  via the exact byte-offset match and the `backfill_state`/`rollout_migration_*`
  tables, but the _reason_ `legacy` threads were never migrated (age cutoff? size
  cutoff? simply never re-run?) is **inferred**, not confirmed from a changelog/doc.
- "No second, rollout-less ~19:06 session exists" is **verified for this machine's
  current DB state** at investigation time, but can't rule out a fresh session
  started after this investigation, nor a genuinely different rollout-less mode in a
  newer build than `0.150.1`/`26.825.41651`.
- The click-to-focus PID gap is **verified absent** in the sampled data
  (`chat_processes.json` only covers shell-command PIDs, and was stale); this is not
  proof no such mapping exists anywhere, just that none was found.

## 7. `session_meta.cwd` is not always a working directory — issue #166, VERIFIED

The phantom-project report (a Codex question about this very repository produced a
new project named after Codex's own storage slug instead) was reproduced live on
this machine on 2026-09-03, in the exact window it was reported.

**Field inventory, re-confirmed against one real rollout head on this machine
today**: `session_meta.payload` carries (at minimum) `session_id`, `id`,
`forked_from_id`, `parent_thread_id`, `timestamp`, `cwd`, `originator`,
`cli_version`, `source`, `thread_source`, `agent_nickname`, `agent_path`,
`model_provider`, `base_instructions`, `history_mode`,
`subagent_history_start_ordinal`, `multi_agent_version`, `context_window` **[V, keys
only — not reported here: values]**. `cwd` **is** carried, exactly as §2.2 of
`docs/provider-formats.md` already documented — this is not a missing-field bug.

**But the value is not trustworthy on its own.** Two rollouts started three minutes
apart on this machine, in the same investigation window:

- One session (a real, folder-bound workspace) carried the real repository path in
  `session_meta.cwd`, correctly.
- The other — `originator: "Codex Desktop"`, `source: "vscode"`, never bound to an
  opened workspace folder — carried its OWN artifact-storage path instead:
  `<home>\Documents\Codex\<YYYY-MM-DD>\<slug>`, matching this repository's
  `~/Documents/Codex/<date>/<slug>/` layout byte-for-byte in shape (confirmed: this
  machine's own `~/Documents/Codex/2026-09-03/` directory contains a slug directory
  from the same window). The same value is mirrored into `state_5.sqlite.threads.cwd`
  (§3), so reading the registry instead of the rollout does not avoid this.

**Conclusion: this is not a parsing bug.** For a Codex Desktop session with no bound
workspace, Codex itself never records any cwd other than its own storage path —
there is no second field, no `turn_context.workspace_roots` entry, and no registry
column that recovers the real project (`workspace_roots` on a real sampled rollout
carries a mix of the real cwd plus internal `.codex\automations\...` /
`.codex\visualizations\...` paths, so it is not a clean substitute either). Trusting
`cwd` unconditionally launders Codex's own storage folder into a phantom project
exactly as reported.

**Fix implemented**: `src/main/providers/codex/parse.ts` exports
`isCodexArtifactStorageCwd(cwd)`, a structural check (both `\` and `/` separators)
for the `.../Documents/Codex/<YYYY-MM-DD>/<slug>` shape. `codexProvider.ts` checks
every resolved cwd (registry or rollout, same string either way) against it and
drops the session — the same "no honest project, so no mine" behavior the Claude
provider already has for a session whose `cwd` cannot be read at all
(`parseClaudeSessionEntry` returns `null`) — rather than inventing an "unknown
project" bucket or attributing to the storage folder. **[V — this machine, 2026-09-03,
confidence: high for the Windows/Codex-Desktop/no-open-folder case sampled here; the
macOS/Linux equivalent artifact-storage layout, if one exists, is UNCONFIRMED — this
heuristic is Windows-verified only.]**

## 8. Thread → process, measured 2026-09-09, codex-cli 0.153.4

Issue #305, step 1. **Verdict: no join available today meets the guarantee Claude's registry pid
has.** One real thread→pid binding exists and had not been found before — the pid is embedded in
`logs_2.sqlite`'s `process_uuid` — but it is many-to-one, not stable over a thread's life, and the
store carries nothing to re-verify it against pid reuse. The strongest thing 0.153.4 adds is a
CLI-side hook surface that COULD carry the join; it is a candidate, not a measurement.

Read with §4's "Pid" paragraph, which this supersedes: that paragraph said no file maps a thread to
a serving process. That is now wrong in the letter and right in the conclusion.

Machine: Windows 11, `codex-cli 0.153.4` on PATH (pnpm install) plus the Codex desktop app
(`OpenAI.Codex_26.901.*`). Everything below is read-only: process enumeration, and reads of the
store. No Codex session was started, resumed, prompted, focused or signalled. Two `codex.exe`
processes were live throughout and are referred to as **P-tui** (the interactive CLI, started from a
terminal tab) and **P-app** (the desktop app's `app-server` backend, a child of the app's own
`ChatGPT.exe`). Real pids and thread uuids are not reproduced here.

### The exact procedure, so nobody walks it again

1. `Get-CimInstance Win32_Process`, filtered on a name or command line containing `codex`, taking
   `ProcessId, CreationDate, ExecutablePath, CommandLine, ParentProcessId`, then resolving the
   parent chain by repeating the query on `ParentProcessId`. **Do not** use `Get-Process`: its
   `Path` is the binary, and it has no parent link.
2. `node --version` ≥ 22 and `node:sqlite`'s `DatabaseSync(file, { readOnly: true })` against every
   `*.sqlite` in `~/.codex` **and** every `*.db` in `~/.codex/sqlite` (new in this build). WAL reads
   worked with no lock contention and no copy-before-read, exactly as in §3.
3. `PRAGMA table_info(<table>)` on each table, then the queries in the sections below.
4. `codex --version`, `codex --help`, and `--help` on `app-server`, `app-server daemon`, `agents`
   and `debug`. Help output only — none of these opens or resumes a thread.
5. Read the first line of a rollout for a 0.153.4 thread and take `Object.keys(payload)`; scan the
   whole file for the four pid-shaped key names (`pid`, `osPid`, `process_id`, `processId`).

### (a) The store still records no pid for a thread — negative, re-measured

- **`state_5.sqlite.threads`** (193 rows) carries the same 38 columns §3 lists, and not one of them
  names a process: filtering the column list for `pid|proc|host|port|sock` returns the empty set.
  The `threads` row is still the best thread-level record, and still says nothing about who serves
  it.
- **`~/.codex/sqlite/codex-dev.db` is new** and does not help. Its `local_thread_catalog` (1,444
  rows: `host_id, thread_id, display_title, source_created_at, source_updated_at, cwd, source_kind,
source_detail, model_provider, git_branch, observation_sequence, missing_candidate, thread_source,
source_recency_at, pending_observed_title, project_id, conversation_origin`) is the desktop app's
  own index over local and ChatGPT-hosted threads. Its `host_id` joins
  `local_thread_catalog_hosts (host_id, host_kind)`, whose two rows are `local` and a ChatGPT
  account identity — a **sync source**, never a process. Its siblings are
  `local_thread_catalog_metadata`, `_scan_checkpoints`, `_scan_entries`, `_sync_state`,
  `thread_timeline_ledger`, `automations`, `automation_runs`, `inbox_items`,
  `local_app_server_feature_enablement`, `codex_schema_migrations`. Beside it,
  `codex-thread-summaries-dev.db` holds one table, `thread_turn_summaries`.
- **The rollout head is unchanged in kind.** `session_meta.payload` for a 0.153.4 `source: "cli"`
  thread carries `session_id, id, timestamp, cwd, originator, cli_version, source, thread_source,
model_provider, base_instructions, history_mode, context_window, git` — `git` is the one addition
  since §7's inventory, and a spawned worker adds `forked_from_id, parent_thread_id, agent_nickname,
agent_path, subagent_history_start_ordinal, multi_agent_version`. **No pid, on any of the eight
  rollouts written that day.**
- **`process_id` DOES appear inside rollouts, and it is not the session's.** Every hit sits on an
  `event_msg` of type `item_completed` whose `item.type` is `CommandExecution`: it is the pid of a
  shell the agent ran (on Windows, the `powershell.exe` it spawned). Same class as
  `process_manager/chat_processes.json`'s `osPid`, which is unchanged — still shell commands only,
  still often `null`, still holding entries months old.
  - The tempting derivation — that such a pid's PARENT is the codex process, so an ancestor walk
    names it — was **not measured**, and cannot carry a control even if it holds: the pid exists
    only while that command runs, so a session that is thinking, streaming, or waiting on the model
    has none. A join that is absent exactly when it is asked is not a join. Recorded so the next
    reader does not have to think of it twice.

### (b) The pid IS in the store, in `logs_2.sqlite` — positive, with three limits

**`logs.process_uuid` has the shape `pid:<os pid>:<uuid v4>`** — 39,820 of 39,820 retained rows
match `pid:[0-9]*:*`, none deviates. `logs.thread_id` is populated on session-scoped lines. So
`SELECT process_uuid FROM logs WHERE thread_id = ? ORDER BY ts DESC LIMIT 1` answers "which OS
process last served this thread", and the uuid half distinguishes two processes that happened to
share a pid.

Verified live, both directions:

- The one thread open in the TUI at measurement time carried P-tui's pid in every one of its log
  rows, and P-tui's `Win32_Process.CreationDate` matched that process's first log line **to the
  second** (`logs.ts` is unix seconds; `ts_nanos` beside it carries the sub-second part).
- P-app's rows carry P-app's pid, and its `thread_id` is null on the app-server's own global lines
  (`codex_app_server::message_processor`, `codex_http_client::*`) exactly as §3 describes.

Three limits, each measured:

1. **Many-to-one, not 1:1.** One `source: 'cli'` TUI process was observed serving **six** threads —
   its own root plus five `thread_source: 'subagent'` children it spawned during a turn. Another
   process served **nine**, spanning `source: 'cli'` and `source: 'vscode'` threads at once. So the
   pid behind a subagent dwarf is its PARENT session's process, and the pid behind a desktop thread
   is a backend shared with every other desktop thread. Ending either process tree would end
   sessions nobody pointed at — the precise failure #329 exists to prevent.
2. **Not stable over a thread's life.** Seven threads in the retained window were served by two or
   three different pids: a thread resumed in a new process keeps its id and changes its server. Only
   the NEWEST row is an answer, and only while that process is still alive.
3. **Coverage and retention are both partial.** 80 of the 193 registered threads have ever produced
   a log row in the retained window, and the window is a rolling one: ids run 1,181,876→1,363,821
   (~182k rows issued) for 39,820 rows kept, oldest ten days back. A thread with no row has no
   binding, and nothing promises a given thread will write one.

**On pid reuse.** The store records no process creation time, so it cannot re-verify a pid the way
`LaunchedSessionRegistry` does. There is a sound test that uses only what is here, and it is worth
writing down because it is not obvious: probe the candidate pid's creation time `C` now; a process
alive at instant `T` is the unique owner of its pid at `T`, so if `C` is EARLIER than the timestamp
of the log row the pid was read from, the process running now is the one that wrote that row.
Later, and it is a different process wearing the same number. This is as strong as the
creation-time check, with two caveats: `logs.ts` is whole seconds, so the comparison needs a margin
(or `ts_nanos`), and it proves identity at the row's instant, not that the process has not exited
and been replaced since — which is the same thing `processStartTimeMs` proves, and the reason that
check is re-run at every act rather than cached. In the retained window **no pid appears under two
different `process_uuid`s**, so reuse was not observed here; the uuid is nevertheless the field that
would catch it.

### (c) The OS side alone cannot do it on Windows — negative

- **`Win32_Process` has no working-directory property.** The class exposes `CommandLine`,
  `ExecutablePath`, `ParentProcessId`, `CreationDate`, `SessionId` and resource counters, and
  nothing else that locates a process in the filesystem. Reading a process's actual cwd means
  reading its PEB through `OpenProcess`, which is a native call this app does not make and could not
  make against an elevated session anyway.
- **Neither codex process publishes its folder on its command line.** The 0.153.4 TUI's
  `CommandLine` is the bare executable path with no arguments at all — no `-C`, no `--cd`. Its
  parent is a `node.exe` running the package's `codex.js` shim, whose own command line is the shim
  path and nothing more. **This corrects `docs/provider-formats.md` §4**, which records
  `--working-dir <path>` on Codex's node helper processes as "the closest thing to a verifiable
  PID↔project link found so far": that argument is not present on 0.153.4, and the claim should not
  be relied on.
- **The ancestor chain reaches the terminal, which is shared.** P-tui's chain is
  `codex.exe → node.exe → cmd.exe → WindowsTerminal.exe`. The host window is one process for every
  tab, so it identifies a terminal and never a session — the same fact #329 measured for Claude.
- **Creation time correlates only for a thread born with its process.** P-tui's creation time and
  its thread's `thread/start` line agree to the second, which is a genuine consistency check to
  ASSERT once a candidate exists. It is not a way to FIND one: `codex resume` opens an old thread in
  a new process, so `threads.created_at` and the process's birth then disagree by days, and a TUI
  sitting at its session picker has a process older than any thread it will open.
- **"Two threads in one folder" is the wrong question for this build.** It was posed for a world of
  one process per session. What was actually observed is a single backend serving nine threads
  across two different `source` values simultaneously, and a single TUI serving six. Per-cwd
  uniqueness would be satisfied by many of those and would still be the wrong answer.

### (d) What Codex itself offers — no pid, and one candidate worth building on

- **`codex --help` (0.153.4)** lists `agents, exec, review, login, logout, mcp, plugin, mcp-server,
app-server, remote-control, app, completion, update, doctor, sandbox, debug, apply, resume, queue,
archive, delete, migrate-rollouts, unarchive, fork, cloud, exec-server, features, help`. **None
  reports a process for a thread.** `codex agents` is a TUI browser over "the shared local
  app-server daemon"; `codex debug` offers `models`, `app-server` and `prompt-input`, all of them
  renderers.
- **`codex app-server daemon` now has `bootstrap`, `start`, `restart`, `stop`, `version` and the two
  remote-control toggles** — the Windows refusal §3 recorded may well be gone. This makes the join
  WORSE rather than better: a shared daemon is one process for every thread on the machine, and any
  pid read off it names the daemon.
- **The 0.153.4 TUI runs its app-server in-process.** Its own `thread/start` log line carries
  `rpc.transport="in-process"`. That is what makes the pid in (b) the session's own process at all,
  and it is a property of this build rather than a contract.
- **Codex now has Claude-style hooks, and this is the candidate.** `~/.codex/hooks.json` uses the
  same shape Claude Code's does — `SessionStart`, `PreToolUse` with a `matcher`, and (per the
  `hooks.state` keys in `config.toml`) `SessionEnd`, `UserPromptSubmit`, `SubagentStop`. A hook
  command is run BY the session's own process, so its parent chain names that process while the
  session is alive, and its payload names the thread. That is the same opt-in push channel this app
  already has for Claude (`main/hooks`), and it is the only route found that could produce a
  first-party, per-thread, per-process fact rather than an inference. **UNMEASURED**: the payload's
  field names, whether the hook runs as a direct child or through a shell, and whether it fires on
  `resume`. Measuring it means starting a Codex session, which this slice was not permitted to do.
- **`~/.codex/thread-writer-locks/<thread-uuid>.lock`** is new: one zero-byte file per live thread
  writer, beside a `.coordination.lock`. It names the thread and carries no pid, and finding the
  process holding a Windows file handle needs a native handle enumeration this app has no port for.
  Worth knowing as a liveness signal — it is Codex's own statement that a writer is open, the same
  class of evidence Antigravity's presence lock gives (`provider-formats.md` §3.1.2) — but it is not
  a process link.

### Recommendation

**Nothing here clears the bar `LaunchedSessionRegistry` sets, so an observed Codex dwarf gets no
pid-backed act today.** That registry records a pid and its creation time at the one instant it
holds the handle, and re-probes the creation time at every act; the pid is the app's own or it is
nothing. Every join above is an inference over somebody else's records.

If a Codex act is built before the hook is measured, `logs.process_uuid` is the only honest input,
and it needs all of these gates, none of them optional:

1. the thread's newest `logs` row is recent, and its `process_uuid` is the one acted on;
2. that pid is alive and its creation time is earlier than that row's timestamp (the test in (b));
3. the pid's `ExecutablePath` is the CLI package's `codex.exe`, not the desktop app's install tree —
   the desktop backend is shared and its parent is the app itself;
4. `threads.source = 'cli'` **and** `thread_source = 'user'`, so the dwarf is a root and not a
   subagent sharing its parent's process;
5. no other thread has a live binding to the same pid.

Fail any one of them and the answer is the refusal, not a guess. That refusal is what step 3 of #305
puts on the control (`OPEN_TURN_NO_INTERRUPT_HINT` in the renderer's `actionBar.ts`).

One consequence for #305's own step 2, which #329 has since overtaken: the act behind a verified pid
is **ending that session's process tree**, not focusing a window and sending Esc. A focus step is
for the Console control alone, and the panel sends no keystroke into a window it cannot prove is the
session's own. Every gate above is written for an act that ends a process, which is why gates 3 and
4 matter as much as the identity check — ending the shared backend, or a subagent's parent, would
end sessions nobody pointed at.

**Confidence**: the `process_uuid` shape, the row counts, the many-to-one and multi-pid measurements
and the absent columns are **verified** against this machine's live store. The pid-reuse test in (b)
is **reasoned from the uniqueness of a live pid**, not observed — no reuse occurred in the window.
The hook route and the rollout-`process_id` ancestor walk are **unmeasured candidates**, explicitly
so. Everything is one build on one OS: `0.153.4` on Windows 11.

## 9. Approval and plan prompts on disk, measured 2026-09-09, codex-cli 0.153.4

Issue #265, the evidence half. **Three verdicts, and they are not the same verdict.**

1. **An approval prompt writes nothing while it waits — negative, and now measured from both
   ends.** The 2026-08-30 finding in `docs/provider-formats.md` §2.3 holds on a corpus 42% larger
   and on the current build. What is new is that the RESOLUTION _is_ recorded, in
   `logs_2.sqlite`, which lets the silence be proved rather than inferred: the store knows an
   approval happened and knows only its answer.
2. **A question the MODEL asks does have a record — positive, and it is the fixture #265 needs.**
   `response_item` / `function_call` / `name: "request_user_input"`, whose `arguments` carry
   `{questions:[{header,id,question,options:[{label,description}]}]}` — the shape
   `DwarfQuestion` already declares. This was hiding in plain sight: `provider-formats.md`
   §2.2.1's tool-name table lists `request_user_input` among "71 combined … no subject field a
   line could name", which is right for a FEED line and wrong for a question.
3. **A plan is not a prompt — negative for #265's second half.** `update_plan` and the `Plan`
   item are the agent writing its own to-do list. Nothing about them waits on a person.

So #265 splits. The permission card stays unbuildable on observation alone; the question card
becomes buildable, for one rare-but-real record.

### The exact procedure, so nobody walks it again

Everything read-only. No session was started, resumed, prompted, focused or signalled; nothing
under the Codex home was written.

1. Walk every `*.jsonl` under the sessions tree, `JSON.parse` each line, and tally the triple
   `(type, payload.type, payload.item.type)` — the third element is the part §5 and
   `provider-formats.md` never enumerated, and it is where this build now puts most of its
   content. Tally `payload.name` separately for `function_call` and `custom_tool_call`.
2. Grep the same lines for approval-shaped literals BEFORE interpreting them, then for each hit
   walk the parsed object to record the JSON PATH the literal sits at. This is the step that
   matters: every literal in this corpus turned out to be inside somebody's text, and only a path
   distinguishes a record type from a word in a tool's stdout.
3. Copy the five `~/.codex/*.sqlite` files plus their `-wal`/`-shm` siblings and the two `*.db`
   under `~/.codex/sqlite` to a scratch directory, then open the copies with `node:sqlite`
   `DatabaseSync(file, { readOnly: true })`. §3 opened the live files and hit no locks; copying
   first costs nothing and removes the question.
4. For every `thread_items` row, union the top-level keys of `item_json` per `item_type`, and
   filter that union for approval-shaped key NAMES. A vocabulary of `item_type` values answers
   "is there a waiting record"; only a key inventory answers "is there a waiting FIELD".
5. In `logs_2.sqlite`, extract the distinct `app-server event: <name>` vocabulary out of
   `feedback_log_body`, and for every approval reply take the gap to the immediately preceding
   row by `id`. The gap is the human's thinking time, and what sits in it is the finding.
6. `Get-CimInstance Win32_Process` for the process facts, `~/.codex/thread-writer-locks/` for
   which threads have a live writer, and a size poll of the newest rollout — never `mtime`, for
   the reason §4 gives and this measurement re-confirmed.

Corpus: 193 rollouts, 557 MB, 61 750 records, 0 unparsable lines — every rollout on the machine,
18 distinct `cli_version` values from `0.145.0-alpha.27` to `0.153.4`. The 14-day window inside it
is 66 rollouts / 200 MB / 16 967 records, and its vocabulary is a strict subset of the whole.

### (a) The record vocabulary, whole corpus

Top-level `type` — **`token_usage_record` is new** since `provider-formats.md` §2.2:

| `type`                               | Records |
| ------------------------------------ | ------: |
| `response_item`                      |  29 870 |
| `event_msg`                          |  29 640 |
| `turn_context`                       |     857 |
| `token_usage_record`                 |     429 |
| `world_state`                        |     404 |
| `inter_agent_communication_metadata` |     289 |
| `session_meta`                       |     223 |
| `compacted`                          |      38 |

`event_msg.payload.type` has **collapsed** rather than grown. The 2026-08-30 corpus listed sixteen
values; six remain, because the per-kind events (`agent_message`, `patch_apply_end`,
`mcp_tool_call_end`, `web_search_end`, `sub_agent_activity`, `image_generation_end`,
`context_compacted`, `thread_rolled_back`, `agent_reasoning`, `user_message`) are now carried
inside `item_completed` as `payload.item.type` instead:

| `event_msg.payload.type`  | Records |
| ------------------------- | ------: |
| `item_completed`          |  18 864 |
| `token_count`             |   8 308 |
| `task_started`            |     936 |
| `task_complete`           |     883 |
| `thread_settings_applied` |     628 |
| `turn_aborted`            |      21 |

**This matters to `parse.ts` beyond #265**: `parseCodexRolloutTail`'s `case 'agent_message'` reads
an `event_msg` type this build no longer writes. It is harmless — the `response_item`/`message`
branch beside it still finds the reply — but it is dead against 0.153.4, and the live text is now
also in `item_completed`/`AgentMessage`.

`payload.item.type` inside `item_completed`, enumerated here for the first time:

| `item.type`           | Records |
| --------------------- | ------: |
| `Reasoning`           |   7 699 |
| `AgentMessage`        |   4 595 |
| `CommandExecution`    |   2 207 |
| `McpToolCall`         |   1 838 |
| `UserMessage`         |     829 |
| `FileChange`          |     669 |
| `SubAgentActivity`    |     237 |
| `Extension`           |     194 |
| `WebSearch`           |     178 |
| `ImageView`           |     135 |
| `DynamicToolCall`     |     124 |
| `CollabAgentToolCall` |     121 |
| `ContextCompaction`   |      36 |
| `Plan`                |       1 |
| `FunctionCallOutput`  |       1 |

`response_item.payload.type` adds `tool_search_call` / `tool_search_output` (9 each) to the six
§2.2 documents. Tool names: `custom_tool_call` is `exec` (5 953) and `apply_patch` (93);
`function_call` is `shell_command` 404, `wait` 294, `wait_agent` 149, `send_message` 88,
`spawn_agent` 64, `followup_task` 42, `list_agents` 38, `js` 27, `run` 18, `view_image` 11,
**`update_plan` 6**, `_create_pull_request` 5, **`request_user_input` 3**,
`load_workspace_dependencies` 2, `interrupt_agent` 1.

**Nothing in any of those three vocabularies names an approval, a permission, an elicitation or a
pending input.** The literals were searched for directly and every hit was located by JSON path:
`exec_approval` (1), `approval_request` (1), `permission_request` (3), `ask_user` (2) and
`AskUser` (73) occur ONLY inside `.payload.output[…].text`, `.payload.item.stdout`,
`.payload.item.result.content[…].text` or a message body — tool output and prose, several of them
this repository's own issue text being read back by an agent. `elicit` (42) additionally occurs as
a POLICY key, `turn_context.payload.approval_policy.granular.mcp_elicitations`, mirrored in
`event_msg`/`thread_settings_applied`. A policy is not a request; that distinction is the same one
§2.3 drew and it survives the re-measurement.

### (b) The approval prompt: silence, now provable

The store records the ANSWER. `logs_2.sqlite` carries, at `codex_core::session::handlers`,
15 rows of the shape

```
session_loop{thread_id=<uuid>}: Submission sub=Submission { id: "<uuid>",
  op: ExecApproval { id: "exec-<uuid>", turn_id: Some("<uuid>"),
                     decision: Approved | Abort | ApprovedExecpolicyAmendment { … } }, … }
```

and, at `codex_app_server::outgoing_message`, the app-server side of the same moment —
`<- response: CommandExecutionRequestApproval { request_id, response: { decision: Accept |
AcceptWithExecpolicyAmendment { … } } }` (3) and `<- response: McpServerElicitationRequest {
request_id, response: { action: Accept, … } }` (1). So an approval decision is a first-class,
thread-scoped, timestamped record, and `Abort` and `Denied` are in the vocabulary beside
`Approved`.

**The request is not.** The complete `app-server event: <name>` vocabulary in the retained window
is 26 values, and the only one in the request/response family is **`serverRequest/resolved`** (4).
There is no `serverRequest/issued`, no `…/started`, no `-> request:` line anywhere: the logger
records inbound responses and omits outbound requests. `thread/status/changed` (80) fires around
an approval but its body is `targeted_connections=0` and carries no status VALUE, so it says
something changed and never what.

The gap measurement closes it. Taking every `op: ExecApproval` row and the row immediately before
it by `id`, the gaps are 0, 0, 0, 1, 3, 4, 6, 8, 9, 12, 12, 153, 205, 209 and 263 seconds. The
long ones are the human deciding — and **nothing at all is written during them**. The row before a
263-second gap is an unrelated `list_models` line from a different span; the row before the short
ones is the stream event that produced the prompt. A wait leaves no row, only its end does.

The rollout says the same thing more weakly. While an exec approval sits open the rollout tail is
a `custom_tool_call` (`exec`) with no `custom_tool_call_output` yet — which is **exactly** what a
command that is simply still running looks like, and that is the overwhelmingly common case. The
open turn is still open, `busy` is still true, and the panel would be guessing.

Nor is the sequencing in doubt any more. Across 7 198 tool calls in the corpus, **one** call has no
output and the file continues for 234 more records afterwards. A call line is therefore appended
when the call is emitted, not batched with its result — which is what makes an unanswered call at
the tail a real observation rather than an artefact, and is the load-bearing fact behind (c).

### (c) `request_user_input`: the one positive record

Three calls, all in one `source: "cli"` / `originator: "codex-tui"` thread on `0.149.0`. Verbatim
shape, keys only:

```
{"timestamp":"…","type":"response_item","payload":{
  "type":"function_call","name":"request_user_input",
  "call_id":"call_…","id":"fc_…",
  "arguments":"{\"questions\":[{\"header\":…,\"id\":…,\"question\":…,
                 \"options\":[{\"label\":…,\"description\":…}]}]}",
  "internal_chat_message_metadata_passthrough":{"turn_id":"…","create_time":…}}}
```

`arguments` is a JSON-encoded STRING, the same double-parse `shell_command` needs. Each of the
three was followed by a `function_call_output` with the SAME `call_id` and **no records in
between**, after 91.5 s, 159.5 s and 807.4 s. Thirteen and a half minutes of one gap is a person
reading a question; combined with the append-at-emission proof above, an unanswered
`request_user_input` at a rollout's tail is a session waiting on its human, and the record says so
in the model's own words.

It maps onto `DwarfQuestion` without this app inventing anything: `call_id` → `toolUseId`,
`questions[0].question` → `question`, `questions[0].header` → `header`, `options[]`
`{label,description}` → `DwarfQuestionOption`, the record `timestamp` → `askedAt`. No
multi-select field was observed, so `multiSelect` is `false` until one is.

**The two caveats are real and belong next to the finding.** It is rare — 3 calls in 193 rollouts
— and no call appears on `0.153.4` in this corpus. What IS true of `0.153.4` is that the tool is
still OFFERED: the name occurs in `turn_context` / `thread_settings_applied` (the tool list) in
10 of its 19 rollouts, and in 26 `session_meta` `base_instructions`. So the record can appear on
the current build; it was simply not chosen in the window. Treat the parser as reading a record
that is proven in shape and unproven in frequency.

### (d) Plans

`update_plan` is a `function_call` with `arguments` `{explanation?, plan}` — 6 calls, every one
answered by a `function_call_output`. Separately, one `event_msg`/`item_completed` carries
`item.type: "Plan"` with `{id, text, type}` and a 6 613-character body, and that is the single
`thread_items.item_type = 'plan'` row `docs/codex-v2-format.md` §3 recorded; `turn/plan/updated`
exists as an app-server event (1 row). All of it is the agent publishing its own checklist. **No
plan record has a pending, proposed, awaiting or accepted state, and none is followed by a wait.**
The "plan question" half of #265 has no evidence behind it on this build: what a user experiences
as "Codex is showing me a plan and waiting" is an approval prompt (b) or prose in an
`AgentMessage`, and prose is forbidden as a signal by `contracts.ts`'s `DwarfBlockedOn`.

### (e) The stores say nothing a rollout does not

- **`thread_items.item_type`** — 15 values, none approval-shaped: `reasoning` 5 546,
  `agentMessage` 4 261, `commandExecution` 2 207, `mcpToolCall` 1 775, `fileChange` 641,
  `userMessage` 547, `webSearch` 365, `subAgentActivity` 213, `imageView` 135, `dynamicToolCall`
  124, `collabAgentToolCall` 121, `contextCompaction` 33, `imageGeneration` 3, `plan` 1,
  `functionCallOutput` 1. **`request_user_input` is not among them** — the projection reads
  `item_completed` events, and a `response_item`/`function_call` is not one. The rollout is the
  only witness for (c).
- **One approval-shaped KEY exists in the whole `item_json` corpus, and it is empty.**
  `agentMessage.questions` is present on 3 703 of 4 261 `agentMessage` rows and is `null` on every
  single one. Codex reserves a questions field on an assistant message and has never filled it
  here. Worth a re-check on a future build; worth nothing today. (Beside it, `agentMessage.phase`
  is `commentary` 502 / `final_answer` 216 / null 2 985, and `delivery` is null on all 3 703.)
- **`thread_turns.status`** — four values, `completed` 545, `interrupted` 18, `failed` 16,
  `inProgress` 2. No waiting, blocked or pending status. §4's warning stands: both `inProgress`
  rows are stale orphans, and `inProgress` never distinguished "thinking" from "asking".
- **`threads.approval_mode`** across 194 threads — `never` 104, `on-request` 87, and **a new
  granular JSON on 3**: `{"granular":{"sandbox_approval":false,"rules":false,"skill_approval":
false,"request_permissions":true,"mcp_elicitations":true}}`. Still a policy, still says only
  whether this thread CAN be asked, never whether it IS being asked.
- No column in any table of `state_5.sqlite` names a pending question; filtering all 15 tables'
  columns for `pend|approv|quest|wait|block|prompt|input|elicit` returns `threads.approval_mode`
  and `thread_dynamic_tools.input_schema`, both of them schema. `queued_items` 0 rows,
  `thread_goals` 0 rows, `thread_realtime_items` 0 rows.
- **`codex-dev.db` has an `inbox_items` table** (`id, title, description, thread_id, read_at,
created_at`) whose name is exactly what this question wants — and it holds **0 rows**. Whatever
  the desktop app surfaces there, an approval prompt is not it. Its `thread_timeline_ledger`
  (538 rows) is a sync ledger keyed by `host_id`.

### (f) No live prompt was available, and here is what to capture when one is

At measurement time one thread had a live writer lock and its rollout had not grown in five polls
twelve seconds apart; its last record was `task_complete`, i.e. **open but idle, not waiting**. The
only `codex.exe` was the desktop app's `app-server` backend (a child of the app), with no TUI
running. So step 3 of the #265 diagnosis — inspect a rollout while a prompt is actually on screen
— is **not answered by observation**, and (b) is argued from resolution records and gap silence
instead. That is strong for the negative and it is not the same thing as watching one.

Incidentally re-confirmed while polling: the newest rollout's `mtime` read 17:32:19 while its last
record was timestamped 17:38:21. §4's mtime freeze is alive on this build. Size or content, never
mtime.

When a prompt IS on screen, capture, in this order and without answering it:

1. `~/.codex/thread-writer-locks/` — the waiting thread's lock file names its uuid, and that is
   the cheapest way to identify the thread without touching the session.
2. The size of that thread's rollout, polled three times ~10 s apart, and its last five records'
   `(type, payload.type, payload.item.type)`. The prediction from (b) is: size frozen, tail a
   `custom_tool_call`/`exec` with no output. A tail carrying anything else is the discovery.
3. `SELECT id, ts, level, target, substr(feedback_log_body,1,200) FROM logs WHERE thread_id = ?
ORDER BY id DESC LIMIT 40` on a COPY of `logs_2.sqlite`. The prediction is that the newest row
   predates the prompt and nothing arrives until the answer. A row written DURING the wait — an
   `app-server event: serverRequest/…` other than `resolved`, or any outbound `-> request:` — is
   the record this section could not find, and it would make the permission card buildable.
4. `SELECT status, started_at, completed_at FROM thread_turns WHERE thread_id = ?` and
   `SELECT item_type, count(*) FROM thread_items WHERE thread_id = ? GROUP BY 1`, before and
   after answering. Anything that flips only while waiting is the answer to #265's question 3.
5. `threads.approval_mode` for that thread, to record which policy produced the prompt.

### Confidence

The vocabularies, counts, key inventories, JSON paths, the absent columns, the empty
`agentMessage.questions`, the `serverRequest/resolved`-only event family and the approval gap
distribution are **verified** against this machine's complete corpus and a copy of its live stores.
The `request_user_input` shape is **verified** on three real records, and its usefulness rests on
the append-at-emission proof, which is **verified once** (1 orphan in 7 198 calls) rather than
repeatedly. "An approval prompt writes nothing while it waits" is **verified for the resolution
side and inferred for the wait itself** — no prompt was open to watch. Everything is Windows 11,
one machine, builds `0.145.0-alpha.27` through `0.153.4`.
