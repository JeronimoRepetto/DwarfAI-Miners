# OpenCode — on-disk session storage (Windows)

Measured 2026-09-17 against a native Windows install, `npx opencode-ai` (build string
**1.18.31**), on the maintainer's machine. Read-only throughout: the database was opened with
`node:sqlite` `DatabaseSync(..., { readOnly: true })`; nothing under OpenCode's own store was
written by this investigation. Full detail lives in `openspec/changes/opencode-observer/
measurements-2026-09-17.md` — this document is the versioned, redacted summary a parser is
written against.

Legend: **[V]** verified directly against this machine's live store. **[I]** inferred from public
sources (an issue, a changelog) and never observed here; a field or shape marked `[I]` MUST NOT be
read by production code until it is measured and moves to `[V]`.

**Version floor: 1.18.31.** Every `[V]` claim below is pinned to that build. An older or newer
OpenCode may write a different shape; this provider degrades to "not observed" rather than guessing
(see Row 1 and Row 2 below).

## Row 1 — install and store shape `[V]`

- `npx opencode-ai --version` → `1.18.31`. A package-manager global shim also existed on this
  machine and was a broken placeholder that skipped the package's own postinstall step — PATH
  presence alone is not proof of a working install.
- Store root: `~/.local/share/opencode/` — the same POSIX-shaped path under the Windows user
  profile as on macOS or Linux; nothing about the shape branches on the host OS. Contents:
  `opencode.db`, `opencode.db-shm`, `opencode.db-wal`, `auth.json`, `log/`, `repos/`.
- **No `storage/` JSON tree.** This build writes SQLite only. **Maintainer decision:** the provider
  reads `opencode.db` and nothing else; a machine carrying a legacy `storage/` tree and no database
  is "OpenCode not observed" rather than read through a second, JSON-shaped path.

## Row 2 — `opencode.db` schema `[V]`

`journal_mode = wal`. A WAL database must be read with its `-wal`/`-shm` siblings present, exactly
as the existing Codex reader already does.

Tables that matter to this provider (full DDL captured; see the measurements document for every
table, including the ones this provider never reads):

- **`session`**: `id`, `project_id`, `workspace_id`, **`parent_id`** (indexed —
  `session_parent_idx`; the ONLY topology source, see Row 4), `slug`, **`directory`**, `path`,
  `title`, `version`, `cost`, `tokens_input`, `tokens_output`, `tokens_reasoning`,
  `tokens_cache_read`, `tokens_cache_write`, `agent`, `model` (JSON string), `time_created`,
  `time_updated`, `time_compacting`, `time_archived`.
- **`message`**: `id`, `session_id`, `time_created`, `time_updated`, `data` (JSON blob).
- **`part`**: `id`, `message_id`, `session_id`, `time_created`, `time_updated`, `data` (JSON blob).
- **`event`**: `id`, `aggregate_id` (a session id), `seq`, `type`, `data`. Unique index
  `(aggregate_id, seq)`. An event-sourced log: `MAX(seq) GROUP BY aggregate_id` is a covering scan
  and the cleanest activity signal on disk.

**Negative:** no `storage/` tree (Row 1); **no pid or process column anywhere in the schema** (Row
5); no per-session JSONL transcript file of any kind.

## Row 3 — one live turn, read back read-only `[V]`

One ordinary OpenCode turn ("what does this project do") was run through the interactive TUI, then
read back after it quit.

- **`session`** after the turn: `parent_id: null` (a root), `directory` = the project folder
  (forward slashes on Windows), `agent: "gentle-orchestrator"` (the agent name OpenCode ran as),
  `model` = a JSON string `{"id":"mimo-v2.5","providerID":"opencode-go"}`, token and cost columns
  populated, `time_updated` moved to the turn's end.
- **`message.data`** (JSON): the **user** message carries `role: "user"`, `time.created`, `agent`,
  `model {providerID, modelID}`. Each **assistant** message carries `role: "assistant"`,
  `parentID` (the id of the USER message it answers — a reply edge inside the conversation, never
  topology; see Row 4), `mode`, `agent`, `path`, `modelID`, `providerID`, `time.created` and
  **`time.completed`** (absent while streaming, present once the message is done),
  `tokens {total, input, output, reasoning, cache {read, write}}`, `cost`, and `finish`
  (`"tool-calls"` for an intermediate step, `"stop"` for the final one).
- **`part.data`** types seen: `text {type, text, time}`, `reasoning {type, text, time}` (never
  shown as the agent's own words — it is the model's scratch), `tool {type, tool, callID,
state: {status, ...}}`, `step-start {type, snapshot}`, `step-finish {type, reason, snapshot,
tokens, cost}`.
- **`event`**: `aggregate_id` = the session id, `seq` monotonically increasing per session, `type`
  in `session.created.1`, `session.updated.1`, `message.updated.1`, `message.part.updated.1`. The
  max `seq` per session grows while a turn runs and stops when it ends.
- **Negative, and load-bearing:** `session_message`, `session_input`, `todo`, `permission`,
  `workspace` all stayed empty across the measured turn.

### Residue: the measured turn was the interactive TUI, not `opencode run` `[V]`

The session above was produced by OpenCode's own interactive TUI (confirmed via
`~/.local/share/opencode/log/opencode.log`: every launch writes two run ids within a second of
each other — one for the TUI process, one for the server instance it spawns). Consequence: **on
1.18.31 an ordinary interactive turn writes `session`, `message`, `part` and `event` only.**
`session_message` and `session_input` stay empty even for the interactive TUI, so there is no
second read path to add — the feed reads `message` × `part` and nothing else. This closes the
question of whether a non-interactive `opencode run` invocation would behave differently: both the
`run` shape and the TUI shape leave those two tables untouched, so there is nothing further to
measure here.

**No `permission` row appeared** across the measured turn — every permission was auto-allowed by
the agent's own policy — so there is no on-disk evidence of a pending-permission state. A provider
that cannot prove blockage never reports it: `SessionStatus 'waiting'` is never published for an
OpenCode dwarf.

## Row 4 — a Task subagent populates `session.parent_id` — POSITIVE `[V]`

A second interactive-TUI turn delegated a small job to a subagent via the `task` tool.

- **Parent session**: `parent_id: null`, one `part` of `type: "tool"` carrying `tool: "task"`,
  `state.status: "completed"`.
- **Child session**: `parent_id` = the parent session's id, `agent: "general"`, the **same**
  `directory` as the parent, its own `tokens_*`/`cost`/`message`/`part` rows, and a `model` JSON
  carrying an extra `variant` key the parent's model JSON does not have.
- So the topology edge is exactly `session.parent_id → session.id`, one row per subagent session,
  on the indexed `session_parent_idx` column. The parent's `task`-tool part is corroborating
  evidence of the spawn; `message.data.parentID` played no role in it and MUST NEVER be read as
  topology — it is a reply edge from an assistant message to the user message it answers, present
  on every ordinary root session.

**Consequence:** a worker is drawn beside its foreman, in the same mine, when `session.parent_id`
names a session this scan also sees. **No live measurement remains open for this change** — Row 4
was the last one waiting on a real subagent spawn, and it is closed positive.

## Row 5 — no pid or process join — NEGATIVE `[V]`

`session` carries no pid, process id or socket/port column anywhere in the schema (Row 2). No
process probe is added in this slice: `textDelivery` returns `null` for every OpenCode dwarf, as
`SimulatedProvider` does, and `LAUNCHABLE_PROVIDERS`/`HELDABLE_PROVIDERS` do not gain `'opencode'`.
Only a live process check could ever add a join here, and none is attempted.

## Row 10 — native binary and detection `[V]`

The native Windows binary runs cleanly through `npx opencode-ai`; WSL is not required. A
package-manager global shim on this machine was a broken placeholder (its postinstall step never
ran), so **PATH presence is not proof of a working install.** Detection stays override →
convention → PATH for this slice, with no new convention row: the only known Windows shim location
is the broken one, and a row pointing at it would report a CLI that cannot run. `OPENCODE_CLI_PATH`
is the documented way to name a known-working binary; the observer itself performs no detection at
all, since it reads the store directly.

## What this settles for the design

| Question         | Answer                                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Source of truth  | `opencode.db` only (Row 1). No JSON-tree fixture, no dual-shape merge.                                                      |
| Liveness         | `event.seq` advance, or the newest assistant message lacking `time.completed`; never the database file's own mtime (Row 3). |
| `waiting`        | Never reported — no pending-permission evidence exists on disk (Row 3 residue).                                             |
| Topology         | `session.parent_id` only; positive (Row 4) — a worker is drawn beside its foreman.                                          |
| Delivery channel | None — `textDelivery` returns `null` (Row 5).                                                                               |
| `transcriptPath` | Always `undefined` — there is no per-session file to tail (Row 2).                                                          |
| `tokensObserved` | Omitted in this change regardless of the columns being populated (maintainer question 3 pending).                           |

## Poll cost

`readOpenCodeEventSeqs` (`MAX(seq) GROUP BY aggregate_id` over `event`) is wrapped in
`pollProfiler.measureSync('opencode.eventSeqs', ...)` (`DWARFAI_PERF=1`), because it is a full scan
of the `event` table even though it rides the unique `(aggregate_id, seq)` index as a covering scan.
No regression has been measured on a real store yet — this is instrumentation, not a narrowed
query. If that stage's own line grows unbounded on a store that has run for months, the fallback is
`WHERE aggregate_id IN (…live ids…)`, narrowing the scan to sessions this poll already found.

## Negative results, stated plainly

- No `storage/` JSON tree on this build (Row 1).
- No pid, process, host or port column anywhere in the schema (Row 5).
- No per-session JSONL transcript file (Row 2).
- `session_message` and `session_input` stay empty for both an interactive-TUI turn and (by
  inference from the identical schema and the measured negative) a headless invocation; nothing in
  this provider reads either table.
- `permission` stayed empty across every measured turn.
