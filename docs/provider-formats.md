# AI Coding CLI Session Formats — On-Disk Research (Windows)

Researched live on this machine on 2026-08-29 (Claude Code v2.1.251, Codex CLI 0.149/0.150-alpha, `.gemini` inspected).
Legend: **[V]** = verified against real files on this PC; **[I]** = inferred, not directly observed here.

---

## 1. Claude Code

### 1.1 Paths

| What                          | Path                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Transcript (main session)     | `C:\Users\j\.claude\projects\<encoded-cwd>\<session-uuid>.jsonl` **[V]**                                                       |
| Subagent transcripts          | `...\projects\<encoded-cwd>\<session-uuid>\subagents\agent-<agentId>.jsonl` + `agent-<agentId>.meta.json` **[V]**              |
| Big tool results (hooks etc.) | `...\projects\<encoded-cwd>\<session-uuid>\tool-results\*.txt` **[V]**                                                         |
| Live-session registry         | `C:\Users\j\.claude\sessions\<pid>.json` (+ `<pid>.<hash>.key`) **[V]** — the single best liveness source                      |
| Prompt history (global)       | `C:\Users\j\.claude\history.jsonl` — `{display, pastedContents, timestamp, project, sessionId}` **[V]**                        |
| Agent completion payloads     | `%LOCALAPPDATA%\Temp\claude\<encoded-cwd>\<session-uuid>\tasks\<agentId>.output` **[V]** (path seen inside task-notifications) |

### 1.2 Directory-name encoding of cwd

Every non-alphanumeric character of the absolute path (`\`, `:`, `.`, …) is replaced with `-`:

- `C:\Users\j\Desktop\Sample-Project` → `C--Users-j-Desktop-Sample-Project` **[V]**
- `C:\Users\j\Desktop\Sample-Project\.claude-worktrees\x-fce647` → `C--Users-j-Desktop-Sample-Project--claude-worktrees-x-fce647` **[V]** (note `\.` → `--`)

The encoding is **lossy** — do not decode it. Every transcript line carries the real path in a top-level `cwd` field (e.g. `"cwd":"C:\\Users\\j\\Desktop\\Sample-Project"`) **[V]**.

### 1.3 Per-line schema (JSONL)

Top-level `type` values observed **[V]**: `user`, `assistant`, `system`, `attachment`, `queue-operation`, `file-history-snapshot`, `mode`, `permission-mode`, `last-prompt`, `ai-title`, `atis-latch` (the last five are tiny state markers: `{type, ..., sessionId}` only).

Common envelope on user/assistant/system/attachment lines **[V]**:
`parentUuid, isSidechain, type, message, uuid, timestamp, userType ("external"), entrypoint ("cli"), cwd, sessionId, version, gitBranch`

- **user** adds: `promptId, permissionMode, origin, promptSource`, optional `isMeta`, optional `toolUseResult` (rich parsed result object). `message.content` is a **string** for typed prompts, or an **array** of blocks (e.g. `tool_result`) for tool responses.
- **assistant** adds: `requestId`, `effort` (e.g. `"xhigh"` — the reasoning-effort setting) **[V]**. `message` = full API message: `{model, id, type, role, content[], stop_reason, usage}`. `message.model` e.g. `"claude-fable-5"`, `"claude-sonnet-5"` **[V]**. `usage.output_tokens_details.thinking_tokens` present **[V]**.
- **assistant content blocks**: `{"type":"text","text":...}` (speech-bubble material), `{"type":"thinking","thinking":...}`, `{"type":"tool_use","id":"toolu_...","name":...,"input":{...}}` **[V]**.
- **system**: `subtype` (observed `turn_duration`), `durationMs, messageCount,`**`pendingBackgroundAgentCount`** (count of still-running background agents at end of turn — very useful) **[V]**.
- **subagent lines** (in `subagents/agent-*.jsonl`) additionally carry `agentId` and `isSidechain:true`; assistant lines there also have `attributionAgent` **[V]**. In current versions subagents are **not** interleaved in the parent file (the live parent had 0 sidechain lines).

Minimal example (assistant, trimmed) **[V]**:

```json
{
  "parentUuid": "dd1ea5fc...",
  "isSidechain": false,
  "type": "assistant",
  "uuid": "2ed956a9...",
  "timestamp": "2026-08-29T11:22:50.389Z",
  "effort": "xhigh",
  "requestId": "req_011CeW...",
  "cwd": "C:\\Users\\j\\Desktop\\Sample-Project",
  "sessionId": "5efdffdd-53df-4509-b30d-c9e56552a22e",
  "version": "2.1.251",
  "gitBranch": "HEAD",
  "message": {
    "model": "claude-fable-5",
    "role": "assistant",
    "content": [{ "type": "text", "text": "Placeholder reply text..." }],
    "usage": { "output_tokens": 2586, "output_tokens_details": { "thinking_tokens": 2250 } }
  }
}
```

### 1.4 The Agent tool (subagents)

Spawn — assistant `tool_use` block **[V]**:

```json
{
  "type": "tool_use",
  "id": "toolu_01SqxjWtW7bcsXUEQQnKmprS",
  "name": "Agent",
  "input": {
    "description": "Map AI provider session formats",
    "subagent_type": "general-purpose",
    "prompt": "You are researching..."
  }
}
```

(`input.model` optional; may be absent.) The tool name is `Agent` in v2.x (`Task` in older versions **[I]**).

Launch ack — the tool_result arrives **immediately** (agents run async/background). The `user` line contains `content[].tool_result` with matching `tool_use_id`, and the top-level `toolUseResult` is the machine-readable one **[V]**:

```json
"toolUseResult":{"isAsync":true,"status":"async_launched","agentId":"a5d803981d4c3340f","description":"Map AI provider session formats","resolvedModel":"claude-fable-5","prompt":"..."}
```

`resolvedModel` gives the actual agent model even when `input.model` was empty.

Sidecar metadata — `subagents\agent-<agentId>.meta.json` **[V]**:

```json
{
  "agentType": "general-purpose",
  "description": "Map AI provider session formats",
  "toolUseId": "toolu_01SqxjWtW7bcsXUEQQnKmprS",
  "spawnDepth": 1
}
```

**It carries no status, no completion flag, and no end timestamp.** Re-checked on 2026-08-29 against every `agent-*.meta.json` in four live `Sample-Project` sessions (12 files, 136–157 bytes each): the only keys ever present are `agentType`, `description`, `toolUseId`, `spawnDepth` and an optional `model` (`"opus"`, `"sonnet"` — the requested alias, not the resolved id). Files for long-finished agents are byte-identical in shape to files for agents still running, and the file is not rewritten when the agent stops. **[V]** So the sidecar is useful for naming a worker, and useless as a completion authority — AgentName keys completion on the task-notification instead (below).

The `.output` sidecar is no better: `%LOCALAPPDATA%\Temp\claude\<encoded-cwd>\<session-uuid>\tasks\<agentId>.output` existed for six agents in one session but was **0 bytes for five of them**, including agents that had completed successfully. Presence and size carry no completion signal. **[V]**

Completion — a `queue-operation` line (`operation:"enqueue"`) and later a `user` line whose content is a `<task-notification>` XML-ish blob **[V]**:

```
<task-notification><task-id>ab5a348f033df1e7d</task-id><tool-use-id>toolu_017f...</tool-use-id><output-file>...\tasks\ab5a348f033df1e7d.output</output-file><status>completed</status><summary>Agent "Configure custom statusline" finished</summary>...
```

**`<status>` values — all three are terminal.** Counted across one real 1.5 MB parent transcript on 2026-08-29: `completed` ×21, `failed` ×2, **`killed` ×4** **[V]**. `killed` is what an accidental stop writes, with `<summary>Agent "…" was stopped by user</summary>`. Every notification's `<note>` also warns:

> A task-notification fires each time this agent stops with no live background children of its own. The user can send it another message and resume it, so the same task-id may notify more than once.

In that transcript each of the 6 agents was launched exactly once and notified exactly once, and every notification came **after** its launch record. **[V]**

**Which record carries the notification, and which only quotes one.** Re-measured on 2026-08-30 across every transcript on this machine — 366 files, ~373 MB, 191 launched agents. The blob is byte-identical in all of them, so **the envelope is the only thing that separates an ending from a quotation of one**, and getting that wrong costs a dwarf in one direction or the other. **[V]**

Claude Code writes the notification into exactly three envelopes:

| Record                                                                                                           | Field carrying the blob           | Note                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{type:"queue-operation", operation:"enqueue"\|"remove", timestamp, sessionId, content}`                         | `content`                         | **No `message` key at all.** The commonest by far (382 enqueue + 205 remove records); `remove` carries `reason:"absorbed_mid_turn"` and repeats the whole blob when the running turn swallows the queued message |
| `{type:"attachment", attachment:{type:"queued_command", prompt, commandMode:"task-notification", timestamp}, …}` | `attachment.prompt`               | The queued message materialised into a turn (138 records). Again no `message` key                                                                                                                                |
| `{type:"user", message:{content}, origin:{kind:"task-notification"}, promptSource:"system"}`                     | `message.content`, a plain string | The shape a naive reader expects, and the rarest of the three (167 records)                                                                                                                                      |

Everything else that contains the blob is a **quotation**, and counting one as an ending retires an agent that is still mining:

| Record                                                                                       | Why it is not an ending                                                               |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `type:"user"` with `toolUseResult` (`message.content[].tool_result`, `toolUseResult.stdout`) | A tool response — a Bash command that printed a transcript (199)                      |
| `type:"assistant"` (`text`, or a `tool_use` input)                                           | Model output: prose discussing one, or a command being written that contains one (71) |
| `type:"attachment"`, `attachment.type:"hook_success"`                                        | A hook's captured stdout echoing the prompt it was handed (84)                        |
| `type:"system"`, `subtype:"informational"`                                                   | A hook-blocked prompt quoted back in a warning (11)                                   |

The sharpest case sits inside the launch record itself: an `async_launched` result whose `toolUseResult.prompt` pasted a notification would start one agent and retire another on the same line. Across that corpus a scan over every string on the line would have retired **32 further ids on nothing but a quotation**, while finding no ending the three envelopes above miss. Since `terminalAgentIds` is remembered for the life of the process across every session, one quoted id evicts a live dwarf somewhere else — see the #64 note below.

**Agent-in-flight algorithm** (verified against the live session, which had 2 agents running):

1. Scan parent `.jsonl` for `toolUseResult.status == "async_launched"` → collect `agentId`, `description`, `resolvedModel`, `toolUseId`.
2. Agent is **done** iff one of the three delivery envelopes above carries `<task-id>AGENTID</task-id>` with `<status>` of `completed`, `failed` **or `killed`**. No such record → **in flight**. **[V]**
3. Cross-checks: `subagents\agent-<agentId>.jsonl` mtime still advancing (mine was, live) **[V]**; last `system` line's `pendingBackgroundAgentCount > 0` **[V]** (live file showed `pending=2`).

#### Ghost dwarfs — bug found and fixed (2026-08-29)

An agent stayed rendered as WORKING forever after its session had moved on. Two causes stacked:

- `killed` was not in the terminal-status list, so a stopped agent never registered as finished at all.
- Even with the status list complete, **the notification can scroll out of the 256 KiB transcript tail while the launch record is still inside it**. The launch is one short `toolUseResult` line; the notification lands hundreds of KB later, and the two are read through the same fixed-size window. Once the window slides past the notification but not past the launch, a re-parse resurrects a finished agent — permanently.

Fixed in two layers (`parse.ts`, `claudeProvider.ts`):

1. `killed` joined `completed`/`failed` in `TASK_NOTIFICATION_RE`.
2. `parseClaudeTranscriptTail` now also returns `terminalAgentIds` — every id seen reaching a terminal status in this tail, **whether or not its launch record is still in the window**. `ClaudeProvider` accumulates those into a process-lifetime `Set` and filters in-flight agents through it, so an agent that has ever been seen finishing can never re-enter the crew. Agent ids are globally unique 17-hex-char strings, so one flat set covers all sessions and grows by one short string per agent actually launched.

Since the sidecar files carry no completion state (§1.4), the task-notification plus that memory **is** the authority. Known trade-off: the `<note>` above says a killed agent can be resumed and would notify again; a resumed agent stays hidden until the app restarts. A ghost that never leaves is the worse failure, so this is the deliberate choice.

#### Ghost dwarfs again — the envelope, not the verdict (2026-08-30, issue #64)

A foreman running continuously still accumulated ghosts, and the cause was the same class as the `killed` bug above with the other half missing. The status list was right; **the parser was reading the wrong field**. `parseClaudeTranscriptTail` ran the regex over `message.content`, so the two envelopes that carry most notifications — which have no `message` key whatsoever — were never scanned at all. Measured against one real 2.4 MB session: ten subagents launched, ten notified, **two retired**. Across the ~373 MB corpus: 188 real endings, **117 seen**. The eight and the seventy-one that got away were the ghosts.

Note what made this survivable for so long. Both structural safety nets are unreachable for exactly this session shape: `enforcePendingCeiling` needs a `pendingBackgroundAgentCount`, which only rides a `turn_duration` line and does not appear in the last 256 KiB of a multi-megabyte transcript; and `pruneStaleLaunches` needs an idle registry status **plus** 60 minutes of foreman silence, which a foreman making back-to-back tool calls never has. They were carrying a load the primary signal should have carried, so the primary signal's failure showed up as a slow leak rather than a broken feature.

Fixed in `parse.ts` alone — the gates are untouched, because they are the nets and not the fix:

1. The scan runs on **every** line rather than inside the `user` branch, and reads the three delivery envelopes tabulated above instead of `message.content`.
2. Text nested inside a content **object** is reached rather than dropped by a `typeof item === 'string'` filter.
3. `TASK_NOTIFICATION_RE`'s status list is **unchanged**. The gap was the envelope, never the verdict.
4. Nothing outside those three envelopes counts, so a transcript quoting a notification never retires anybody. That direction is #60's failure and it is the worse one: an agent waiting on a human writes nothing at all, and the only thing keeping it on screen is that nobody claimed it ended.

Verified by replaying the shipped parser over all 366 real transcripts through the same 256 KiB windows the poller uses: **188 of 188 endings, zero missed, zero retired without evidence.** `__fixtures__/claude/notification-envelopes.jsonl` carries one scrubbed record of each envelope and each quotation — the bug survived earlier fixtures because every one of them had been written from the parser's assumptions rather than from a real record.

### 1.5 Liveness — RUNNING session detection

**Best signal: `~/.claude/sessions/<pid>.json`** **[V]** — one file per live interactive session:

```json
{
  "pid": 32896,
  "sessionId": "5efdffdd-53df-4509-b30d-c9e56552a22e",
  "cwd": "C:\\Users\\j\\Desktop\\Sample-Project",
  "startedAt": 1788001972417,
  "procStart": "134324755721362761",
  "version": "2.1.251",
  "kind": "interactive",
  "entrypoint": "cli",
  "pidDomain": "win32:placeholder-host",
  "messagingSocketPath": "\\\\.\\pipe\\LOCAL\\cc-msg-952f...",
  "name": "sample-project-70",
  "nameSource": "derived",
  "status": "busy",
  "updatedAt": 1788002904281,
  "statusUpdatedAt": 1788002904281
}
```

- Maps **sessionId → PID → cwd → status** directly. `status` observed values: `"busy"`, `"idle"` **[V]**. The current registry also reports `"waiting"` **[V]**; AgentName's two-state domain deliberately normalizes `waiting` (and unknown values) to `idle`. A parent that is idle but still has in-flight subagents stays visible, waiting, with its workers around it.
- **Rank is identity, not headcount.** The main session dwarf is always a `foreman`: it is the orchestrator whether or not it currently has agents out. Deriving the role from the in-flight count (the original behaviour) made the same dwarf change appearance mid-session, which read as a different dwarf arriving every time an agent started or finished. Only its `status` tracks the registry (busy → working, idle → waiting). Subagents are always workers. Codex is unaffected — its foreman promotion comes from a real `thread_spawn` parent link (§2.2), not from a count.
- All 3 files present corresponded to 3 alive `claude.exe` PIDs (verified with `Get-Process`) — stale files appear to be cleaned, but guard against PID reuse anyway: `procStart` is the Windows FILETIME of process start; compare with the process's real start time. **[V]**
- `updatedAt` is **not** a per-second heartbeat (was ~550s old on a busy session) — treat as "last state change", not liveness. **[V]**
- `messagingSocketPath` is a named pipe; pipe existence (`\\.\pipe\LOCAL\cc-msg-<hash>`) is a secondary liveness probe **[I]** (not tested).

Other candidates checked:

- `~/.claude/ide/` — **empty** here; only gets `<port>.lock` files when an IDE extension connects **[V empty / I semantics]**. Not usable for terminal sessions.
- `~/.claude/shell-snapshots/` — `snapshot-bash-<epochms>-<rand>.sh` written at session start; not reliably cleaned → weak signal, only tells you a session started around that time **[V]**.
- `~/.claude/tasks/<uuid>/` — contains `.lock`/`.highwatermark`; **stale** dirs from weeks ago persist → not a liveness signal **[V]**.
- `~/.claude/statsig` — does **not exist** in this version **[V]**.
- Transcript `.jsonl` mtime — good _activity_ fallback (the live file's mtime advanced during observation) and the only signal for `claude -p`/SDK runs that may not register in `sessions/` **[V mtime / I about -p]**.

### 1.6 Speech bubbles & thinking metadata

- Latest human-readable assistant text = last `type:"assistant"` line whose `message.content[]` contains a `{"type":"text"}` block (skip thinking-only and tool_use-only lines). **[V]**
- Thinking: `{"type":"thinking","thinking":"..."}` blocks; effort level in top-level `effort` on every assistant line; thinking token counts in `usage.output_tokens_details.thinking_tokens`. **[V]**
- Session title: `{"type":"ai-title","aiTitle":...,"sessionId":...}` lines; friendly name also in `sessions/<pid>.json` `.name` (e.g. `sample-project-70`). **[V keys]**

---

## 2. Codex CLI

### 2.1 Paths & layout

- Transcripts ("rollouts"): `C:\Users\j\.codex\sessions\<YYYY>\<MM>\<DD>\rollout-<YYYY-MM-DD>T<hh-mm-ss>-<uuid-v7>.jsonl` **[V]**
- `C:\Users\j\.codex\history.jsonl` — user prompts: `{"session_id":"01a0...","ts":1787578797,"text":"..."}` **[V]**
- `C:\Users\j\.codex\session_index.jsonl` — `{"id":"<uuid>","thread_name":"...","updated_at":"..."}`; on this machine only Desktop/automation threads appeared → treat as partial index **[V content / I coverage]**
- `archived_sessions\`, `.codex-global-state.json` (Codex Desktop app state, ~1.1MB), `process_manager\chat_processes.json` (Desktop-spawned shell commands with `osPid`, `cwd`, `conversationId`, `turnId` — stale entries persist) **[V]**

### 2.2 Record schema

Every line: `{"timestamp":"ISO-8601","type":"...","payload":{...}}` **[V]**. Top-level `type`: `session_meta`, `turn_context`, `response_item`, `event_msg`, `world_state`, `inter_agent_communication_metadata`, `compacted` (context-compaction marker, seen once per rollout on a long session; the parser ignores unknown types, so this needs no special handling) **[V, added 2026-08-29 re-verification]**.

- **`session_meta`** (line 1): `payload = {id (session uuid), timestamp, cwd, originator, cli_version, source, model_provider, base_instructions, history_mode, context_window}`. Observed `originator`: `"codex-tui"` (CLI) and `"Codex Desktop"` **[V]**. **cwd lives here.**
  - Spawned Codex workers observed locally use `source.subagent.thread_spawn = {parent_thread_id, agent_nickname, agent_role, agent_path, depth}` **[V schema]**. `parent_thread_id` is the only safe parent link: promote a session to foreman only while that worker and its referenced parent rollout are both live in the same scan. Do not infer a hierarchy from a shared cwd, process ancestry, or recency. Plain `source` values (`"cli"`/`"vscode"`) and non-`thread_spawn` subagent shapes carry no usable relationship. **[V]**
- **`turn_context`**: `payload = {turn_id, cwd, workspace_roots[], current_date, timezone, approval_policy, sandbox_policy, permission_profile, `**`model, effort, summary`**`, personality, collaboration_mode, ...}` — **model + reasoning effort live here** **[V keys]**.
- **`response_item`** `payload.type`:
  - `message` — `{role: user|assistant|developer, content:[{type:"input_text"|"output_text","text":...}]}` → assistant `output_text` = speech-bubble text **[V]**
  - `reasoning` — `{summary:[], encrypted_content:"gAAAA..."}` — thinking is **encrypted**, only its presence is visible **[V]**
  - `custom_tool_call` — `{id, status, call_id, name, input}` / `custom_tool_call_output` — `{call_id, output}` (linkage via `call_id`) **[V]**
  - `function_call`/`local_shell_call` variants exist in other Codex versions **[I]** (not present in the two sampled files)
  - `agent_message` — multi-agent messages `{author:"/root", recipient:"/root/issue44_docs", content[...encrypted]}` — Codex's own subagent traffic **[V]**
- **`event_msg`** `payload.type`: `task_started`, `task_complete`, `token_count` ({info.total_token_usage..., model_context_window, rate_limits}), `user_message` ({message}), `agent_message` ({message} — plain-text assistant reply, easiest bubble source), `item_completed`, `mcp_tool_call_end`, `patch_apply_end`, `thread_settings_applied` **[V]**.

Minimal example (trimmed) **[V]**:

```json
{
  "timestamp": "2026-08-28T14:10:45.797Z",
  "type": "session_meta",
  "payload": {
    "id": "01a048b5-5f35-7312-ab78-38db464920de",
    "cwd": "C:\\Users\\j\\Documents\\Codex\\...",
    "originator": "Codex Desktop",
    "cli_version": "0.150.0-alpha.8",
    "model_provider": "openai"
  }
}
```

### 2.3 Liveness & turn detection

- No PID/lock files for CLI sessions were found → **file-based heuristics only**:
  1. **Turn in flight**: tail of the rollout — the last `event_msg` is `task_started` (or work records) with **no** subsequent `task_complete` for that turn. Both sampled finished files end exactly with `event_msg/task_complete`. **[V for completed; V for in-flight, see below]**
  2. **Session alive**: rollout mtime recent **and** a `codex.exe` process exists (see §4). mtime alone can't distinguish "open but idle" from "closed" — Codex appends nothing while idle. **[V — see below]**
- `process_manager\chat_processes.json` records Desktop-spawned commands with `osPid` but retains stale entries → not trustworthy for liveness **[V]**.

**2026-08-29 re-verification against a real, actively-running Codex session on this machine** (this project, PID 32864 `codex.exe` alive since 14:23, confirmed via `Get-CimInstance Win32_Process`):

- **Bug found and fixed — tail-window busy detection**: a real rollout from this session showed a `task_started`→`task_complete` gap of **347,167 bytes** (one turn's tool output/reasoning). AgentName originally read only the last 256KiB (`TAIL_BYTES`) of the rollout to detect an open turn, so a genuinely in-progress turn whose `task_started` had already scrolled past that window looked idle — the main symptom reported ("no dwarfs appear with a live session"). Fixed by reading a larger, still-bounded tail (4 MiB, `BUSY_TAIL_BYTES` in `codexProvider.ts`) for busy detection specifically, keeping the smaller 256KiB read for the click-to-focus feed. Reproduced and verified against a synthetic rollout built from this session's real `session_meta`/`turn_context` lines plus an oversized body (`src/main/providers/codex/codexProvider.integration.test.ts`).
- **Bug found and fixed — date-directory scan gap**: a rollout lives in its **START-date** directory for its whole lifetime, but the provider only scanned `today` and `yesterday`. A session opened more than a day ago and still active would never be found even with a fresh mtime. Fixed with a configurable `CODEX_SCAN_DAYS` (default 7) scanning today back N-1 days; mtime filtering keeps this cheap.
- **Bug found and fixed — idle-but-open session disappears entirely**: once a rollout's mtime exceeds `CODEX_LIVENESS_WINDOW_S` (300s default), the old code dropped it outright — even though Codex writes nothing to the rollout while its CLI is open but quiet (confirmed here: the same real session's rollout had not been touched in ~1h49m while its process was still alive). Fixed with `CODEX_IDLE_RETENTION_S` (default 3600s): a stale-but-recent rollout stays visible while a `codex`-named process is confirmed running (`isCodexProcessRunning()`, PowerShell `Get-CimInstance Win32_Process` matching name/cmdline). **Caveat observed live**: by the time this was checked, the same session's rollout was quiet for ~1h58m — past even the 3600s default retention — so it was (correctly) still excluded; a user whose Codex sessions sit idle for multiple hours between prompts should raise `CODEX_IDLE_RETENTION_S`.
- `datePath()` uses local `Date` methods (`getFullYear`/`getMonth`/`getDate`), and real rollout directory names matched the local wall-clock date on this machine exactly — **no local/UTC mismatch found**; this was checked and is not a bug.
- Field names used by the parser (`session_meta.payload.id`/`session_id`/`cwd`, `turn_context.payload.model`/`effort`, `event_msg.payload.type` of `task_started`/`task_complete`) were re-confirmed byte-for-byte against this real, currently-relevant rollout — **no parser/format drift found**.

---

## 3. Gemini CLI

**Plain answer: on this machine, `C:\Users\j\.gemini` contains no Gemini CLI session data at all, and no live-session signal.** **[V]**

What's actually there:

- The directory is owned by **Google Antigravity** (IDE/agent product): `antigravity\`, `antigravity-cli\`, `antigravity-ide\`, `config\` (plugins + `projects\<uuid>.json` registry entries like `{"id":..., "name":"Sample-Project", "projectResources":{resources:[{gitFolder:{folderUri:"file:///c%3A/Users/j/Desktop/Sample-Project"}}]}}`), `GEMINI.md`, `settings.json` (MCP config). **[V]**
- Antigravity conversations exist as **binary protobuf** blobs: `antigravity\conversations\<uuid>.pb` (up to 22MB, last touched 2026-05-21). Messages/models are not recoverable without Antigravity's proto schema — impractical. **[V binary / I schema]**
- Gemini CLI's usual artifacts are absent: no `tmp\` (which would hold `tmp\<project-hash>\logs.json` + `chats\` session files **[I — standard Gemini CLI layout]**), no `history\`, no `oauth_creds.json`, no `google_accounts.json`. → Gemini CLI has effectively never been used here. **[V absence]**
- Recommendation for the monitoring app: implement a Gemini watcher that checks `~/.gemini/tmp/<hash>/` for `logs.json`/`chats/*.json` mtime **if it ever appears**, plus a `gemini` process check; ship it disabled/optional. There is nothing to verify against today.

---

## 4. Matching session files to live processes (click-to-focus)

Verified with `Get-CimInstance Win32_Process`:

- **Claude Code**: each interactive session is one native **`claude.exe`** process from `C:\Users\j\.local\bin\claude.exe` (NOT node). Beware: the Claude **Desktop** app is also `claude.exe` but lives under `C:\Program Files\WindowsApps\Claude_...` — filter by `ExecutablePath`. **[V]**
  - PID↔session mapping is **free**: `~/.claude/sessions/<pid>.json` gives `{pid, sessionId, cwd, status}`; all 3 registry PIDs matched live processes. Validate with `procStart` (FILETIME) vs `Get-Process .StartTime` to survive PID reuse. **[V]**
  - Focus: `claude.exe` has an empty `MainWindowTitle` (console app). Walk the PPID chain (`Win32_Process.ParentProcessId`) up to the hosting terminal. On this machine the only titled terminal window was `WindowsTerminal` ("PLACEHOLDER-HOST: some-project"). Realistic plan: ancestor-walk → find `WindowsTerminal.exe`/`conhost.exe`/VS Code → `SetForegroundWindow` on that window's HWND (EnumWindows by PID). Caveat: Windows Terminal hosts many tabs in ONE process/window — you can focus the window, but selecting the right **tab** needs UI Automation and is best-effort. **[V processes / I focus mechanics]**
  - Note: sessions can be wrapped by a local broker/wrapper (`node.exe <broker>.js` → `claude.exe --settings ... --effort xhigh`), so the ancestor chain can pass through node/cmd/powershell before reaching a terminal. **[V]**
- **Codex**: **[V, 2026-08-29]** a live `codex.exe` process was observed (`C:\Users\j\AppData\Local\pnpm\store\...\@openai\codex\...\bin\codex.exe`), plus its supporting `node.exe` processes carry a directly useful `--working-dir <path>` argument in `CommandLine` — a much stronger correlation signal than `session_meta.payload.cwd` matching, and worth using for a future PID-based click-to-focus (rollouts still carry no PID of their own). `Win32_Process.CommandLine` does not expose the codex.exe TUI's own live working directory, so `session_meta.cwd` remains the only per-rollout signal; the `--working-dir` node helper processes are the closest thing to a verifiable PID↔project link found so far. Matching "any process with 'codex' in name or command line" (used for the idle-retention liveness check, §2.3) is intentionally broad and can false-positive on the Codex Desktop app (`ChatGPT.exe`, whose install path contains `OpenAI.Codex`) — acceptable here since it only extends a bounded retention window, never grants indefinite visibility.
- **Gemini**: would run as `node.exe` with `gemini` in `CommandLine` (`...\gemini.cmd` → node). Detectable via `WHERE CommandLine LIKE '%gemini%'`, but with no session files there is nothing to correlate. **[I]**

Suggested poller: every 1–2 s read `~/.claude/sessions/*.json` (tiny files) + verify PIDs; every 2–5 s stat the newest `*.jsonl` per provider and tail-parse only appended bytes (files are append-only JSONL — keep a byte offset per file). Lines can exceed 10KB; always read incrementally, never whole-file.

---

## 5. Confidence summary

| Claim                                                                   | Status                                                                                  |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Claude dir encoding lossy; `cwd` field per line                         | Verified                                                                                |
| Claude line schema, `effort`, model, thinking blocks                    | Verified (v2.1.251; older versions differ, e.g. sidechains inline, `Task` tool name)    |
| `sessions/<pid>.json` busy/idle + PID mapping                           | Verified live (cleanup-on-crash not tested)                                             |
| Agent async launch / task-notification completion / `subagents\` layout | Verified live + on completed session                                                    |
| `<status>` is one of completed/failed/killed; all terminal              | Verified (21/2/4 occurrences in one real transcript, 2026-08-29)                        |
| Three delivery envelopes carry the notification; the rest quote it      | Verified (366 files / ~372 MB, 2026-08-30; 188 of 188 endings recovered, 0 false)       |
| `agent-*.meta.json` and `tasks\*.output` carry no completion state      | Verified (12 real sidecars across 4 sessions; 5 of 6 output files empty)                |
| Codex rollout layout & record types                                     | Verified on 2 files (0.149.0 TUI + 0.150-alpha Desktop); function_call variant inferred |
| Codex liveness = mtime + task_started/complete + process                | Verified live 2026-08-29 (real codex.exe + a real 347KB task_started/task_complete gap) |
| Gemini CLI: nothing on disk here                                        | Verified absence                                                                        |
| Click-to-focus via PPID walk to terminal                                | Process data verified; focusing mechanics inferred                                      |
