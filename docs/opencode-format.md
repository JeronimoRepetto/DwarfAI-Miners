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

## Row 14 — `session.tokens_*` is a cumulative per-session counter — POSITIVE `[V]`

Measured 2026-09-21, OpenCode 1.18.31, read-only, 13 scratch sessions (no real project paths,
process ids or usernames recorded — none of the figures below identify a machine or a person).

- `session.tokens_input/output/reasoning/cache_read/cache_write` equal, in every session measured,
  the sum of the same five fields over that session's own assistant messages (`message.data.tokens
{input, output, reasoning, cache: {read, write}}`) — including an 8-message session summing to
  135,530 input, 90 output, 149 reasoning, 224,512 cache read. The session row is therefore a
  **cumulative counter per session**, exactly the shape `accrue` (`domain/ledger.ts`) already
  differences for Codex's `tokens_used` — not a per-poll delta, and not something that needs a
  message-level sum on the live path (the message sum was the cross-check, not the source).
- A worker (child) session carries its own row with its own five counters; `session.parent_id`
  names its root, exactly as Row 4 already established for topology alone.
- `session.cost` read 0 across every measured session (all on a free model) — not used here; #335
  decides cost.

**Consequence:** this closes #444's "maintainer question 3 pending" (Row 2/"What this settles"
below): the answer is yes, `session.tokens_*` feeds `tokensObserved` — see `state.ts`'s
`opencodeUsageTokens` for exactly which of the five columns count and why, and #540 for the change
that acts on it.

## Row 15 — a global plugin loads for an unrelated project, over HTTP `[V]`

Measured 2026-09-22, OpenCode 1.18.31, Windows 11 (#588 T1). One live round trip was driven
entirely over HTTP against `opencode serve --port 49735 --hostname 127.0.0.1`, started inside a
throwaway scratch project (its own `git init`, its own `opencode.json` carrying
`{"permission":{"bash":"ask"}}`) — no real project was ever the target session. Every plugin file
used was a temporary probe under the user's global OpenCode config directory, removed before this
run ended; the directory's listing was diffed against a pre-change snapshot to confirm the exact
restore (the pre-existing files came back unchanged, nothing left over).

- **The global plugin directory is `~/.config/opencode/plugins/` (plural), and it is not
  documentation-only** — it already held several real `.ts` files in active use on this machine
  before this measurement touched anything, none of them named in
  `~/.config/opencode/opencode.json`'s `plugin` array (that key is absent from the file entirely).
  Auto-discovery at the global config path, exactly like the project-scoped `.opencode/plugin/`
  convention already on record for this app's own launch.
- A freshly created **`~/.config/opencode/plugin/`** (singular — confirmed absent on this machine
  before this measurement) was auto-discovered too: the singular/plural symmetry the CLI's own
  plugin-authoring help text documents for the project-local convention (any `*.ts` or `*.js` file
  in `.opencode/plugin/` or `.opencode/plugins/`) holds at global scope as well.
- **Both `.js` and `.ts` load, at global scope, with no build step** — a `.ts` probe dropped
  alongside the `.js` one in `~/.config/opencode/plugins/` loaded identically; the compiled binary
  transpiles it itself.
- **Loading is lazy, never at server boot.** `opencode serve --print-logs --log-level DEBUG` logged
  three config-file load attempts (`config.json`, `opencode.json`, `opencode.jsonc`, all under
  `~/.config/opencode/`) at startup and nothing about plugins. Every probe's own load-time log
  line, and a burst of `plugin.added` events (one per discovered plugin — well over the three
  probes, since the pre-existing plugins fired their own), landed only once the first session on
  that server did anything; the server touched no plugin before that.
- **`ctx.serverUrl` and `permission.asked` both reach a global plugin for a session in an unrelated
  project.** `POST /session` against the scratch project returned a session whose `directory` and
  `path.cwd` were the scratch project's own — nothing named or resembled a real project — and every
  probe's load-time line carried `ctx.serverUrl` set to the server's own base URL (a `URL`
  instance: `typeof ctx.serverUrl` is `"object"`, not `"string"`; `JSON.stringify` prints its
  `.toJSON()` href) plus `ctx.directory`/`ctx.worktree` pointing at the scratch project. `ctx`'s key
  set matched what was already on record: `client, project, worktree, directory,
experimental_workspace, serverUrl, $`.
- `POST /session/{id}/shell` turned out to be a dead end for provoking a permission: it bypasses
  the permission system entirely — its `bash` tool part went straight to `completed`, the config's
  `"permission":{"bash":"ask"}` notwithstanding. The real path is `POST /session/{id}/prompt_async`
  with a text part telling the model to run a command: that produced a `bash` tool call the config
  actually gated, `GET /permission` returned one pending row
  (`{"id":"per_...","permission":"bash",...}`), every probe's `event` hook fired with
  `type: "permission.asked"`, and `POST /session/{id}/permissions/{permissionID}` with
  `{"response":"once"}` returned `200` and let the turn continue.

**macOS and Linux global paths: read from the installed code, not run live on either OS — said
loudly, because no Windows substitute makes that a real measurement.** OpenCode 1.18.31 ships as a
single compiled Bun executable with no plain-JS source tree beside it, so its embedded bundle text
was searched directly. The function that resolves the base directories — the same one that
produces `~/.local/share/opencode` (Row 1) — reads `process.env.XDG_CONFIG_HOME`, falling back to
`os.homedir()` joined with `.config`, then joins that with `"opencode"`; the call is
`os.homedir()` unconditionally, with no `process.platform` branch anywhere in the function (unlike
an unrelated, separately-vendored dependency elsewhere in the same binary that does branch on
`win32` for its own `APPDATA` handling — traced by reading its own surrounding code, which
references `gcloud` and `npm` caches and has nothing to do with OpenCode's own paths). Because the
function OpenCode itself uses has no platform conditional, the same expression governs macOS and
Linux as governs the Windows result measured live above: **global config path =
`$XDG_CONFIG_HOME/opencode` if set, else `~/.config/opencode`, identically on all three
platforms.** This is source-level evidence from the exact shipped build, not a live run — no
machine running either OS was available to this measurement.

**Consequence for #588:** a plugin dropped in `~/.config/opencode/plugin/` or
`~/.config/opencode/plugins/` — either name, `.js` or `.ts`, no `opencode.json` entry — loads for
every OpenCode session on the machine, launched or merely observed, whether or not the session's
own project has anything to do with this app. `ctx.serverUrl` is already the address a global
plugin needs to call back into with `POST /session/{sessionID}/permissions/{permissionID}`, and
`permission.asked` is confirmed to reach it for a session this plugin's own install location has no
relationship to.

**Not yet measured, stated loudly:** whether the same plugin, loaded once and globally, also
receives events from a session this investigation did not itself create over HTTP — i.e. one
started by the user's own interactive `opencode` TUI, entirely outside any app driving it. Every
session in this row's measurement was created by this same investigation's own HTTP calls. Row 5b
already found no port to reach such a session from the outside; whether a globally-loaded plugin
still gets pushed events for a sibling session it never touched is a related but distinct question
this row does not close.

CLOSED by Row 16, T1b: yes, with the caveat that Row 16's TUI was itself started with a fixed
`--port`/`--hostname`, so "entirely outside any app driving it" holds for the plugin and the
permission round trip, not for how the port was chosen.

## Row 16 — the global plugin loads for the TUI's own spawned server too, and an outside answer unblocks it `[V]`

Measured 2026-09-22, OpenCode 1.18.31, Windows 11 (#588 T1b). This row closes Row 15's own open
question: does a session opened through the user's **interactive TUI** — the actual binary someone
runs in their own terminal, not this investigation's HTTP calls — still load the global plugin and
still answer to an outside `permission.asked` reply?

**Binary mode actually measured:** the TUI's default command (`opencode [project]`), given
`--port`, `--hostname 127.0.0.1`, `--prompt` and `--agent build`, run with no real terminal attached
(no pty). This is **not** `opencode run` — the process still tried to negotiate real terminal
capabilities (garbled cursor-position and capability-query escape sequences on its stdout, matching
what a genuine TUI does when it probes the terminal it's attached to, not what the non-interactive
`run` subcommand does) before falling back to driving itself off `--prompt` alone. Whether the same
holds with a real pty attached, and how large the plugin/permission window is for someone typing
live, is not measured here — this row covers the fixed-port, no-pty case only.

- **The global plugin loaded, once, for the TUI's own session**, with the exact same `ctx` key set
  already on record from Row 15 (`client, project, worktree, directory, experimental_workspace,
serverUrl, $`), and `ctx.serverUrl` equal to `http://127.0.0.1:<the --port value>/` — the same
  address `--hostname`/`--port` fixed on the command line, reachable from outside the TUI's own
  process.
- A throwaway scratch project (its own `git init`, its own `opencode.json` carrying
  `{"permission":{"bash":"ask"}}`) was the TUI's target directory; the session's `directory` in
  every event matched it exactly, confirming the TUI process itself — not this investigation's own
  HTTP calls — created the session.
- The prompt ("run this exact shell command using your bash tool: echo ...") drove the model into a
  gated `bash` tool call. The probe's event hook received `permission.asked`
  (`{"id":"per_...","permission":"bash","patterns":["echo ..."],...}`), identical in shape to Row
  15's own capture, and the tool part sat at `state.status: "running"` — genuinely blocked, not
  auto-allowed.
- **`POST http://127.0.0.1:<port>/session/{sessionID}/permissions/{permissionID}` with
  `{"response":"once"}`, issued from a plain `curl` call outside the TUI entirely, returned `200`**
  and the reply body `true`. Polling the session afterward showed the `bash` tool part move from
  `running` to `completed` with the real command output and `exit: 0`; the probe's own log then
  recorded `permission.replied` followed by `session.idle` — the turn finished normally. The outside
  answer did not just get accepted by the endpoint, it demonstrably unblocked the TUI's own turn.
- **Process shape, an aside:** with `--port` given explicitly, exactly one `opencode.exe` process
  served both the TUI and the HTTP server (confirmed via a live process listing) — unlike Row 3's
  residue note of two run ids for a plain, portless TUI launch. Not investigated further; recorded
  because it was observed, not because anything depends on it.
- Cleanup: the process tree was killed (`taskkill /F /T` on the top-level pid), confirmed by a
  before/after process listing showing zero `opencode.exe` processes and the fixed port no longer in
  a listening state. The probe file was removed from the global plugins directory and that
  directory's listing (names and sizes) was diffed against a pre-change snapshot: the same
  pre-existing files came back unchanged, nothing left over. The already-established singular
  `~/.config/opencode/plugin/` path (Row 15) was not touched again this time.

**Side effect, diagnosed and fixed — and the diagnosis is the useful part.** Partway through this
run the machine's globally linked `opencode` stopped working, failing with Windows' own _"this
version is not compatible with the Windows version you're running"_. That message is a red herring,
and the first reading of it here was wrong: nothing had upgraded, nothing was the wrong
architecture. The installed package was still 1.18.31, and `bin/opencode.exe` was a **479-byte shell
script** whose own text says why:

```
Error: opencode-ai's postinstall script was not run.
This occurs when using --ignore-scripts during installation, or when using a
package manager like pnpm that does not run postinstall scripts by default.
```

`opencode-ai` ships a stub and downloads the ~172 MB platform binary from its `postinstall`, and
pnpm does not run lifecycle scripts unless the dependency is approved. Windows then tries to execute
a shell script named `.exe` and reports an incompatible-binary error for it. The package's own
remedy works: `node ./postinstall.mjs` inside the installed package directory restored a 171.7 MB
`opencode.exe`, and `opencode --version` printed `1.18.31` again — no reinstall, no version change.

Worth a row of its own attention because it is a live, differently-shaped recurrence of Row 10's
warning: **a name on PATH is not proof of a working install**, and here even the file size was the
tell while the OS error message pointed somewhere else entirely. Any check this app makes for a
usable `opencode` should run the binary, not find it.

**Consequence for #588:** #588's premise holds for the case that matters — a session the user opens
in their own terminal, not only one this app launches, is visible to a global plugin and answerable
from outside it, provided the server's own address is known. What Row 16 does **not** establish is
how an outside caller learns that address for a TUI the user started without `--port` pinned by
whoever needs to reach it: Row 5b already found no port to join by, and a plain interactive launch
does not print the address anywhere this investigation captured. Wiring #588's actual channel still
needs an answer to that separate question; this row only closes whether the plugin-and-permission
mechanism itself works once the address is known.

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
| `tokensObserved`      | **From `session.tokens_*`** (Row 14, #540) — the five columns summed under `opencodeUsageTokens`'s shared cross-provider definition, on the root and on each worker from its own row.        |
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
