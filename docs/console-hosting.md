# Being the console — hosting agent sessions in the panel (issue #95)

> **Status: the recommendation is chosen and shipping.** Path 3 — drive each CLI's own programmatic
> interface — won. The detached launch engine merged in **#112**, the held-session engine carrying
> the ask-answer loop is open in **#113**, and the first structured way _into_ a Codex session merged
> in **#110** (#97). Path 1 (own a pty) was rejected and nothing of it was built; path 2 (Herdr)
> stays an unbuilt optional adjunct.
>
> Pinned to `afc302a`, read 2026-09-02. **This is the map, not the evidence** — the measurements live
> in the cited comments at full length and are pointed at rather than restated, deliberately, so this
> is the short document of the family. Markers: **[V]** verified live against a real install on the
> date given, probe output in the cited comment; **[#nn]** the issue holding the evidence; **[code]**
> read out of the tree at `afc302a`. Where this page and a comment disagree the comment sat closer to
> the measurement; where it and the code disagree, the code wins.

---

## 1. The question

**Can the panel start an agent session and be the place that session lives, with no terminal window
at all?** That was a different app from the one that existed: every provider read disk or SQLite,
nothing spawned an agent, and the one console channel _attached_ to a console the app does not own —
`AttachConsole` resolves the console **session** a pid belongs to, never a window that pid created
[code: `src/main/platform/focus.ts:137`]. #86 had proposed launching through `terminalLauncher.ts`,
which opens a real terminal window per OS, so #95 existed to settle the mechanism first.

| Path                                  | What the app becomes under it                                    | Verdict                       |
| ------------------------------------- | ---------------------------------------------------------------- | ----------------------------- |
| **1. Own a pty in Electron**          | a terminal emulator with a mine painted on it                    | **rejected**                  |
| **2. Herdr socket integration**       | a client of somebody else's session server                       | **optional adjunct, unbuilt** |
| **3. Per-CLI programmatic interface** | a host: it starts sessions and holds the structured conversation | **chosen, and shipping**      |
| **4. Stay an observer**               | what it already is — a panel that reports rather than hosts      | **kept, as honest fallback**  |

---

## 2. The four paths

### 1 — own a pty: rejected

**A pty binding is a native module, and this project has none.** `dependencies` at `afc302a` is
exactly `dotenv` and `vue`; no `postinstall`, no `electron-rebuild`, no `asarUnpack`, and
`build.files` is `["out/**/*", "package.json"]` [code: `package.json`]. It would also buy the release
workflow a per-platform build matrix it does not have (#16).

**Owning the bytes is not understanding them.** To know an agent is blocked you would parse rendered
ANSI output — the heuristic `WaitingReason` forbids at its definition: _"a question mark in a speech
bubble, a sentence that reads like a request, an agent that has simply gone quiet — none of them may
ever produce a value here"_ [code: `src/shared/contracts.ts:129`]. #60 closed by refusing exactly
this. So a pty re-implements, in this project's first native module, plumbing four vendor teams
already maintain, and still leaves blocked-detection to screen scraping.

### 2 — Herdr: measured, kept as an adjunct

Herdr is a Rust single binary that already owns agent terminals across claude, codex, cursor,
opencode and grok, its sessions surviving a lid close and a reboot. This repository has met it
before — #15 was a Herdr-hosted claude TUI breaking focus and tier-1 sends, and `herdr.exe` survives
in the Windows host list to this day [code: `src/main/platform/focus.ts:53`]. Measured locally,
**0.8.2, 2026-09-01** [V, #95]:

- `herdr status`: client 0.8.2, channel stable, **protocol 20**, server **not running**. The socket
  is at `~\AppData\Roaming\herdr\herdr.sock` — the documented `~/.config/herdr/…` is the POSIX path;
  on Windows it lives under Roaming, as **named pipes**.
- **`herdr api schema --json` works client-side with the server down** (exit 0). `schema_version: 1`,
  and the request schema enumerates **117 methods** — everything the public docs table plus eight
  they never mention, `agent.start` and `integration.install` among them. `AgentStatus` is confirmed
  as `idle | working | blocked | done | unknown`. So an integration must treat **"installed but
  server down" as a normal state**, and can validate the schema offline before touching the socket.
- **The provenance caveat, which is why this is an adjunct rather than the launch path.**
  `agent.explain` returns a "matched rule" with a "manifest source and version", there is a
  `pane.output_matched` event, and `pane.read`'s `detection` source is documented as the
  "bottom-buffer snapshot used by agent screen detection". That reads as **screen scraping against a
  rule manifest** — what #60 refused. Consuming another tool's structured API is not writing the
  heuristic ourselves, so it is not disqualifying, but it **bounds how far the signal may be
  trusted**, and the API returns no question text or options in its state payloads.

So: a strictly additive enrichment for sessions the panel did not launch, never the mechanism by
which one starts — that would add a runtime dependency the vendors' own interfaces make
unnecessary. None of it is built.

### 3 — each CLI's own programmatic interface: the winner

The deciding fact: **every provider this project cares about now ships its own host interface.**
Probed read-only, 2026-09-01, against what is installed here [V, #95]:

| Provider                                 | Programmatic surface                                                                                                                                                   | Structured approvals                                    |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **Claude** — strongest                   | **[V] 2.1.257**: `--print` with `--input-format`/`--output-format stream-json`, `-r/--resume <id>`, `-c/--continue`, `--permission-mode`, `--allowedTools`             | Agent SDK `canUseTool` — **[V] proven end to end**, §3  |
| **Codex** — strong                       | **[V] 0.151.0**: `exec --json`, `--output-schema`, `exec resume` by id, **`queue --thread <uuid> --message`**, `app-server` (JSON-RPC 2.0)                             | app-server, reviewer `user` → server-initiated requests |
| **opencode** — strong on paper, unproven | client-server _by design_: `opencode serve` is a headless HTTP server with an OpenAPI spec and an official TS SDK; the TUI is a client. **Docs only — not installed.** | unestablished                                           |
| **Gemini** — **weakest**                 | headless mode (`-p`, or any non-TTY invocation) with `--output-format json`. **Docs only — not installed.**                                                            | coarse only (`--yolo` / non-interactive denial)         |

Two corrections that matter more than they look. **`--permission-prompt-tool` does not appear in
2.1.257's `--help`** [V, #95] — earlier research had leaned on that flag, so the approval surface
moves and must be re-verified before anything is built on it. And **`codex app-server daemon`
lifecycle is unsupported on Windows** [V, #97]: had Codex's message channel required the daemon, the
panel's primary host OS would have been structurally excluded. It does not. No terminal window
appears anywhere on this path.

### 4 — stay an observer: kept, and not the failure case

Keep the terminal launch and accept that the panel reports rather than hosts. Still live, and still
right for one case: a session that must survive the panel **mid-turn** runs in a terminal (or in
Herdr) and the panel observes it, which the app already does well. Its cost is exactly one thing —
it can never render an open question with real buttons (§4).

---

## 3. What the verdict became

### The detached engine — merged, #112

`src/main/sessionLaunch/` — its own subject, because starting a session is the opposite act to
`textDelivery/`, which only ever writes into one that already runs. One headless `claude -p` turn,
no terminal window [#86].

- The binary comes from #91's detector, never a second constructed path. **`cwd` is the mine's
  folder**, which is the whole trick: aggregation groups by `cwd`, so the dwarf appears in the mine
  it was launched from with **no second observation path**.
- **Detached, `unref`'d, `windowsHide`, stdout/stderr ignored**, stdin closed straight after the
  prompt is written [code: `src/main/sessionLaunch/launchRunner.ts:56-89`] — so the session outlives
  the panel. **The prompt travels on stdin, never argv**, which any other process on this machine can
  read; `-p/--print` documents itself as "useful for pipes" and its positional prompt is optional, so
  a `claude -p` with none reads it from stdin [V, #86].
- The verdict says a process **started** and refuses to say more; the poll finds the session up to
  2000 ms later, so the panel must acknowledge on the verdict alone.

### The held session — open, #113

A detached launch hands the session over and lets go; a **held** session runs inside the Agent SDK's
`query()` with `canUseTool`, and its child dies with the panel. That is the whole trade, and it buys
exactly one thing: **an agent's `AskUserQuestion` arrives live and structured, and an answer from the
panel reaches the agent.** Both modes belong, so the wire says so — `agent:launchHeld` is its own
channel beside the detached `agent:launch`, not a replacement.

- **The proof** is #94's third phase-5 experiment, 2026-09-02, `@anthropic-ai/claude-agent-sdk`
  0.3.258 against CLI 2.1.258 [V, #94]: at t+4.7s the `AskUserQuestion` `tool_use` arrived **live and
  fully structured** at `canUseTool` — question, header, `multiSelect`, every option with label _and_
  description, plus `toolUseID`, `agentID`, `requestId`; the host answered programmatically; the
  `tool_result` came back not-an-error; at t+6.1s the assistant confirmed the choice.
- **The answer contract**, learned through three schema-validation errors and then the SDK's own
  types: `answers` is `Record<question TEXT, option LABEL>` — **keyed by the question text, not the
  header**, confirmed against `sdk-tools.d.ts` where the sibling `annotations` field documents the
  keying as _"Keyed by question text"_ [V, #94].
- **Nothing in that record is free text** — an answer can only repeat the agent's own words back —
  and **the redacted spellings map back**: the panel is only ever shown the redacted question and
  labels (#59), which the agent's own tool would not recognise, so the match runs against the
  redacted forms and **what is sent is the original**, two questions redacting alike refusing rather
  than guessing [#113].
- Three rules #113 states at length and this page only names: **an open ask dissolves** rather than
  being answered for the user; **the permission posture starts at a refusal**, since there is no
  surface to show a prompt on yet (#96); and a held session **registers exactly like any other**, so
  the poll draws its dwarf with no second path — as `kind: "interactive"`, earning the long
  _attended_ window, right rather than a leak since a human genuinely can answer it here (#68).

### The Codex queue — merged, #110 (#97)

The smallest win path 3 promised, and it took a live experiment to earn: the documentation could not
establish which session kinds `codex queue` reaches, and three pieces of local evidence pointed the
wrong way [#97]. Measured on a fresh `source=cli` TUI session, Windows, Codex 0.151.0, 2026-09-02
[V, #97] — the command exited 0, a row appeared in `queued_items` within 2s, **the row was gone by
t+6-8s**, and the message had rendered in the TUI, which replied to it. **A plain TUI session drains
its own queue with no app-server daemon involved**, so the Windows daemon gap does not block this
channel. The shipped rule is two facts off the registry row a scan already reads, and no third [code:
`src/main/providers/codex/queue.ts:31`, `:74`; `codexProvider.ts:469`]:

```
canQueueToCodexThread = sourceTag === 'cli' && cliVersion >= 0.149.0
```

The floor is **per thread**, not per machine: a session an older Codex opened is honestly unreachable
even where the installed CLI is new enough. Everything else stays `null` — `vscode`-source threads,
sub-agent threads, a rollout with no registry row — because absent beats guessed (#10). It
**delivers but does not kick**, a queued interrupt arriving precisely when the turn it meant to cut
short had already ended. And a queued item is `delivered`, never `reacted`: the 6-8s drain latency is
exactly what the ✓ → ✓✓ gap already expresses.

### What #86 became

#86 asked for a launcher built on `terminalLauncher.ts`. **That mechanism is not what shipped.** It
became "start a session through the provider's own programmatic interface, in the mine's `cwd`", in
two cuts (#112 detached, #113 held); the terminal-window chain stays only as the activation fallback
it already was. Everything else in #86 survived — `cwd` as the mine's path, boundary validation in
main, immediate acknowledgement against the poll, the #78 constraint past Claude and Codex, and a
launched session being a foreman by construction.

---

## 4. The channel matrix for questions

Every row measured — #94's three phase-5 experiments, 2026-09-02 [V, #94]:

| Channel                                  | Question form                                                        | Available while open? | Answer path                                       |
| ---------------------------------------- | -------------------------------------------------------------------- | --------------------- | ------------------------------------------------- |
| `AskUserQuestion` in an **observed TUI** | structured — but written to the transcript at **resolve**, backdated | **no**                | keystrokes at that TUI only → **notify and jump** |
| **Cross-session message bus**            | **prose**, options embedded as text                                  | yes, instantly        | prose reply; the peer's human may interpose       |
| **SDK-held session** (panel-launched)    | structured `tool_use`, streams live                                  | yes                   | **full structured loop**, ~6s round trip          |

- **Row one revised an assumption three earlier phases were built on.** A menu left open ~5.5
  minutes, transcript scanned twice: **zero `AskUserQuestion` blocks while it was open**; the block
  appeared only after the answer, timestamped at its original creation time. So a pending question
  read from the transcript tail is **post-hoc** — history, not an open menu — and buttons for an
  observed TUI are unachievable from anything this app reads. The backdating is a small gift, though:
  asked-at versus answered-at come free.
- **Row two's finding was unplanned.** Asked by an unverifiable external session to answer outside
  its user-visible channel, the peer session **stopped and asked its own human for consent first**,
  via `AskUserQuestion`. So a message-question may have a human interposed on the far side: reply
  latency is unbounded, and that is correct rather than a timeout to tune. **Consent belongs to the
  human, data belongs to the bus** — and prose questions are **displayed, never parsed into
  buttons**, because extracting options from prose is the heuristic this repo has refused three
  times.
- **Row three is why #113 exists.** Bare `claude -p --output-format stream-json` with no SDK **did
  not invoke `AskUserQuestion` at all** — the model asked in prose and the turn ended. The tool fires
  when a client capable of answering is attached, so structured buttons are exclusive to panel-held
  sessions.

---

## 5. Session lifetime, per mode

| Mode                            | Survives the panel quitting                        | Loses                                         |
| ------------------------------- | -------------------------------------------------- | --------------------------------------------- |
| **Detached launch**             | yes — the child is detached and `unref`'d          | nothing the panel was responsible for         |
| **Held (SDK) session**          | the **persisted** session does; the child does not | the **in-flight turn**; resumable by id after |
| **Observed (terminal / Herdr)** | yes, including mid-turn                            | nothing — but no structured question channel  |

Claude and Codex sessions persist to disk and resume by id [V, #95], so a panel restart costs nothing
already written. Both models are supported; neither had to win.

---

## 6. Open edges

- **`vscode`-source Codex sessions are unproven, not disproven.** Nobody has watched a Desktop-app
  thread drain its queue; it stays `null` until someone runs the same ten minutes against one [#97].
  Mid-turn drain is untested too, which is why the queue carries no cancel. And an npm-global `codex`
  is a `.cmd` shim the queue **refuses to run** — a shim needs a shell, and a shell re-parses the
  payload — so those users must set `CODEX_CLI_PATH`. A real reach limitation.
- **Gemini and opencode are unestablished.** Neither is installed here, so both rows in §2's table
  are documentation only. opencode's `serve` + SDK looks strongest of the four on paper and has never
  been touched; Gemini's headless approvals are coarse and may never support a structured loop.
  Either one hits #78's four places and its evidence bar.
- **The SDK's version lockstep is operational, not a detail.** SDK 0.3.258 was proven against CLI
  2.1.258 and the two must match; the SDK's own bundled binary failed to launch from pnpm's deep
  store path on Windows, and `pathToClaudeCodeExecutable` pointing at the system binary fixed it
  [V, #94]. The lockstep makes drift visible instead of silent — and it means a dependency that
  moves weekly, whose supply-chain age is young by design rather than by accident.
- **The 208 MB packaging exclusion is still pending, and it is the one open edge that reaches a
  user.** With the SDK, `pnpm install` pulls ~231 MB of production dependency, **208.4 MB of it
  `claude.exe`** inside the optional platform package `@anthropic-ai/claude-agent-sdk-win32-x64`.
  electron-builder copies production dependencies, so on today's `files` list that binary would ship
  — **unused**, because every session the panel starts passes `pathToClaudeCodeExecutable` and drives
  the CLI the user already installed and logged into. Excluding it needs a real installer build to
  verify, so #113 left it to whoever cuts the next release rather than changing it blind [#113].
- **A multi-question ask is answerable only for its first question**, and a multi-select answer sends
  exactly one label — how a picker joins several is unmeasured, and inventing a separator is how an
  agent comes to read an answer nobody gave [#113]. **And the buttons do not exist yet:** the wire
  field is filled live and the IPC channel takes the click, but nothing renders either — #90/#105,
  with the approval surface at #96.

**No test file is touched by this document**, and none should be: it records decisions already pinned
by tests in #110, #112 and #113.
