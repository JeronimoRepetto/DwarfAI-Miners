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
