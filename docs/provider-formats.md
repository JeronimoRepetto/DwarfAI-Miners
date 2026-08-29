# AI Coding CLI Session Formats — On-Disk Research (Windows)

Researched live on this machine on 2026-08-29 (Claude Code v2.1.251, Codex CLI 0.149/0.150-alpha, `.gemini` inspected).
Legend: **[V]** = verified against real files on this PC; **[I]** = inferred, not directly observed here.

---

## 1. Claude Code

### 1.1 Paths

| What                          | Path                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Transcript (main session)     | `C:\Users\jeron\.claude\projects\<encoded-cwd>\<session-uuid>.jsonl` **[V]**                                                   |
| Subagent transcripts          | `...\projects\<encoded-cwd>\<session-uuid>\subagents\agent-<agentId>.jsonl` + `agent-<agentId>.meta.json` **[V]**              |
| Big tool results (hooks etc.) | `...\projects\<encoded-cwd>\<session-uuid>\tool-results\*.txt` **[V]**                                                         |
| Live-session registry         | `C:\Users\jeron\.claude\sessions\<pid>.json` (+ `<pid>.<hash>.key`) **[V]** — the single best liveness source                  |
| Prompt history (global)       | `C:\Users\jeron\.claude\history.jsonl` — `{display, pastedContents, timestamp, project, sessionId}` **[V]**                    |
| Agent completion payloads     | `%LOCALAPPDATA%\Temp\claude\<encoded-cwd>\<session-uuid>\tasks\<agentId>.output` **[V]** (path seen inside task-notifications) |

### 1.2 Directory-name encoding of cwd

Every non-alphanumeric character of the absolute path (`\`, `:`, `.`, …) is replaced with `-`:

- `C:\Users\jeron\Desktop\AI-Tools` → `C--Users-jeron-Desktop-AI-Tools` **[V]**
- `C:\Users\jeron\Desktop\Pokedex-RAG\.claude-worktrees\x-fce647` → `C--Users-jeron-Desktop-Pokedex-RAG--claude-worktrees-x-fce647` **[V]** (note `\.` → `--`)

The encoding is **lossy** — do not decode it. Every transcript line carries the real path in a top-level `cwd` field (e.g. `"cwd":"C:\\Users\\jeron\\Desktop\\AI-Tools"`) **[V]**.

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
  "cwd": "C:\\Users\\jeron\\Desktop\\AI-Tools",
  "sessionId": "5efdffdd-53df-4509-b30d-c9e56552a22e",
  "version": "2.1.251",
  "gitBranch": "HEAD",
  "message": {
    "model": "claude-fable-5",
    "role": "assistant",
    "content": [{ "type": "text", "text": "Listo, ya está en marcha..." }],
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

Completion — a `queue-operation` line (`operation:"enqueue"`) and later a `user` line whose content is a `<task-notification>` XML-ish blob **[V]**:

```
<task-notification><task-id>ab5a348f033df1e7d</task-id><tool-use-id>toolu_017f...</tool-use-id><output-file>...\tasks\ab5a348f033df1e7d.output</output-file><status>completed</status><summary>Agent "Configure custom statusline" finished</summary>...
```

**Agent-in-flight algorithm** (verified against the live session, which had 2 agents running):

1. Scan parent `.jsonl` for `toolUseResult.status == "async_launched"` → collect `agentId`, `description`, `resolvedModel`, `toolUseId`.
2. Agent is **done** iff a later line contains `<task-id>AGENTID</task-id>` with `<status>completed</status>` (or failed). No such line → **in flight**. **[V]** (live agents had launch acks but no task-notification yet; the completed 24-Aug session had both.)
3. Cross-checks: `subagents\agent-<agentId>.jsonl` mtime still advancing (mine was, live) **[V]**; last `system` line's `pendingBackgroundAgentCount > 0` **[V]** (live file showed `pending=2`).

### 1.5 Liveness — RUNNING session detection

**Best signal: `~/.claude/sessions/<pid>.json`** **[V]** — one file per live interactive session:

```json
{
  "pid": 32896,
  "sessionId": "5efdffdd-53df-4509-b30d-c9e56552a22e",
  "cwd": "C:\\Users\\jeron\\Desktop\\AI-Tools",
  "startedAt": 1788001972417,
  "procStart": "134324755721362761",
  "version": "2.1.251",
  "kind": "interactive",
  "entrypoint": "cli",
  "pidDomain": "win32:m435tr0-turc0",
  "messagingSocketPath": "\\\\.\\pipe\\LOCAL\\cc-msg-952f...",
  "name": "ai-tools-70",
  "nameSource": "derived",
  "status": "busy",
  "updatedAt": 1788002904281,
  "statusUpdatedAt": 1788002904281
}
```

- Maps **sessionId → PID → cwd → status** directly. `status` observed values: `"busy"`, `"idle"` **[V]**. The current registry also reports `"waiting"` **[V]**; AgentName's two-state domain deliberately normalizes `waiting` (and unknown values) to `idle`. If transcript evidence still shows in-flight subagents, that parent remains visible as a foreman with active workers.
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
- Session title: `{"type":"ai-title","aiTitle":...,"sessionId":...}` lines; friendly name also in `sessions/<pid>.json` `.name` (e.g. `ai-tools-70`). **[V keys]**

---

## 2. Codex CLI

### 2.1 Paths & layout

- Transcripts ("rollouts"): `C:\Users\jeron\.codex\sessions\<YYYY>\<MM>\<DD>\rollout-<YYYY-MM-DD>T<hh-mm-ss>-<uuid-v7>.jsonl` **[V]**
- `C:\Users\jeron\.codex\history.jsonl` — user prompts: `{"session_id":"01a0...","ts":1787578797,"text":"..."}` **[V]**
- `C:\Users\jeron\.codex\session_index.jsonl` — `{"id":"<uuid>","thread_name":"...","updated_at":"..."}`; on this machine only Desktop/automation threads appeared → treat as partial index **[V content / I coverage]**
- `archived_sessions\`, `.codex-global-state.json` (Codex Desktop app state, ~1.1MB), `process_manager\chat_processes.json` (Desktop-spawned shell commands with `osPid`, `cwd`, `conversationId`, `turnId` — stale entries persist) **[V]**

### 2.2 Record schema

Every line: `{"timestamp":"ISO-8601","type":"...","payload":{...}}` **[V]**. Top-level `type`: `session_meta`, `turn_context`, `response_item`, `event_msg`, `world_state`, `inter_agent_communication_metadata`.

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
    "cwd": "C:\\Users\\jeron\\Documents\\Codex\\...",
    "originator": "Codex Desktop",
    "cli_version": "0.150.0-alpha.8",
    "model_provider": "openai"
  }
}
```

### 2.3 Liveness & turn detection

- No PID/lock files for CLI sessions were found → **file-based heuristics only**:
  1. **Turn in flight**: tail of the rollout — the last `event_msg` is `task_started` (or work records) with **no** subsequent `task_complete` for that turn. Both sampled finished files end exactly with `event_msg/task_complete`. **[V for completed; I for in-flight]**
  2. **Session alive**: rollout mtime recent **and** a `codex.exe` process exists (see §4). mtime alone can't distinguish "open but idle" from "closed" — Codex appends nothing while idle. **[I]**
- `process_manager\chat_processes.json` records Desktop-spawned commands with `osPid` but retains stale entries → not trustworthy for liveness **[V]**.

---

## 3. Gemini CLI

**Plain answer: on this machine, `C:\Users\jeron\.gemini` contains no Gemini CLI session data at all, and no live-session signal.** **[V]**

What's actually there:

- The directory is owned by **Google Antigravity** (IDE/agent product): `antigravity\`, `antigravity-cli\`, `antigravity-ide\`, `config\` (plugins + `projects\<uuid>.json` registry entries like `{"id":..., "name":"ToryLib", "projectResources":{resources:[{gitFolder:{folderUri:"file:///c%3A/Users/jeron/Desktop/ToryLib"}}]}}`), `GEMINI.md`, `settings.json` (MCP config). **[V]**
- Antigravity conversations exist as **binary protobuf** blobs: `antigravity\conversations\<uuid>.pb` (up to 22MB, last touched 2026-05-21). Messages/models are not recoverable without Antigravity's proto schema — impractical. **[V binary / I schema]**
- Gemini CLI's usual artifacts are absent: no `tmp\` (which would hold `tmp\<project-hash>\logs.json` + `chats\` session files **[I — standard Gemini CLI layout]**), no `history\`, no `oauth_creds.json`, no `google_accounts.json`. → Gemini CLI has effectively never been used here. **[V absence]**
- Recommendation for the monitoring app: implement a Gemini watcher that checks `~/.gemini/tmp/<hash>/` for `logs.json`/`chats/*.json` mtime **if it ever appears**, plus a `gemini` process check; ship it disabled/optional. There is nothing to verify against today.

---

## 4. Matching session files to live processes (click-to-focus)

Verified with `Get-CimInstance Win32_Process`:

- **Claude Code**: each interactive session is one native **`claude.exe`** process from `C:\Users\jeron\.local\bin\claude.exe` (NOT node). Beware: the Claude **Desktop** app is also `claude.exe` but lives under `C:\Program Files\WindowsApps\Claude_...` — filter by `ExecutablePath`. **[V]**
  - PID↔session mapping is **free**: `~/.claude/sessions/<pid>.json` gives `{pid, sessionId, cwd, status}`; all 3 registry PIDs matched live processes. Validate with `procStart` (FILETIME) vs `Get-Process .StartTime` to survive PID reuse. **[V]**
  - Focus: `claude.exe` has an empty `MainWindowTitle` (console app). Walk the PPID chain (`Win32_Process.ParentProcessId`) up to the hosting terminal. On this machine the only titled terminal window was `WindowsTerminal` ("M435TR0-TURC0: topanga-monorepo"). Realistic plan: ancestor-walk → find `WindowsTerminal.exe`/`conhost.exe`/VS Code → `SetForegroundWindow` on that window's HWND (EnumWindows by PID). Caveat: Windows Terminal hosts many tabs in ONE process/window — you can focus the window, but selecting the right **tab** needs UI Automation and is best-effort. **[V processes / I focus mechanics]**
  - Note: on this PC sessions are wrapped by an `effort-autopilot` broker (`node.exe internal-interactive-broker.js` → `claude.exe --settings ... --effort xhigh`), so the ancestor chain can pass through node/cmd/powershell before reaching a terminal. **[V]**
- **Codex**: no codex process was running to verify. Expect `codex.exe` (TUI) with a useful `CommandLine`; rollouts don't record a PID, so match `session_meta.payload.cwd` against the process working directory (not exposed by Win32_Process — needs NtQueryInformationProcess/handle.exe) or fall back to "newest active rollout while a codex.exe exists". **[I]**
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
| Codex rollout layout & record types                                     | Verified on 2 files (0.149.0 TUI + 0.150-alpha Desktop); function_call variant inferred |
| Codex liveness = mtime + task_started/complete + process                | Partially inferred (no live codex run observed)                                         |
| Gemini CLI: nothing on disk here                                        | Verified absence                                                                        |
| Click-to-focus via PPID walk to terminal                                | Process data verified; focusing mechanics inferred                                      |
