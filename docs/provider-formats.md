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

- **user** adds: `promptId, permissionMode, origin, promptSource`, optional `isMeta`, optional `toolUseResult` (rich parsed result object). `message.content` is a **string** or an **array** of blocks, and the array is not only for tool responses — a typed prompt takes either shape. Reading it as "string = prompt, array = tool result" is what issue #216 fixed; see §1.6 for the counts.
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

A nested agent's sidecar carries two more keys, `parentAgentId` and a deeper `spawnDepth` — see
"Depth is real" below, and `providers/claude/subagents.ts`, which is the one reader of this file
for both the live board and the Mine History panel (#267). All depths sit FLAT in the one
`subagents/` directory: a grandchild's transcript and sidecar are named exactly like a depth-1
worker's and are not nested under it **[V]** (2026-09-07).

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

Since the sidecar files carry no completion state (§1.4), the task-notification plus that memory **is** the authority. Known trade-off, and it held until #179 below: the `<note>` above says a resumed agent notifies again, and a resumed agent stayed hidden for the life of the process. A ghost that never leaves is the worse failure, so that was the deliberate choice.

#### Ghost dwarfs again — the envelope, not the verdict (2026-08-30, issue #64)

A foreman running continuously still accumulated ghosts, and the cause was the same class as the `killed` bug above with the other half missing. The status list was right; **the parser was reading the wrong field**. `parseClaudeTranscriptTail` ran the regex over `message.content`, so the two envelopes that carry most notifications — which have no `message` key whatsoever — were never scanned at all. Measured against one real 2.4 MB session: ten subagents launched, ten notified, **two retired**. Across the ~373 MB corpus: 188 real endings, **117 seen**. The eight and the seventy-one that got away were the ghosts.

Note what made this survivable for so long. Both structural safety nets are unreachable for exactly this session shape: `enforcePendingCeiling` needs a `pendingBackgroundAgentCount`, which only rides a `turn_duration` line and does not appear in the last 256 KiB of a multi-megabyte transcript; and `pruneStaleLaunches` needs an idle registry status **plus** 60 minutes of foreman silence, which a foreman making back-to-back tool calls never has. They were carrying a load the primary signal should have carried, so the primary signal's failure showed up as a slow leak rather than a broken feature.

Fixed in `parse.ts` alone — the gates are untouched, because they are the nets and not the fix:

1. The scan runs on **every** line rather than inside the `user` branch, and reads the three delivery envelopes tabulated above instead of `message.content`.
2. Text nested inside a content **object** is reached rather than dropped by a `typeof item === 'string'` filter.
3. `TASK_NOTIFICATION_RE`'s status list is **unchanged**. The gap was the envelope, never the verdict.
4. Nothing outside those three envelopes counts, so a transcript quoting a notification never retires anybody. That direction is #60's failure and it is the worse one: an agent waiting on a human writes nothing at all, and the only thing keeping it on screen is that nobody claimed it ended.

Verified by replaying the shipped parser over all 366 real transcripts through the same 256 KiB windows the poller uses: **188 of 188 endings, zero missed, zero retired without evidence.** `__fixtures__/claude/notification-envelopes.jsonl` carries one scrubbed record of each envelope and each quotation — the bug survived earlier fixtures because every one of them had been written from the parser's assumptions rather than from a real record.

#### Foreground subagents leave no launch record at all (2026-09-03, issue #157)

A session started through the Agent SDK spawned two subagents, one of which spawned one of its
own, and the panel drew none of them. The algorithm above is not wrong; it was never given
anything to read.

**Measured on one real SDK-hosted session, three subagents (depths 1, 1 and 2).** In the parent
`.jsonl`: **zero** `async_launched` records, **zero** `<task-notification>` blobs and **no
`pendingBackgroundAgentCount` line whatsoever** — the session wrote no `turn_duration` line at all.
All three `subagents/agent-<id>.jsonl` transcripts and their `.meta.json` sidecars were written
normally. **[V]**

The difference is `is_backgrounded`. A backgrounded launch acks immediately with the
`async_launched` result §1.4 tabulates; a **foreground** one blocks the spawning tool call and acks
with the subagent's actual result, so nothing announces it on disk. Both are the same Agent tool.
Counting tool calls against results in a recent ordinary session gives 40 `Agent` calls and 40
`async_launched` records, so the backgrounded form is what an interactive session produces today
— and an SDK-hosted one is not obliged to.

So the transcript is silent about a foreground subagent, and by the count invariant that silence is
not a report of zero. `sessionLaunch/heldCrew.ts` reads the SDK stream instead, where
`task_started` carries `spawn_depth` outright.

#### Depth is real, and the two records for one nested agent live in different files **[V]**

Three findings from the same pass, over 321 `agent-*.meta.json` sidecars on one machine:

- **`spawnDepth` above 1 is common:** 278 at depth 1, **32 at depth 2, 11 at depth 3**.
  `session-topology-and-roles.md` §7 says neither provider "has been observed producing anything
  below 1"; that is now false, and #157's `worker2` rank is what the panel draws them as.
- **The sidecar carries `parentAgentId`** for a nested agent — a fifth key §1.4's list does not
  name, present on the depth-2 sidecars and absent from the depth-1 ones.
- **A nested agent's launch and its ending are written to different transcripts.** For one traced
  depth-2 agent, the `async_launched` record sits only in the LAUNCHING worker's own
  `subagents/agent-<parent>.jsonl`, while its `<task-notification>` arrives in the ROOT session's
  transcript as the usual `queue-operation` pair. The asymmetry runs in the safe direction:
  endings are visible session-wide (so `terminalAgents` already retires them), launches only where
  they happened. `ClaudeProvider` read each worker's tail but took only `tokensObserved`,
  `lastAssistantText` and `pendingQuestion` from it — **its `inFlightAgents` were discarded, which
  is why an OBSERVED session's depth-2 agents were invisible until #267.** They are now the
  discovery source: the same tail read, the same extractor and the same terminal-status rule, one
  level down, so the launch costs no extra read per poll (see `claudeProvider.snapshotSession`'s
  crew walk, and #267 for why the alternative — a `readdir` of `subagents/` plus a read per
  `agent-*.meta.json` in it — was refused).

**`pendingBackgroundAgentCount` counts the whole tree, not the direct children.** At one
`turn_duration` line reporting `pending=3`, exactly three agents were live by launch/notification
timestamps: two at depth 1 and **one at depth 2**. That is worth knowing before the count is
reconciled against a crew — the provider believes only depth-1 launches in the map that count
judges, so a descendant is a standing, permanent contribution to the `unexplainedShortfalls` #36
chases. #267 keeps it that way ON PURPOSE rather than netting the two off: the count is the root
stating how many agents IT has, it says how many and never which, and a grandchild kept in a
separate memory cannot be adopted or evicted by a number that never described it.

#### An ending is "stopped for now" — a resumed agent (2026-09-03, issue #179)

Two background agents died on a provider rate limit (three `failed` notifications each, one per
retry), the orchestrator resumed both with `SendMessage` to the same agent ids, both
`subagents/agent-<id>.jsonl` files resumed growing and the parent's next `turn_duration` line
reported `pendingBackgroundAgentCount: 2` — and the panel drew the foreman alone. Replaying
`parseClaudeTranscriptTail` over that transcript at 256 KB and at 4 MB returned
`inFlightAgents: []` both times, with the `async_launched` records well inside the 4 MB window.
**[V]**

The `<note>` on every notification said this would happen: _"The user can send it another message
and resume it, so the same task-id may notify more than once."_ **A resume writes no second
`async_launched` record**, so nothing the transcript contains can outrank the ending, and the
`terminalAgents` memory that #64 relies on keeps the id retired for the life of the process.

What separates a resumed agent from a dead one is not in the parent transcript at all — it is
whether the agent's own `subagents/agent-<id>.jsonl` is still being appended to. So the rule takes
three pieces of evidence and no fewer:

1. the agent's **latest** ending said `failed` (`parseClaudeTranscriptTail` reports those, with
   their launch records, as `failedAgents`; `completed` and `killed` stay hard-terminal, the first
   because a finished agent's last write can legitimately land after its notification, the second
   because it is the status whose omission was the original ghost dwarf);
2. that agent's own transcript was written **after this app observed the ending** — the poll clock,
   not the notification's timestamp, so a final line racing the ending by a millisecond is not
   mistaken for a return; and
3. the parent's `pendingBackgroundAgentCount` exceeds the crew, i.e. Claude Code itself says
   somebody is running.

The sweep costs one `stat` per failed agent and runs only while the count is short (it sits ahead
of #36's rate limit, since a resume can arrive at any tick long after the shortfall settled).
Known limit, and the reason the count still binds: a **second** ending after a resume is
byte-identical to the first, so a resumed agent that finishes leaves by the ordinary exits — a
count of zero, the #45 ceiling, or #40's silence — rather than on its own notification.

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

- Maps **sessionId → PID → cwd → status** directly. `status` observed values: `"busy"`, `"idle"`, `"waiting"` **[V]**. All three are preserved since issue #34 (`SessionStatus` in `contracts.ts`); only a value none of the three matches normalizes to `idle`, the conservative reading. A parent that is idle but still has in-flight subagents stays visible, waiting, with its workers around it.
- **Rank is identity, not headcount.** The main session dwarf is always a `foreman`: it is the orchestrator whether or not it currently has agents out. Deriving the role from the in-flight count (the original behaviour) made the same dwarf change appearance mid-session, which read as a different dwarf arriving every time an agent started or finished. Only its `status` tracks the registry (busy → working, idle → waiting). Subagents are always workers. Codex is unaffected — its foreman promotion comes from a real `thread_spawn` parent link (§2.2), not from a count.
- All 3 files present corresponded to 3 alive `claude.exe` PIDs (verified with `Get-Process`) — stale files appear to be cleaned, but guard against PID reuse anyway: `procStart` is the Windows FILETIME of process start; compare with the process's real start time. **[V]**
- `updatedAt` is **not** a per-second heartbeat (was ~550s old on a busy session) — treat as "last state change", not liveness. **[V]**
- `messagingSocketPath` is a named pipe; pipe existence (`\\.\pipe\LOCAL\cc-msg-<hash>`) is a secondary liveness probe **[I]** (not tested).

Other candidates checked:

- `~/.claude/ide/` — **empty** here; only gets `<port>.lock` files when an IDE extension connects **[V empty / I semantics]**. Not usable for terminal sessions.
- `~/.claude/shell-snapshots/` — `snapshot-bash-<epochms>-<rand>.sh` written at session start; not reliably cleaned → weak signal, only tells you a session started around that time **[V]**.
- `~/.claude/tasks/<uuid>/` — contains `.lock`/`.highwatermark`; **stale** dirs from weeks ago persist → not a liveness signal **[V]**.
- `~/.claude/statsig` — does **not exist** in this version **[V]**.

#### `waitingFor` — the whole vocabulary, and what each value proves (issue #60)

A `waiting` session carries an optional `waitingFor` string naming what it is blocked on. It is the **only** structured "blocked on a human" evidence any provider on this machine writes, so #60's normalized waiting reason is derived from it and from nothing else.

The strings are not free text: Claude Code picks each from a fixed derivation. Read out of the shipped v2.1.251 binary on 2026-08-30 (the status/`waitingFor` producer and the dialog-kind table it consults), the closed set is **seven** values — the six below plus the absent case **[V]**:

| `waitingFor`        | Written when                                                                                         | Normalized to |
| ------------------- | ---------------------------------------------------------------------------------------------------- | ------------- |
| `input needed`      | an elicitation prompt is up, or the open dialog is an ask-the-user / teammate-setup / MCP-server one | `user-input`  |
| `permission prompt` | the open dialog's kind is not in Claude Code's own table — the fallback branch                       | `approval`    |
| `sandbox request`   | a sandboxed command is asking for network access                                                     | `approval`    |
| `goal proposal`     | Claude proposed a session goal and is waiting on accept/reject                                       | `approval`    |
| `worker request`    | a worker request is pending                                                                          | `unknown`     |
| `dialog open`       | any other dialog kind, or a slash-command view showing over an idle turn                             | `unknown`     |
| _(absent)_          | `waiting` with no condition recorded                                                                 | `unknown`     |

`dialog open` was the value observed live in this machine's registry while this was being read **[V]**, and it is by far the commonest — which is exactly why it is **not** `user-input`. It says a modal is up, never what the modal wants: the same string covers a startup model switch, a managed-settings review and an offline-file-sync notice. That the session is blocked is already carried by `status: "waiting"`; the normalized reason exists to say what it is blocked ON, and only `input needed` names a question a person has to answer.

Two things follow, and both are the point of the issue:

- **`unknown` is not `user-input`.** Only `user-input` suspends age-based eviction; every other value keeps the behaviour #34 and #40 already established. A vocabulary that has grown before will grow again, so an unrecognized string lands on `unknown` rather than being pattern-matched into meaning.
- **The condition outranks the status.** `parseClaudeSessionEntry` folds any status it does not recognize into `idle`, and `idle` is the single gate #40's staleness rule stands on. A future spelling of "blocked" would therefore turn a live session whose human has been asked a question into an evictable one. The eviction exemption keys on the recorded condition, which survives that fold.

**Subagents have none of this.** Checked across every `agent-*.meta.json` on this machine on 2026-08-30 — 256 files — the only keys that ever appear are `agentType`, `description`, `toolUseId`, `spawnDepth`, `model`, `parentAgentId` and `isFork` **[V]**. No status, no blocked condition, no completion. A worker therefore never carries a waiting reason, and inferring one from its foreman's registry entry would be a claim about a dwarf nobody measured.

- Transcript `.jsonl` mtime — good _activity_ fallback (the live file's mtime advanced during observation) and the only signal for `claude -p`/SDK runs that may not register in `sessions/` **[V mtime / I about -p]**.

### 1.6 Speech bubbles & thinking metadata

- Latest human-readable assistant text = last `type:"assistant"` line whose `message.content[]` contains a `{"type":"text"}` block (skip thinking-only and tool_use-only lines). **[V]**
- Thinking: `{"type":"thinking","thinking":"..."}` blocks; effort level in top-level `effort` on every assistant line; thinking token counts in `usage.output_tokens_details.thinking_tokens`. **[V]**
- Session title: `{"type":"ai-title","aiTitle":...,"sessionId":...}` lines; friendly name also in `sessions/<pid>.json` `.name` (e.g. `sample-project-70`). **[V keys]**

#### A `user` line is not where most user messages are (2026-09-03, issue #180)

The classic `{"type":"user","message":{"content":"<text>"}}` line only carries a message typed at a
**turn boundary**. Three other shapes carry text a person really sent, and the panel's history —
which is `extractClaudeFeed` — showed none of them, because the reader skipped every `isMeta` line
and every string content opening with `<`. Measured on one live transcript: its 256 KB tail held
**1** classic user text line and **0** of the messages that arrived mid-turn, which exist only in
the shapes below. **[V]**

**Typed while the assistant is mid-turn — three records, no user line at all:**

```
{"type":"queue-operation","operation":"enqueue","timestamp":"…","sessionId":"…","content":"<text>"}
{"type":"attachment","attachment":{"type":"queued_command","prompt":"<text>","commandMode":"prompt","origin":{"kind":"human"},"timestamp":"…"},…}
{"type":"queue-operation","operation":"remove","content":"<text>","reason":"absorbed_mid_turn",…}
```

Read the **attachment** and nothing else, or one message reaches the panel three times. The identical
record shape carries the harness's own queued prompts — a `<task-notification>` arrives as
`commandMode:"task-notification"` (§1.4) — so `origin.kind` is what separates them; `human` is this
session's own TUI, and the third shape below is the other kind that counts.

**Delivered through the relay tier (#24) — a meta user line wrapping Claude Code's own framing:**

```
Another Claude session sent a message:
<cross-session-message from="uds:…" from-name="<relay session name>" from-mode="bypass">
<text>
</cross-session-message>

This came from another Claude session — …
```

Only what sits inside the element was written by a person; the sentence before it and the note after
it are Claude Code's. Unwrap it, trimmed, and only from a line carrying no `toolUseResult`: tool
output can print a whole transcript, envelopes included, and a printed message is not a message —
the same rule §1.4 applies to endings.

**Relayed AND mid-turn — both at once, and the shape that outlived the first fix:** **[V]**

```json
{
  "type": "attachment",
  "attachment": {
    "type": "queued_command",
    "prompt": "<cross-session-message from=\"uds:…\" from-name=\"<name>\" from-mode=\"bypass\">\n<text>\n</cross-session-message>",
    "source_uuid": "…",
    "commandMode": "prompt",
    "origin": {
      "kind": "peer",
      "from": "uds:…",
      "msg_id": "…",
      "name": "<name>",
      "fromMode": "bypass",
      "body": "<text>"
    },
    "timestamp": "…"
  }
}
```

No `user` line is written for it either, so the first two rules both miss it: the record is an
attachment, and its origin is `peer` rather than `human`. Read `origin.body` — the message the
sending session put on the wire, quoted on its own — and fall back to unwrapping the envelope in
`prompt` with the same matcher, since the two say the same thing twice. Empty either way publishes
nothing.

So `origin.kind` is the whole gate, and exactly two of its values are somebody speaking: `human` and
`peer`. It is the kind that decides, never the shape of what the record carries — a harness record
holding an envelope, and even a `body`, is still the harness queueing text.

Two facts this deliberately does **not** fix: the receiving session still reads "Another Claude
session sent a message" from a session named after the relay's throwaway process, and the panel
still has no local echo, so a sent message appears only once the transcript records it. Both are
product decisions recorded in #180.

#### `message.content` is a string OR a block array, for the same prompt (2026-09-04, issue #216)

The classic line above spells its content as a string. The **same** prompt is also written as a
block array, and reading only the string dropped every one of those — invisibly, since nothing
logs a line it skipped.

```
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"<text>"}]},"timestamp":"…"}
```

Counted by shape over every transcript on this machine on 2026-09-04 — 519 files, 537 MiB,
35 870 `user` lines **[V]**:

| `message.content`                    | Lines   |
| ------------------------------------ | ------- |
| string                               | 1 746   |
| array, `text` blocks only            | **103** |
| array, `tool_result` blocks only     | 33 976  |
| array, `text` and `tool_result` both | **14**  |
| array, neither                       | 31      |

The 33 976 are tool output and must stay out; the 117 carrying text are prompts, of which 57 are
`isMeta` (the harness talking to the session in the newer shape) and the rest are somebody
speaking. Two facts make the rule safe rather than a guess: **no** array carrying text also
carried `toolUseResult`, and none of their joined text opened with a tag — so widening what counts
as content cannot reach the tool-output fork the string path leaves open, and both existing skips
still apply unchanged.

So read a string, or the joined `text` of a content array's `text` blocks — a block's own `text`
field and never a `tool_result`'s nested `content`, which can be a whole transcript. A mixed array
keeps its text blocks and drops the rest.

#### A feed asks for messages, so a byte window is the wrong bound (2026-09-04, issue #215)

Every feed this app builds asks for a **count** — "the latest 50 messages" per dwarf in the Mine
History panel, twelve in the message panel — and each used to get the last N messages of a fixed
256 KiB tail, with `feed.slice(-limit)` applied only afterwards. Two windows in series, the narrow
one first, and it is narrow in the currency the file is mostly made of: tool output. The 256 KB
figure above is the same measurement from the other side.

`readFeedWindow` (`src/main/providers/feedWindow.ts`) walks the window outwards instead: read
256 KiB, and only when that came up short of the count **and** the file filled it, read 2 MiB, then
8 MiB as the ceiling. Whether a window was filled is measured in **bytes** of the returned text,
never in string length — a tail read slices at a byte offset, so a multi-byte transcript's decoded
string is shorter than the window it filled, and comparing lengths stops the walk a step early.

Measured over the same 519-file corpus on 2026-09-04, comparing the fixed window with the walk
**[V]**. 369 of the files are over 256 KiB, 56 over 2 MiB, 8 over 8 MiB, largest 19.8 MiB:

| Asking for | Messages found, fixed 256 KiB | Messages found, walk | Time for one 64-transcript history open |
| ---------- | ----------------------------- | -------------------- | --------------------------------------- |
| 12         | 2 564                         | 3 541                | —                                       |
| 50         | 2 965                         | **6 642**            | 44 ms → **214 ms**                      |

So the panel's promise of fifty goes from being met on paper to being met in fact, for 170 ms on a
user action. Per transcript the walk costs p50 2.2 ms, p95 14.3 ms, max 24.1 ms at a limit of 50.

**None of this is on the poll.** The 2-second loop reads `TRANSCRIPT_TAIL_BYTES` in
`claudeProvider.snapshotSession` and does not call `feed()` at all; the two `feed()` call sites in
`runtime.ts` are both on-demand (`dwarfFeed` for the panel, and `activateDwarf`'s fallback).

#### Two flags say a `user` line is the harness writing down its own state (issue #188)

When Claude Code compacts, it writes a `user` line whose content is the whole multi-kilobyte
summary ("This session is being continued from a previous conversation…"), flagged
`isCompactSummary: true` and `isVisibleInTranscriptOnly: true`. Nobody typed it, and
`extractClaudeFeed` published it as a user turn. Two such lines exist in the corpus above, both
carrying both flags **[V]**.

Either flag on its own is enough to skip the line, and it is the **flag** that decides rather than
the content shape — so the block array of #216 is not a way back in. Note this is a claim about
lines Claude Code wrote for the transcript, not about `isMeta`, which is a different skip with a
different reason (§1.6 above).

Both providers read the same way as of issue #228: `ClaudeProvider.feed` and `CodexProvider.feed`
each walk this window, as `MineHistoryReader` already did for both. The gap this paragraph used to
record — Codex's live feed alone left on a fixed 256 KiB tail while the other two were widened —
is closed. What a rollout's own line shapes do to the walk, and what it measured on real rollouts,
are in §2.3.

---

## 2. Codex CLI

### 2.1 Paths & layout

- Transcripts ("rollouts"): `C:\Users\j\.codex\sessions\<YYYY>\<MM>\<DD>\rollout-<YYYY-MM-DD>T<hh-mm-ss>-<uuid-v7>.jsonl` **[V]**
- `C:\Users\j\.codex\history.jsonl` — user prompts: `{"session_id":"01a0...","ts":1787578797,"text":"..."}` **[V]**
- `C:\Users\j\.codex\session_index.jsonl` — `{"id":"<uuid>","thread_name":"...","updated_at":"..."}`; on this machine only Desktop/automation threads appeared → treat as partial index **[V content / I coverage]**
- `archived_sessions\`, `.codex-global-state.json` (Codex Desktop app state, ~1.1MB), `process_manager\chat_processes.json` (Desktop-spawned shell commands with `osPid`, `cwd`, `conversationId`, `turnId` — stale entries persist) **[V]**

### 2.2 Record schema

Every line: `{"timestamp":"ISO-8601","type":"...","payload":{...}}` **[V]**. Top-level `type`: `session_meta`, `turn_context`, `response_item`, `event_msg`, `world_state`, `inter_agent_communication_metadata`, `compacted` (context-compaction marker, seen once per rollout on a long session; the parser ignores unknown types, so this needs no special handling) **[V, added 2026-08-29 re-verification]**.

- **`session_meta`** (line 1): `payload = {id (session uuid), timestamp, cwd, originator, cli_version, source, model_provider, base_instructions, history_mode, context_window}`. Observed `originator`: `"codex-tui"` (CLI) and `"Codex Desktop"` **[V]**. **cwd lives here.** Field inventory re-confirmed against one real rollout head on 2026-09-03 (whole-machine, current build): the payload also carries `session_id`, `forked_from_id`, `parent_thread_id` (present directly on the payload for a spawned worker, not only nested under `source.subagent.thread_spawn` — see below), `thread_source`, `agent_nickname`, `agent_path`, `subagent_history_start_ordinal`, `multi_agent_version` **[V, keys only]**.
  - **cwd is not always a working directory — issue #166.** Verified live, same machine, same day: a `"Codex Desktop"` / `source:"vscode"` session that was never bound to an opened workspace folder wrote its OWN artifact-storage path as `cwd` — `<home>\Documents\Codex\<YYYY-MM-DD>\<slug>` (Codex's own per-conversation storage, one directory per date then a generated slug) — while a sibling rollout from the same window, for a session that WAS bound to a real folder, carried the real repository path in the same field. This is not a parsing bug: for the storage-path case, Codex itself records no other cwd anywhere in the rollout or in `state_5.sqlite.threads.cwd` (the same value is mirrored there). `src/main/providers/codex/parse.ts`'s `isCodexArtifactStorageCwd()` recognizes the shape and the provider drops such a session rather than laundering the storage path as a project. Windows-verified only; the macOS/Linux equivalent (if any) is unconfirmed. **[V]**
  - Spawned Codex workers observed locally use `source.subagent.thread_spawn = {parent_thread_id, agent_nickname, agent_role, agent_path, depth}` **[V schema]**. `parent_thread_id` is the only safe parent link: promote a session to foreman only while that worker and its referenced parent rollout are both live in the same scan. Do not infer a hierarchy from a shared cwd, process ancestry, or recency. Plain `source` values (`"cli"`/`"vscode"`) and non-`thread_spawn` subagent shapes carry no usable relationship. **[V]**
  - The plain tag answers two OTHER questions, and each takes only positive evidence. `"cli"` is the one value the message queue has been watched draining on (#97) — `"vscode"` is unproven, not disproven. `"exec"` is a headless `codex exec` run, whose whole life is one prompt and one turn: nobody can talk to it, whoever started it, which is what lets the panel refuse a message with the shape of the session instead of the generic "can't receive messages yet" (#231). Recorded in this repository since #217, **not** re-verified against a live registry row here — so a build spelling that tag otherwise simply leaves the field off, and the panel says what it said before. **[I, needs a live row]**
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
- **No blocked-on-a-human record of any kind** (issue #60). Every rollout on this machine was enumerated on 2026-08-30 — 140 files, ~393 MB — and the complete `event_msg` payload vocabulary is `item_completed`, `token_count`, `agent_message`, `agent_reasoning`, `task_started`, `task_complete`, `user_message`, `patch_apply_end`, `mcp_tool_call_end`, `thread_settings_applied`, `web_search_end`, `sub_agent_activity`, `context_compacted`, `turn_aborted`, `image_generation_end`, `thread_rolled_back`. Not one record or payload type in that corpus matches approval, elicitation, permission, awaiting or user-input **[V]**. `turn_context.payload.approval_policy` is a policy setting, not a pending request. So Codex writes no waiting reason at all and stays exactly as conservative as before: a Codex session at an approval prompt is indistinguishable on disk from one sitting quietly, and inventing the difference is the failure #60 exists to prevent.

**2026-08-29 re-verification against a real, actively-running Codex session on this machine** (this project, PID 32864 `codex.exe` alive since 14:23, confirmed via `Get-CimInstance Win32_Process`):

- **Bug found and fixed — tail-window busy detection**: a real rollout from this session showed a `task_started`→`task_complete` gap of **347,167 bytes** (one turn's tool output/reasoning). AgentName originally read only the last 256KiB (`TAIL_BYTES`) of the rollout to detect an open turn, so a genuinely in-progress turn whose `task_started` had already scrolled past that window looked idle — the main symptom reported ("no dwarfs appear with a live session"). Fixed by reading a larger, still-bounded tail (4 MiB, `BUSY_TAIL_BYTES` in `codexProvider.ts`) for busy detection specifically, keeping a smaller read for the click-to-focus feed — which walks
  the window instead of reading a fixed tail as of issue #228, see below. Reproduced and verified against a synthetic rollout built from this session's real `session_meta`/`turn_context` lines plus an oversized body (`src/main/providers/codex/codexProvider.integration.test.ts`).
- **Bug found and fixed — date-directory scan gap**: a rollout lives in its **START-date** directory for its whole lifetime, but the provider only scanned `today` and `yesterday`. A session opened more than a day ago and still active would never be found even with a fresh mtime. Fixed with a configurable `CODEX_SCAN_DAYS` (default 7) scanning today back N-1 days; mtime filtering keeps this cheap.
- **Bug found and fixed — idle-but-open session disappears entirely**: once a rollout's mtime exceeds `CODEX_LIVENESS_WINDOW_S` (300s default), the old code dropped it outright — even though Codex writes nothing to the rollout while its CLI is open but quiet (confirmed here: the same real session's rollout had not been touched in ~1h49m while its process was still alive). Fixed with `CODEX_IDLE_RETENTION_S` (default 3600s): a stale-but-recent rollout stays visible while a `codex`-named process is confirmed running (`isCodexProcessRunning()`, PowerShell `Get-CimInstance Win32_Process` matching name/cmdline). **Caveat observed live**: by the time this was checked, the same session's rollout was quiet for ~1h58m — past even the 3600s default retention — so it was (correctly) still excluded; a user whose Codex sessions sit idle for multiple hours between prompts should raise `CODEX_IDLE_RETENTION_S`.
- `dateSegments()` in `codexProvider.ts` uses local `Date` methods (`getFullYear`/`getMonth`/`getDate`), and real rollout directory names matched the local wall-clock date on this machine exactly — **no local/UTC mismatch found**; this was checked and is not a bug.
- Field names used by the parser (`session_meta.payload.id`/`session_id`/`cwd`, `turn_context.payload.model`/`effort`, `event_msg.payload.type` of `task_started`/`task_complete`) were re-confirmed byte-for-byte against this real, currently-relevant rollout — **no parser/format drift found**.

#### The feed read walks the window, and a rollout's line shapes make that safe (2026-09-04, issue #228)

`CodexProvider.feed` read a fixed 256 KiB tail (`FEED_TAIL_BYTES`) long after `readFeedWindow`
had replaced that same window on the Claude side and in the Mine History panel — the gap §1
recorded rather than quietly widening (#225). It now takes the same walk, and the constant is
gone: nothing else read it, and the poll's own window here is `BUSY_TAIL_BYTES` (4 MiB), which
`feed()` never shared. Claude's `TRANSCRIPT_TAIL_BYTES` survives for the opposite reason — there
the poll does read it.

Two things needed checking rather than assuming, because a rollout is not a transcript:

- **The stop condition reads correctly for a rollout.** The walk stops when a window comes back
  short of the bytes it asked for, which proves the read reached the start of the file. Rollout
  lines are long and a byte-offset tail routinely opens in the middle of one; `jsonlRecords` drops
  that fragment, so a narrow window does not show half a message — it loses the message. Both
  directions are pinned in `codexProvider.test.ts`: a rollout below the narrowest step is answered
  by one read and no escalation, and a user line the 256 KiB boundary cuts 40 bytes short comes
  back whole once the walk widens, where the narrow window answers with the reply alone.
- **Nothing moved onto the poll.** The 2-second loop calls `scan()` and nothing else;
  `provider.feed()` has exactly two call sites, both in `runtime.ts` and both on demand —
  `dwarfFeed` for the message panel, and `activateDwarf`'s fallback for a session whose window
  cannot be focused. The same two Claude has, so widening cost zero per poll.

Measured over every rollout on the machine this was written on, 2026-09-04 **[V]** — 174 files,
538.9 MiB, 142 over 256 KiB, 38 over 2 MiB, 11 over 8 MiB, largest 128.0 MiB:

| Asking for             | Messages found, fixed 256 KiB | Messages found, walk | Rollouts the walk improved | Rollouts answering nothing |
| ---------------------- | ----------------------------- | -------------------- | -------------------------- | -------------------------- |
| 12 (the message panel) | 578                           | **881**              | 68 of 174                  | 18 to 16                   |
| 50 (Mine History)      | 1 023                         | **1 778**            | 74 of 174                  | 18 to 16                   |

One feed open reads one rollout, so what a person waits for is the per-rollout figure: at a limit
of 12, p50 3.1 ms, p95 18.3 ms, max 24.9 ms (at 50: p50 2.9 ms, p95 19.1 ms, max 33.1 ms). Reading
the whole corpus goes from 210 ms to 863 ms, which nobody does — and the 16 rollouts still
answering nothing are sessions carrying no human-readable message anywhere in them, not a window
too narrow to find one.

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
| `waitingFor` is the six values of §1.5, plus absent                     | Verified (v2.1.251 binary's own derivation, 2026-08-30; `dialog open` also seen live)   |
| Subagents expose no status or blocked condition anywhere                | Verified (256 `agent-*.meta.json` on this machine, 2026-08-30; 7 distinct keys in all)  |
| Codex writes no approval / user-input record at all                     | Verified (140 rollouts / ~393 MB, 2026-08-30; complete event_msg vocabulary in §2.3)    |
| Codex rollout layout & record types                                     | Verified on 2 files (0.149.0 TUI + 0.150-alpha Desktop); function_call variant inferred |
| Codex liveness = mtime + task_started/complete + process                | Verified live 2026-08-29 (real codex.exe + a real 347KB task_started/task_complete gap) |
| Gemini CLI: nothing on disk here                                        | Verified absence                                                                        |
| Click-to-focus via PPID walk to terminal                                | Process data verified; focusing mechanics inferred                                      |
