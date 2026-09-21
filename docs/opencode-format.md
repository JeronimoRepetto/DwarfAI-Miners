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
  (forward slashes on Windows), `agent: "sample-agent"` (a placeholder for the agent name OpenCode
  ran as),
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
process probe is added in this slice: `textDelivery` still returns `null` for every OpenCode
dwarf, as `SimulatedProvider` does, and `HELDABLE_PROVIDERS` does not gain `'opencode'`.

AMENDED for #534 (was: "`LAUNCHABLE_PROVIDERS`/`HELDABLE_PROVIDERS` do not gain `'opencode'`" —
true when this row was measured, before Row 7 found `opencode run` needs no pid or process join
at all: a launch is correlated by `LaunchedSessionRegistry`'s own pid, captured live off the
process THIS app just spawned, never off a column read back from `opencode.db`). This row's
negative — no pid/process/port column in the schema — is unaffected and still governs why no
process probe reads the store; it is `LAUNCHABLE_PROVIDERS` that no longer depends on it. Only a
live process check could ever add a schema-level join here, and none is attempted.

AMENDED again for #534's T3 (was: "`textDelivery` still returns `null` for every OpenCode dwarf").
No longer true of a ROOT session: `opencode-run-continue` joins by the session id `opencode.db`
itself carries (Row 11), never a pid — this row's own negative (no pid/process/port column) is
exactly why the join had to be the session id and nothing else, and it still holds. `HELDABLE_PROVIDERS`
is unaffected either way: a continuation is a new process per turn, never a held stream.

## Row 5b — no port join for a TUI-started server — NEGATIVE `[V]`

Measured 2026-09-21, OpenCode 1.18.31, Windows 11, read-only (`Get-CimInstance Win32_Process`,
`Get-NetTCPConnection`). Two interactive OpenCode TUI processes were running at the time. Neither
owned a TCP socket in LISTEN state, and neither did any of their child processes. The only
established TCP connection from a TUI process went to an unrelated editor's local service, not to
an OpenCode server.

**Consequence:** on this build, the TUI's own internal server — confirmed by Row 3's residue note
to be a separate process from the TUI itself — is not reachable from another process **by port**,
and (Row 5) `opencode.db` carries no pid, process, host or port column either. There is no registry
to consult by any route this app has. A session opened outside this panel cannot be addressed from
the outside without guessing, and this project refuses to guess (#231): `chatAction`
(`src/renderer/src/lib/delivery/actionBar.ts`) now names this explicitly for an observed OpenCode
dwarf (`observedOpenCodeNoChannelReason`) instead of the generic no-channel placeholder (#507),
and it stays a refusal — not a "not yet" — until a channel this row's port-absence does not apply
to exists. AMENDED for #534 (was: "until #445 gives a **panel-launched** OpenCode session a
channel" — the plan at Row 5b's own measurement time). AMENDED again now that T3 has shipped:
`opencode-run-continue` is that channel, joined by the session id `opencode.db` itself already
carries (never a pid or a port), which is exactly the join this row's negative says does not exist
any other way — offered for a launched OR an observed root session alike, wider than the
panel-launched-only plan this row originally recorded. #445 remains the route for questions,
permissions and interruption over a held session, unaffected by this row.

## Row 6 — `opencode models --verbose`, the live catalogue `[V]`

Measured 2026-09-21, OpenCode 1.18.31, Windows 11, read-only (`opencode models --verbose`, no
conversation started). Numbered 6 of the routes rows the exploration reserved (6–9); `run` fills
row 7 below.

- `opencode models --verbose` prints one bare `provider/model` id line, then a `{ ... }` JSON
  object, repeated per model — 34/34 blocks parsed off the real captured output by splitting on
  id lines and brace-counting the object that follows.
- Same key set on every block: `id, providerID, name, family, api, status, headers, options,
cost, limit, capabilities, release_date, variants`. `cost`/`limit` are present and non-null even
  on free models (`cost.input/output/cache.read/write` are `0`, not absent).
- `variants` is a real effort picker, and it is not paid-only: 19 of the 34 measured models carry
  a non-empty `variants` map, keyed from `none/minimal/low/medium/high/xhigh/max/thinking`
  (vendor-specific per model), including several free ones. `Object.keys(variants).length > 0` is
  the correct presence check. `opencode run --help` documents `--variant <string>` as a real flag
  consuming one of these keys, and `session.model.variant` echoes the chosen one back.

**Consequence:** `src/main/providers/opencode/models.ts` parses this shape into `ModelOption[]`
with `effortLevels = Object.keys(variants)` when non-empty, and `agentModelCatalog.ts`'s
`openCodeModelCatalog` answers `source: 'provider'` — the Add Panel's model and effort pickers
read this live, exactly as Claude's and Antigravity's own live catalogues already do.

## Row 7 — `opencode run`, the message on stdin `[V]`

Measured 2026-09-21, same machine, scratch directories outside any real project, read-only
against the store otherwise (every session used was one this run created).

- `opencode run -m <provider/model> --format json` with the message on **stdin** and no
  positional argument: exit 0 in roughly 5–8 s across several samples. The session row appears in
  `opencode.db` about 1.3 s after spawn — well before the process finishes — with the directory
  the process ran in; the assistant message's `time.completed` lands at process exit, not
  meaningfully earlier. Polling the database buys early detection of session creation, never of
  turn completion.
- The prompt travels on stdin whenever argv carries no positional message, on both a POSIX shell
  and PowerShell, for a fresh `run` and for `run --session <id>` continuation alike, with the
  piped content passed through completely unmodified (no trimming — a trailing newline from
  whatever produced it is recorded verbatim). Positional and stdin **concatenate** when both are
  given (positional first, then the full stdin content) — neither is dropped, so a launcher must
  never place anything in argv it does not want appended to.
- `opencode run --help` documents only a positional `message [array]`; no `--stdin` flag exists,
  and none is needed.

**Consequence:** `buildOpenCodeLaunchArgs` (`src/main/sessionLaunch/launch.ts`) carries no prompt
in argv at all — the first prompt goes on `LaunchInvocation.stdin`, written and then closed by
`runLaunchProcess`, on the same terms every other launched provider already uses.

## Row 8 — the shell-hop directory trap `[V]`

Spawning `opencode run` through `child_process.spawn(cmd, args, { shell: true, cwd })` on Windows
(i.e. through `cmd.exe`) recorded the resulting session's `session.directory` /
`message.data.path.cwd` as the **parent** of the actual working directory — reproduced twice (2 of
2). Spawning directly, with no shell hop, recorded the correct directory on every attempt (4 of
4). Not root-caused further inside OpenCode's own source; reported as a reproduced, external
black-box observation.

**Consequence:** `resolveProgram` (`src/main/platform/cliDetection.ts`), which every launch and
the live model-catalogue spawn already go through, never sets `shell: true` — `buildLaunchSpawn`
(`launchRunner.ts`) spawns the resolved command directly, and `providers/opencode/models.ts`'s
catalogue spawn goes through the same `resolveProgram` seam rather than a bare `execFile` for
exactly this reason. Pinned by a test asserting no shell hop for both the launch and the
catalogue spawn.

## Row 9 — the open-stdin hang `[V]`

Leaving a spawned `opencode run` child's stdin open as an un-EOF'd pipe (Node's default `stdio:
'pipe'`, no explicit close) made the process hang indefinitely **after it had already produced its
full JSON output** — killed only by an external timeout, even though the same command finished in
under a second when stdin was explicitly closed (`stdio: ['ignore', 'pipe', 'pipe']`, or written
then ended).

**Consequence:** every launch already closes the child's stdin — `runLaunchProcess`
(`launchRunner.ts`) calls `child.stdin?.end(invocation.stdin)` immediately after spawn, which both
writes the prompt and signals EOF in one call — so this trap was already avoided by the existing
launch path; this row exists so a future continuation channel (`opencode run --session`, T3)
inherits the same discipline rather than reinventing stdio handling and rediscovering the hang.

## Row 10 — native binary and detection `[V]`

The native Windows binary runs cleanly through `npx opencode-ai`; WSL is not required. A
package-manager global shim on this machine was a broken placeholder (its postinstall step never
ran), so **PATH presence is not proof of a working install.** Detection stays override →
convention → PATH for this slice, with no new convention row: the only known Windows shim location
is the broken one, and a row pointing at it would report a CLI that cannot run. `OPENCODE_CLI_PATH`
is the documented way to name a known-working binary; the observer itself performs no detection at
all, since it reads the store directly.

## Row 11 — `opencode run --session`, the continuation channel `[V]`

Measured 2026-09-21, same machine, scratch directories, read-only against the store otherwise
(every session used was one this run created; pre-existing sessions were only read, never
continued).

- `opencode run --session <id> --format json`, message on stdin, run from the session's **own**
  directory: exit 0 in about 5 s, matching DB state. Same session id in every event; `message`
  count advances by one user+assistant pair; `event.seq` advances; `session.directory` never
  changes.
- Run from a **different** directory (same session id, whose home directory is elsewhere): exit
  **124** (killed by an external 120 s timeout) — zero stdout, zero stderr. But the DB shows the
  turn **did complete**, in about 2.5 s server-side: the message pair landed, the assistant row got
  its `time.completed`, and `session.directory` **stayed** the session's own — it never changed to
  the wrong folder. The turn this pair recorded also had its user text saved as a literal,
  quote-wrapped copy of the shell argument (`"\"...\""`), unlike every same-directory run, which
  stores the plain string — a symptom of the same cross-directory confusion, not a separate defect.
  **Conclusion: a "process alive past N ms" definition of delivered would misreport this case as
  failed, even though the message was handed over and answered.** `opencode run --help` documents a
  `--dir <path>` flag; not tested, and not relied on — the app runs every continuation in the
  session's own directory instead, which is the one folder this measurement covers.

**Consequence:** `opencodeContinue.ts`'s `deliverViaOpenCodeContinue` spawns with `cwd` = the
target's own `directory`, carried on the `opencode-run-continue` `TextDeliveryTarget` rather than
read from this process's own working directory — mirroring `codex-exec-resume`'s identical rule for
the identical reason.

## Row 12 — continuing with a different model `[V]`

`opencode run --session <id> -m <provider/model> "..."`, run from the session's own directory: exit
0, replied normally. `session.model` updated to the new model; the new assistant message's own
`providerID`/`modelID` reflect it too — **the CLI accepts a model swap mid-session, and both the
session-level and message-level fields update.**

**Consequence: not used.** #534's `buildOpenCodeContinueArgs` passes no `-m`/`--variant` at all —
omitting either flag keeps the session on the model it already has, which is what every continuation
this slice sends does. This row is recorded because it was measured, not because anything reads it;
carrying an explicit model/effort into a continuation (mirroring `codex-exec-resume`'s own #462) is
unstarted follow-up work, worth its own issue if it is ever wanted.

## Row 13 — two continuations of the same session race rather than refuse `[V]`

Two `opencode run --session <id>` calls against the SAME session, 1 s apart, from the session's own
directory: **neither was refused** — both exited 0. But they were not cleanly serialized either:
process A's stdout carried event blocks for both turns, process B's single event block answered
BOTH prompts in one reply. The DB ended up with 2 new user rows but **3** new assistant rows — one
answering only the first prompt, one answering both combined, one answering only the second — with
the second reply's `created` timestamp landing before the first reply's own `completed`.

This is the one place OpenCode's behaviour is measured to be **worse** than Codex's own
`codex-exec-resume`: a concurrent `codex exec resume` on a busy thread exits 1 at once (refused,
cleanly); a concurrent `opencode run --session` is accepted and races.

**Consequence:** runtime.ts's hold-while-busy machinery (mirroring #457's Codex design) is
load-bearing here in a way it is only a safety margin for Codex — nothing in this app may ever
spawn a second `opencode run --session` for one session while a first is still in flight, because
OpenCode's own CLI will not stop it from happening. See `opencodeHold.ts` and
`holdForBusyOpenCodeSession` in `runtime.ts`. `opencodeContinue.ts`'s own refusal-reading function
is written narrower than Codex's twin for the same reason: it never claims "a turn may already be
running" as the cause of a silent non-zero exit, because this measurement rules that cause out for
OpenCode specifically — a busy session is accepted, not refused.

## What this settles for the design

| Question              | Answer                                                                                                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source of truth       | `opencode.db` only (Row 1). No JSON-tree fixture, no dual-shape merge.                                                                                                                       |
| Liveness              | `event.seq` advance, or the newest assistant message lacking `time.completed`; never the database file's own mtime (Row 3).                                                                  |
| `waiting`             | Never reported — no pending-permission evidence exists on disk (Row 3 residue).                                                                                                              |
| Topology              | `session.parent_id` only; positive (Row 4) — a worker is drawn beside its foreman.                                                                                                           |
| Launch                | **Yes, via `opencode run`** (Row 7, #534) — a DETACHED, one-shot launch, the same terms Codex's and Antigravity's own launches already run on.                                               |
| Model catalogue       | **Live** (Row 6, #534) — `opencode models --verbose`, `source: 'provider'`, with a per-model effort picker where `variants` is non-empty.                                                    |
| Delivery channel      | **`opencode-run-continue`** (Row 11–13, #534) — offered for every ROOT session, launched or observed. A worker still gets none: the foreman hop for OpenCode is unmeasured and out of scope. |
| `transcriptPath`      | Always `undefined` — there is no per-session file to tail (Row 2).                                                                                                                           |
| `tokensObserved`      | Omitted in this change regardless of the columns being populated (maintainer question 3 pending).                                                                                            |
| `transcriptUpdatedAt` | The newest of `session.time_updated`, the newest assistant row's time and the scan that last saw its `event.seq` advance; never the WAL mtime (#459).                                        |

## Poll cost

`readOpenCodeEventSeqs` (`MAX(seq) GROUP BY aggregate_id` over `event`) is wrapped in
`pollProfiler.measureSync('opencode.eventSeqs', ...)` (`DWARFAI_PERF=1`), because it is a full scan
of the `event` table even though it rides the unique `(aggregate_id, seq)` index as a covering scan.
No regression has been measured on a real store yet — this is instrumentation, not a narrowed
query. If that stage's own line grows unbounded on a store that has run for months, the fallback is
`WHERE aggregate_id IN (…live ids…)`, narrowing the scan to sessions this poll already found.

### The size gate saves the read, never the verdict

A scan first `stat`s `opencode.db` and `opencode.db-wal`; both sizes unchanged since the previous
scan means nothing was written anywhere in the store, so no query runs at all. That is the whole of
what unchanged sizes prove. They say nothing about time, and two of the provider's verdicts are
measured against the clock rather than against the store: the `finish: "tool-calls"` stall guard
(`BUSY_WINDOW_MS`) and the silence windows retention drops on. A quiet-store scan therefore draws
its generation again from the facts the last read left behind — per session: max `event.seq` and
when it was last seen to move, the newest assistant row, `session.time_updated`, the last assistant
text — with the current clock, and with `event.seq` counted as advanced only on the scan that saw
it move. Republishing the previous generation instead (#461) left a dwarf `working` forty minutes
after its turn had closed on disk, and a finished subagent worker on the board until somebody
wrote a byte; a fresh provider instance against the same store answered `idle` at once.

## Negative results, stated plainly

- No `storage/` JSON tree on this build (Row 1).
- No pid, process, host or port column anywhere in the schema (Row 5).
- No TUI-started OpenCode process, or any of its children, holds a listening TCP port — there is
  no port-based join to a session started outside this panel either (Row 5b).
- No per-session JSONL transcript file (Row 2).
- `session_message` and `session_input` stay empty for both an interactive-TUI turn and (by
  inference from the identical schema and the measured negative) a headless invocation; nothing in
  this provider reads either table.
- `permission` stayed empty across every measured turn.
