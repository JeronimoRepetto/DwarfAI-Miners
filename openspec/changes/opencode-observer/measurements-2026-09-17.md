# Measurements 2026-09-17 — OpenCode on the maintainer's Windows machine (read-only)

Rows refer to `exploration.md` §6. Nothing was started, prompted or written; the database was opened with `node:sqlite` `DatabaseSync(..., { readOnly: true })` on Node 24.11.1. Machine identifiers are redacted; the home directory is written `~`.

## Row 1 — install, version, store shape [V]

- `npx opencode-ai --version` → **1.18.31**. A `pnpm add -g opencode-ai` shim also exists at `%LOCALAPPDATA%\pnpm\bin\opencode(.CMD)` but its `bin/opencode.exe` is a 479-byte placeholder script: pnpm skipped the package's `postinstall` (which downloads the platform binary), so that shim prints "opencode-ai's postinstall script was not run" and exits. `npx` runs the postinstall, which is why only `npx opencode-ai` works. Consequence for CLI detection: the executable on PATH may be a broken shim; presence on PATH is not proof of a working install.
- Store root: `~/.local/share/opencode/` exists under the Windows user profile (POSIX-shaped path, not `%LOCALAPPDATA%`). Contents: `opencode.db`, `opencode.db-shm`, `opencode.db-wal`, `auth.json`, `log/`, `repos/`. **No `storage/` directory** — this build writes SQLite only; the JSON `storage/{session,message,part}` tree the exploration marked [I] is absent on a fresh 1.18.31 install.
- State dir: `~/.local/state/opencode/` with `locks/`, `model.json`, `plugin-meta.json`.

## Row 2 — `opencode.db` schema [V]

- `journal_mode = wal`, `user_version = 0`; 38 rows in `migration`, 0 in `data_migration`. Read-only open works while OpenCode is not running; a WAL database must be read with the `-wal`/`-shm` files present (the Codex reader already handles this).
- Tables: `account`, `account_state`, `control_account`, `credential`, `data_migration`, `event`, `event_sequence`, `message`, `migration`, `part`, `permission`, `project`, `project_directory`, `session`, `session_context_epoch`, `session_input`, `session_message`, `session_share`, `todo`, `workspace`.
- `session` columns that matter: `id`, `project_id`, `workspace_id`, **`parent_id`** (indexed: `session_parent_idx`), `slug`, **`directory`**, `path`, `title`, `version`, `cost` real, `tokens_input`, `tokens_output`, `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`, `agent`, `model`, `time_created`, **`time_updated`**, `time_compacting`, `time_archived`. **No pid or process column anywhere in the schema.**
- `message` (`id`, `session_id`, `time_created`, `time_updated`, `data` JSON) and `part` (`id`, `message_id`, `session_id`, `time_created`, `time_updated`, `data` JSON): the message/part bodies are JSON blobs in `data`; their inner shape is still [I] until a session has been run (0 rows today).
- `session_message` (`type`, `seq`, `data`) and `session_input` (`prompt`, `delivery`, `admitted_seq`, `promoted_seq`) exist beside `message`/`part` — which of them a live TUI session writes is unmeasured (row 3).
- `project` (`id`, `worktree`, `vcs`, `name`, …) and `project_directory` (`project_id`, `directory`) — 2 rows each already, so the project → directory join exists before any session.
- Full DDL dump follows.

## Consequences for the design (to fold into tasks)

- The "JSON-first when both shapes exist" default becomes **DB-only on 1.18.31**; the JSON reader is a legacy/compat path for older installs, not the primary. Row 1 is positive for SQLite, negative for JSON.
- Row 4 is structurally positive: `session.parent_id` is a real, indexed column. Whether the TUI populates it for a Task subagent is still row 4's live check.
- Row 3 candidates for liveness: `session.time_updated`, `message.time_updated`, `part.time_updated`, WAL file growth. Size growth of `opencode.db-wal` is the analogue of a growing rollout.
- Row 5 (pid join): negative in the schema; only a live process check could add one.
- Tokens and cost are per-session columns; cost stays advisory per the proposal.

## DDL dump (verbatim, `sqlite_master`)

```sql
CREATE TABLE `account` ( `id` text PRIMARY KEY, `email` text NOT NULL, `url` text NOT NULL, `access_token` text NOT NULL, `refresh_token` text NOT NULL, `token_expiry` integer, `time_created` integer NOT NULL, `time_updated` integer NOT NULL )
CREATE TABLE `account_state` ( `id` integer PRIMARY KEY, `active_account_id` text, `active_org_id` text, CONSTRAINT `fk_account_state_active_account_id_account_id_fk` FOREIGN KEY (`active_account_id`) REFERENCES `account`(`id`) ON DELETE SET NULL )
CREATE TABLE `control_account` ( `email` text NOT NULL, `url` text NOT NULL, `access_token` text NOT NULL, `refresh_token` text NOT NULL, `token_expiry` integer, `active` integer NOT NULL, `time_created` integer NOT NULL, `time_updated` integer NOT NULL, CONSTRAINT `control_account_pk` PRIMARY KEY(`email`, `url`) )
CREATE TABLE `credential` ( `id` text PRIMARY KEY, `integration_id` text, `label` text NOT NULL, `value` text NOT NULL, `connector_id` text, `method_id` text, `active` integer, `time_created` integer NOT NULL, `time_updated` integer NOT NULL )
CREATE TABLE `data_migration` ( `name` text PRIMARY KEY, `time_completed` integer NOT NULL )
CREATE TABLE `event` ( `id` text PRIMARY KEY, `aggregate_id` text NOT NULL, `seq` integer NOT NULL, `type` text NOT NULL, `data` text NOT NULL, CONSTRAINT `fk_event_aggregate_id_event_sequence_aggregate_id_fk` FOREIGN KEY (`aggregate_id`) REFERENCES `event_sequence`(`aggregate_id`) ON DELETE CASCADE )
CREATE TABLE `event_sequence` ( `aggregate_id` text PRIMARY KEY, `seq` integer NOT NULL, `owner_id` text )
CREATE TABLE `message` ( `id` text PRIMARY KEY, `session_id` text NOT NULL, `time_created` integer NOT NULL, `time_updated` integer NOT NULL, `data` text NOT NULL, CONSTRAINT `fk_message_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE )
CREATE TABLE "migration" (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)
CREATE TABLE `part` ( `id` text PRIMARY KEY, `message_id` text NOT NULL, `session_id` text NOT NULL, `time_created` integer NOT NULL, `time_updated` integer NOT NULL, `data` text NOT NULL, CONSTRAINT `fk_part_message_id_message_id_fk` FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON DELETE CASCADE )
CREATE TABLE `permission` ( `id` text PRIMARY KEY, `project_id` text NOT NULL, `action` text NOT NULL, `resource` text NOT NULL, `time_created` integer NOT NULL, `time_updated` integer NOT NULL, CONSTRAINT `fk_permission_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE )
CREATE TABLE `project` ( `id` text PRIMARY KEY, `worktree` text NOT NULL, `vcs` text, `name` text, `icon_url` text, `icon_url_override` text, `icon_color` text, `time_created` integer NOT NULL, `time_updated` integer NOT NULL, `time_initialized` integer, `sandboxes` text NOT NULL, `commands` text )
CREATE TABLE `project_directory` ( `project_id` text NOT NULL, `directory` text NOT NULL, `type` text, `strategy` text, `time_created` integer NOT NULL, CONSTRAINT `project_directory_pk` PRIMARY KEY(`project_id`, `directory`), CONSTRAINT `fk_project_directory_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE )
CREATE TABLE `session` ( `id` text PRIMARY KEY, `project_id` text NOT NULL, `workspace_id` text, `parent_id` text, `slug` text NOT NULL, `directory` text NOT NULL, `path` text, `title` text NOT NULL, `version` text NOT NULL, `share_url` text, `summary_additions` integer, `summary_deletions` integer, `summary_files` integer, `summary_diffs` text, `metadata` text, `cost` real DEFAULT 0 NOT NULL, `tokens_input` integer DEFAULT 0 NOT NULL, `tokens_output` integer DEFAULT 0 NOT NULL, `tokens_reasoning` integer DEFAULT 0 NOT NULL, `tokens_cache_read` integer DEFAULT 0 NOT NULL, `tokens_cache_write` integer DEFAULT 0 NOT NULL, `revert` text, `permission` text, `agent` text, `model` text, `time_created` integer NOT NULL, `time_updated` integer NOT NULL, `time_compacting` integer, `time_archived` integer, CONSTRAINT `fk_session_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE )
CREATE TABLE `session_context_epoch` ( `session_id` text PRIMARY KEY, `baseline` text NOT NULL, `snapshot` text NOT NULL, `baseline_seq` integer NOT NULL, CONSTRAINT `fk_session_context_epoch_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE )
CREATE TABLE `session_input` ( `id` text PRIMARY KEY, `session_id` text NOT NULL, `prompt` text NOT NULL, `delivery` text NOT NULL, `admitted_seq` integer NOT NULL, `promoted_seq` integer, `time_created` integer NOT NULL, CONSTRAINT `fk_session_input_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE )
CREATE TABLE `session_message` ( `id` text PRIMARY KEY, `session_id` text NOT NULL, `type` text NOT NULL, `seq` integer NOT NULL, `time_created` integer NOT NULL, `time_updated` integer NOT NULL, `data` text NOT NULL, CONSTRAINT `fk_session_message_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE )
CREATE TABLE `session_share` ( `session_id` text PRIMARY KEY, `id` text NOT NULL, `secret` text NOT NULL, `url` text NOT NULL, `time_created` integer NOT NULL, `time_updated` integer NOT NULL, CONSTRAINT `fk_session_share_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE )
CREATE TABLE `todo` ( `session_id` text NOT NULL, `content` text NOT NULL, `status` text NOT NULL, `priority` text NOT NULL, `position` integer NOT NULL, `time_created` integer NOT NULL, `time_updated` integer NOT NULL, CONSTRAINT `todo_pk` PRIMARY KEY(`session_id`, `position`), CONSTRAINT `fk_todo_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE )
CREATE TABLE `workspace` ( `id` text PRIMARY KEY, `type` text NOT NULL, `name` text DEFAULT '' NOT NULL, `branch` text, `directory` text, `extra` text, `project_id` text NOT NULL, `time_used` integer NOT NULL, CONSTRAINT `fk_workspace_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE )
CREATE UNIQUE INDEX `event_aggregate_seq_idx` ON `event` (`aggregate_id`,`seq`)
CREATE INDEX `event_aggregate_type_seq_idx` ON `event` (`aggregate_id`,`type`,`seq`)
CREATE INDEX `message_session_time_created_id_idx` ON `message` (`session_id`,`time_created`,`id`)
CREATE INDEX `part_message_id_id_idx` ON `part` (`message_id`,`id`)
CREATE INDEX `part_session_idx` ON `part` (`session_id`)
CREATE UNIQUE INDEX `permission_project_action_resource_idx` ON `permission` (`project_id`,`action`,`resource`)
CREATE UNIQUE INDEX `session_input_session_admitted_seq_idx` ON `session_input` (`session_id`,`admitted_seq`)
CREATE INDEX `session_input_session_pending_delivery_seq_idx` ON `session_input` (`session_id`,`promoted_seq`,`delivery`,`admitted_seq`)
CREATE UNIQUE INDEX `session_input_session_promoted_seq_idx` ON `session_input` (`session_id`,`promoted_seq`)
CREATE UNIQUE INDEX `session_message_session_seq_idx` ON `session_message` (`session_id`,`seq`)
CREATE INDEX `session_message_session_time_created_id_idx` ON `session_message` (`session_id`,`time_created`,`id`)
CREATE INDEX `session_message_session_type_seq_idx` ON `session_message` (`session_id`,`type`,`seq`)
CREATE INDEX `session_message_time_created_idx` ON `session_message` (`time_created`)
CREATE INDEX `session_parent_idx` ON `session` (`parent_id`)
CREATE INDEX `session_project_idx` ON `session` (`project_id`)
CREATE INDEX `session_workspace_idx` ON `session` (`workspace_id`)
CREATE INDEX `todo_session_idx` ON `todo` (`session_id`)
--- counts
account 0
account_state 0
control_account 0
credential 0
data_migration 0
event 0
event_sequence 0
message 0
migration 38
part 0
permission 0
project 2
project_directory 2
session 0
session_context_epoch 0
session_input 0
session_message 0
session_share 0
todo 0
workspace 0
--- pragmas
journal_mode [Object: null prototype] { journal_mode: 'wal' }
user_version [Object: null prototype] { user_version: 0 }
```

## Row 3 — one live turn recorded, read back read-only [V] (same day, later)

The maintainer ran one OpenCode agent turn in a project folder ("what does this project do"), then quit. Read back with `node:sqlite` read-only. Values redacted to `<user>`/`~`; ids are OpenCode's own opaque ids.

- **`session` row after the turn**: `parent_id: null` (a root), `directory` = the project folder (forward slashes on Windows), `path: ""`, `version: "1.18.31"`, `agent: "gentle-orchestrator"` (the agent name OpenCode ran as), `model` = a JSON string `{"id":"mimo-v2.5","providerID":"opencode-go"}`, `cost: 0.00507`, `tokens_input: 33512`, `tokens_output: 785`, `tokens_reasoning: 0`, `tokens_cache_read: 57408`, `tokens_cache_write: 0`, `time_created` and `time_updated` (epoch ms; `time_updated` moved to the turn's end), `time_compacting: null`, `time_archived: null`, `permission: null`, `metadata: null`, `workspace_id: null`. `project.worktree` = the same folder; `project.id` is a 40-hex hash; a second `project` row `id: "global", worktree: "/"` exists.
- **`message.data`** (JSON, 3 rows): the **user** message carries `role: "user"`, `time.created`, `agent`, `model {providerID, modelID}`, `summary`. Each **assistant** message carries `role: "assistant"`, `parentID` = **the user message's id** (a message-level reply edge, NOT a session/subagent edge — do not confuse with `session.parent_id`), `mode`, `agent`, `path`, `modelID`, `providerID`, `time.created` and **`time.completed`** (absent while streaming, present once done), `tokens {total, input, output, reasoning, cache {read, write}}`, `cost`, `finish` (`"tool-calls"` for an intermediate step, `"stop"` for the final one).
- **`part.data` types seen** (12 rows): `text {type, text, time}`, `reasoning {type, text, time {start, end}}`, `tool {type, tool, callID, state {status: "completed", …}}`, `step-start {type, snapshot}`, `step-finish {type, reason, snapshot, tokens, cost}`. `snapshot` is a 40-hex hash (OpenCode's own file-tracking snapshot).
- **`event` table**: an event-sourced log keyed by `aggregate_id` = the session id, `seq` monotonically increasing per session (0…37 here), `type` in `session.created.1`, `session.updated.1`, `message.updated.1`, `message.part.updated.1`. **This is the cleanest activity signal on disk**: the max `seq` per session grows while a turn runs and stops when it ends; `event.data` holds the event payload (not inspected).
- **Empty after this run**: `session_message`, `session_input`, `todo`, `permission`, `workspace`. Whether the interactive TUI (as opposed to this run) fills `session_message`/`session_input` is still open.
- **`~/.local/share/opencode/log/opencode.log`** is a key=value text log with per-step lines (`message=created id=ses_… projectID=… directory=…`, `message=loop … step=N`, `message="exiting loop"`, `message=evaluated permission=read … action=allow`). Useful for a human; the provider reads the database, not the log.
- **Liveness reading that follows**: a session is `working` while its newest assistant message has no `time.completed` (or its max `event.seq` moved since the last poll); `idle` once `time.completed` is set and `finish === "stop"`; never `waiting`, because no pending-permission row appeared (permissions were auto-allowed by the agent's own policy). Retention still runs through `dwarfSilenceWindowMs(role, 'unknown')`.
- **Topology**: row 4 remains open — no Task subagent was spawned in this turn, so `session.parent_id` population is still unobserved.

## Maintainer decision, same day

**SQLite only.** No JSON compatibility path for older OpenCode installs: the provider reads `opencode.db` and nothing else; a machine with the legacy `storage/` tree and no database is "OpenCode not observed", stated in `docs/opencode-format.md` with the version floor (1.18.31 measured). This removes `parse.ts`'s JSON reader, the synthetic compat JSON fixtures and the dual-shape merge/dedupe from the design.

## Row 3, addendum — the measured turn WAS the interactive TUI [V]

The maintainer launched the agent through the Gentle-AI TUI, which starts OpenCode's own interactive TUI. `~/.local/share/opencode/log/opencode.log` confirms it: every launch writes two `run=` ids within a second of each other — one whose first line is `message="loading tui config" path="~/.config/opencode/tui.json"` (the TUI process) and one whose first line is `message="creating instance" directory=<cwd>` (the server instance the TUI spawns). The measured session's instance is `run=7c4ff842` (08:17:36Z), paired with TUI `run=08f2b1e4` (08:17:35Z).

Consequences:

- **`session_message` and `session_input` are empty after an interactive TUI turn too.** On 1.18.31 an ordinary turn writes `session`, `message`, `part` and `event` only; the two other tables belong to some other flow (queued/steered input is the likely candidate, unmeasured). The feed reads `message` × `part` and nothing else; no second read path is needed. Measurement (b) is closed.
- **The TUI runs its server as a separate process** (two run ids per launch). Relevant to `opencode-held` (a TUI-opened server has a port the app cannot discover today), not to the observer.
- Row 4 (a Task subagent populating `session.parent_id`) is still the one open live measurement.

## Row 4 — a Task subagent populates `session.parent_id` [V] (same day, interactive TUI)

The maintainer asked the TUI agent to delegate a small job to a subagent. Read back read-only ~5 s after the turn ended (the whole turn took ~16 s, so the streaming state was not caught live; `time.completed` was already set everywhere).

- **Parent session** `ses_…T2ik`: `parent_id: null`, `agent: "gentle-orchestrator"`, `model {"id":"qwen3.6-plus","providerID":"opencode-go"}`, one `part` of `type: "tool"` with **`tool: "task"`**, `state.status: "completed"`, `state.input` present. 34 events (max `seq` 33).
- **Child session** `ses_…ohi5`: **`parent_id` = the parent session's id** [V], `agent: "general"`, same `directory` as the parent, `model {"id":"qwen3.6-plus","providerID":"opencode-go","variant":"default"}` (note the extra `variant` key on a child), its own `tokens_*` and `cost`, its own `message`/`part` rows (one `tool: "glob"` part), `time_created` 7 s after the parent's, `time_updated` 3 s before the parent's final `time_updated`. 30 events of its own (max `seq` 29).
- So the topology edge is exactly `session.parent_id → session.id`, one row per subagent session, indexed by `session_parent_idx`. The parent's `task` tool part is the corroborating evidence of the spawn; `message.data.parentID` played no role (it stays a reply edge).
- The child's `directory` equals the parent's, so both dwarfs land in the same mine; the child's rank is worker, the parent's foreman, per `docs/session-topology-and-roles.md`.
- `session_message`, `session_input`, `todo`, `permission`, `workspace` still 0 rows after a delegating turn.
- Still unobserved live: an assistant message with `time.completed` absent (streaming). Deduced from the completed shape; a longer task would catch it. Not blocking: the `event.seq` advance is the other half of the `working` rule and was observed to grow per turn.

Row 4 closes the measurement plan for the observer. All ten rows of `exploration.md` §6 relevant to this change (1–5, 10) are now [V]; rows 6–9 belong to `opencode-held`.
