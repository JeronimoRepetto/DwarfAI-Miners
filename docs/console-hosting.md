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
- **The panel hands over to the dwarf anyway** [#191]. Acknowledging on the verdict used to be as
  far as it went: the Add Panel recognises its own launch by evidence rather than by timing, the
  only evidence was a **held** conversation seeded with the prompt, and a detached session carries
  none — so Add > Codex stopped at "the session started" while its dwarf appeared, replied and left
  again. The third source is the session's own transcript, whose **first human turn is the prompt
  the launch wrote to stdin**. Main runs that match itself, at the head of the file, **once** per
  candidate and off the poll [code: `src/main/providers/firstPrompt.ts`,
  `src/main/sessionLaunch/launchReceipts.ts`], and publishes only its verdict as `Dwarf.launchId` —
  the id of the LAUNCH, never of a dwarf, so the verdict still claims nothing. Both strings stay in
  main, which is why the comparison is exact: the panel's own copy of the prompt is raw and
  everything the panel is shown is redacted (#59), so a match made in the renderer would fail for
  any prompt that looks like key material. The receipt admits a **leaving** dwarf, unlike the
  in-memory kill register above, because a session that finished before the poll drew it is exactly
  the handover this fixes — the panel opens on the ended state with the reply already in it.
- **Detached is console-less, and that is not the same as quiet** [#208]. `detached` becomes
  DETACHED_PROCESS, which makes libuv's `windowsHide` (CREATE_NO_WINDOW) ignored, so the child gets
  no console at all. Fine for a program that is itself the console program. Not fine for the
  `node <entry>` shape #193 resolves a shim to: that interpreter spawns the real CLI, and Windows
  gives a console program whose parent has no console a fresh **visible** one — the black window
  #208 reported. A JS entry is therefore spawned through a `node -e` intermediary that re-spawns it
  **not** detached but **with** `windowsHide`, so it gets an invisible console of its own to pass
  down; the intermediary must then stay alive, because libuv's job object is what keeps its child
  alive. `buildLaunchSpawn` carries the measurements.
- **Letting go is not the same as having no exit** [#217]. Detached still means detached — the
  session outlives the panel, and quitting the tray still ends nothing — but the launcher now hands
  back the **pid it spawned** and the notice of that process ending, and the runtime keeps both
  [code: `src/main/sessionLaunch/launchedSessions.ts`]. So a launched session can be ended **on
  purpose**, which is what a Kick on one now does: it ends the process TREE, not the turn, and the
  panel says which of those two it did. Ending the tree is the per-OS half — a forced
  `taskkill` tree kill on Windows, a `kill -TERM` process-group signal elsewhere — so it sits
  behind `platform/processEnd.ts` like every other per-OS act. Measured live on Windows 11 / Node
  v24.11.1 against a rebuilt copy of this exact shape: intermediary, program and grandchild all
  gone, `taskkill` naming each one, and the retained handle's own `exit` observed firing. (The
  same run showed a plain `TerminateProcess` on the intermediary taking the tree with it as well,
  through libuv's KILL_ON_JOB_CLOSE cascade — but only while every link spawns through libuv, and
  the CLI's own tool processes do not, which is why the tree kill is what ships.) One honest
  limit: the launch is bound to the first session root of that provider to appear in that mine —
  a session already on the board is never claimed, because ending somebody else's process is the
  one mistake this must not make.
- **The exit survives a restart, and a bare pid is never what carries it** [#231]. The register
  used to be in memory only, so a session launched by a **previous** run had no exit at all. It is
  now written to the app's own database as well [code:
  `src/main/sessionLaunch/launchedSessionStore.ts`, schema v4] — and never as a pid, because a pid
  is recycled and this app owns a `taskkill /T` that would take an unrelated process's whole tree
  with it. What is written is the pid **and the creation time of that exact process**, read from
  the machine while the panel still held the handle, through the same `processProbe` port the
  Claude provider's own pid-reuse guard uses (#45). On the next run the machine is asked again and
  the row is believed only if the answer matches: a different instant means the number belongs to
  something else now, and **no answer at all is read the same way** — deliberately the opposite of
  the Claude guard, where an unknown leaves a dwarf on the board and the worst case is a stale
  dwarf, while here an unknown would end a process tree and the worst case is somebody else's.
  Either answer deletes the row. A launch whose creation time nothing would report is not written
  down in the first place. A restored launch has no exit handle, so the same pair is proved once
  more at the moment Kick would signal, not only at startup.
- **A verdict of `launched: true` used to be the last word this app ever spoke about a launch, and
  that was a lie whenever the CLI declined** [#263]. `runLaunchProcess` resolved on the `spawn`
  event alone — stderr discarded (`stdio: ['pipe', 'ignore', 'ignore']`), the exit code never read
  — so a `codex exec` that started and died at once (a concurrent instance already holding its
  lock, a flag it does not recognise, an auth prompt with nothing attached to answer it) read
  exactly like a session that was running fine, and the Add Panel's `started-detached` phase took
  precedence over every other state with no timeout and no way back to the composer. Diagnosed
  read-only against `main` at `47b79fe`, 2026-09-07, and split from the receipt-claiming defect
  found alongside it (also #263, merged separately as the collision-free slice): that one was about
  the WRONG session being claimed, this one is about no failure ever surfacing at all.

  The fix is a second retained-handle subscription beside the pid-reuse guard's own `onExit`
  [code: `src/main/sessionLaunch/launchedSessions.ts`'s `LaunchedProcess.onEarlyFailure`, optional so
  no existing caller or test fixture has to grow one]. stderr is now piped
  (`stdio: ['pipe', 'ignore', 'pipe']`) and kept as a bounded 4 KiB tail [code:
  `launchRunner.ts`'s `EarlyFailureWatch`/`TailBuffer`], and a child that exits within
  `EARLY_FAILURE_WINDOW_MS` (3s — generous past the near-instant refusal case, and short enough
  that an ordinary session's own turn essentially never finishes inside it) with anything other
  than a clean `0` latches a `LaunchFailure` the runtime reads once it has issued the launch's
  receipt (`launchReceipts.issue`'s id — never the pid-tracking registry's own `launch:N`, which
  the failure has no reason to know). `AgentRuntime.reportLaunchFailure` redacts and caps the
  stderr tail (`redactSecrets`, then `truncate` to 400 chars) and pushes `LaunchFailedPush` over a
  new one-way channel, `agent:launchFailed`, on the same `messagePanelChanged`/`dwarfDeliveryReported`
  pattern — main learns of this asynchronously, well after `agent:launch` already answered, so
  there is nothing to poll for. The runtime's own log line gains a second statement, `failed (exit
N)`, off the retained handle's late notice rather than folded into the original `started`/`failed`
  line, which is logged the moment `launchAgent` returns and cannot yet know this.

  On the renderer side, `launchState.ts` gains `launchFailed` — guarded by the SAME receipt id
  `started-detached` is already waiting on, and by `launchedDwarfId` still being null, so a stale
  push for a closed or retried launch is silently ignored and a push arriving after the dwarf was
  already proved cannot un-happen a session that plainly did start. It sets `error` to the CLI's own
  stderr tail when there is one, or `"<provider> exited [with code N] before it started."` when
  there is not, and drops `detached` back to false with the typed prompt untouched, so `launchPhase`
  reads straight back to `prompt-ready` and a retry costs one Enter — the AddPanel needed no change
  at all, because its `error` alert already renders regardless of which phase produced it. A second,
  independent way back: `detachedTimedOut` fires from a 60s timer `useAgentLaunch.submit()` starts
  alongside a receipted launch (60s being comfortably past both the 3s failure window and the
  ordinary one-or-two-poll receipt path), for the case where neither a receipt nor a failure ever
  arrives at all — a hung CLI, a stalled poll — with a fixed neutral sentence rather than main's own
  words, since main said nothing.

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
  being answered for the user; **a permission prompt parks exactly like an ask and reaches the panel**
  as `Dwarf.pendingPermission`, decided through `agent:answerPermission` — a prompt still open when the
  session ends dissolves as a denial, never an approval (#203); and a held session **registers exactly
  like any other**, so the poll draws its dwarf with no second path — as `kind: "interactive"`, earning
  the long _attended_ window, right rather than a leak since a human genuinely can answer it here (#68).
- **The launch itself gained three knobs, #239.** Both `agent:launch` and `agent:launchHeld` may now
  name a model and an effort, checked at the boundary (`parseLaunchTuning`, closed per provider for
  effort, a trimmed non-empty string for model) before either reaches the engine. Detached Claude gets
  `--model`/`--effort` in its argv — **`--effort` is real, `claude --help` on 2.1.263 documents it**
  [V, 2026-09-07] — and detached Codex gets `-m`/`-c model_reasoning_effort=<level>`, since its CLI
  names no effort flag of its own. A held session forwards both into `query()`'s options, and gains a
  third: `permissionMode`, closed against `HELD_PERMISSION_MODES` (the SDK's own `PermissionMode` minus
  `'bypassPermissions'`, still refused for the reason this page's §2 already argues at `sdkHeldSession.ts`).
  A model list travels the other way, live: `agent:models` beside `agent:providers` answers, per
  provider, what it can start on — Claude's over a short-lived `query()` that exists only long enough
  for `supportedModels()` to answer and is never sent a turn; Codex's from the same SQLite registry
  row §3's Codex queue table already reads (`threads.model`/`reasoning_effort`), labelled as history
  rather than the CLI's own word, because `codex --help` names no live model-list command; Antigravity's
  stayed empty (`source: 'none'`) even once it gained a launch path — see the next bullet.
- **A detached, one-shot Antigravity launch shipped in #237's step 4, and its argv was corrected in a
  same-day hotfix (#237).** `buildAntigravityLaunchArgs` is `--input-format text`. The original argv also
  carried `-p`, on the unverified assumption that a bare `-p` reads its prompt from stdin; that
  assumption was wrong — `-p` TAKES A VALUE on this CLI, so pairing it with `--input-format` made every
  detached launch exit 2 before ever reading stdin. Measured live against Antigravity CLI 1.1.26,
  2026-09-07: `agy -p --input-format stream-json` exits 2 with `-p took "--input-format" as its prompt`,
  and a trailing bare `-p` exits 2 with `flag needs an argument: -p`. `--input-format text` alone enables
  print mode and is passed explicitly rather than left to the documented default, the same reason
  Claude's and Codex's own argv name their defaults rather than relying on them. No `--output-format` is
  passed: this app never reads the launched process's stdout (`stdio` is `['pipe', 'ignore', 'ignore']`,
  same as every other detached launch). Detached is no longer the only mode: `HELDABLE_PROVIDERS`
  gained the name too, once step 5 proved a round trip through the CLI's documented bidirectional
  `stream-json` protocol — see the held bullet below. This argv stays the DETACHED one, and the two
  are not variants of each other. The launched session is discovered the same way a detached
  Codex one is: its own transcript records the prompt as its first `USER_INPUT` step, and
  `AntigravityProvider.firstPrompt` now reads it — envelope stripped, off the same
  `extractAntigravityFeed` the live feed already uses — so the Add Panel's receipt registry
  (`LaunchReceiptRegistry`) can prove which dwarf on the board its launch became, exactly as it already
  does for Claude and Codex. `agy help models`/`agy models --help` document a `models` subcommand
  ("List available models"), but this slice's own instructions authorized only read-only `--help`
  probing and ruled out starting a conversation, so the live subcommand was never invoked to see what
  it actually returns; `antigravityModelCatalog()` is therefore left unchanged, still `source: 'none'`.

- **The fifth slice landed in #282: Antigravity joins the model and effort pickers with a live
  list.** `agy models` was run for real this time (read-only — it lists models, it does not open a
  conversation), captured verbatim on CLI 1.1.26, 2026-09-07: a status line with no tab, then one
  `<id>\t<display name>` line per model, fourteen of them on this machine — `gemini-3.8-flash-high`,
  `claude-sonnet-4-6`, `gpt-oss-120b-medium` among them, the CLI's own public vendor names. The
  sanitized capture is `src/main/providers/__fixtures__/antigravity/models.txt`; the parser is
  `providers/antigravity/models.ts`'s `parseAgyModelsOutput`, which reads the tab as the field
  separator (so the leading status line falls out for free, with no string it prints ever matched
  literally) and answers null — never a hard-coded list, and never a half-parse taken as the whole
  truth — for anything that does not look like this format at all. `createAntigravityModelCatalog`
  turns that null, and a spawn failure, into the same one rejection `listAgentModels` already knows
  how to catch from Claude's own port: bounded by the same `MODEL_CATALOG_TIMEOUT_MS` race, degraded
  to `unavailableAntigravityModelCatalog()` behind one warn line on either failure. `agy --help` also
  documents `--effort` (`low|medium|high`) as a top-level flag, its own three — not Claude's five or
  Codex's six — so `PROVIDER_EFFORT_LEVELS.antigravity` stopped being `[]` and
  `buildAntigravityLaunchArgs` gained the same `tuning` parameter Claude's and Codex's builders
  already had, dispatched through `buildLaunchArgs` exactly like the other two. No renderer change:
  the Add Panel's model and effort rows already draw from whatever `listAgentModels` answers, one
  provider at a time, and antigravity's `source: 'provider'` slots in beside Claude's.
- **A HELD Antigravity session shipped in #237's step 5, and `HELDABLE_PROVIDERS` has two names now.**
  `antigravityHeldSession.ts` is the second implementation of `HeldSessionPort`, over
  `agy --input-format stream-json --output-format stream-json` on a child process's stdin and stdout —
  no library, no SDK. A live two-turn round trip was held on this machine against CLI 1.1.26 on
  2026-09-07, which is the condition `HELDABLE_PROVIDERS`' own comment had set for admitting the name;
  the sanitized stdout is committed as a fixture and `docs/provider-formats.md` §3.1.9 records every
  event shape and the four measurements that decide how a reply is read (the argv correction is
  the bullet above, found by this same probe).
  What matters for THIS page is what the two engines turned out not to share. The port stopped being the
  Agent SDK's shape: `HeldSessionHandle.interrupt` and `.contextUsage` are **optional**, because
  Antigravity's documented input side carries user text events and nothing else — no cancel event, no
  question answer, no permission answer. Absent rather than a method returning `false`, and the
  distinction is the point: `false` says "it was tried and refused", absence says "this session type has
  no such act", and the panel owes a person different sentences for the two. So a held Antigravity dwarf
  takes messages on the strongest send channel this app has and its Kick is disabled with its own
  reason, carried to the capability matrix by `TextDeliveryTarget.interruptible` so the bar and the
  runtime's kick routing read the one rule (the discipline `kickEndpointOf` already held for the Codex
  queue). It also cost the observer one narrow seam: a stream-json conversation writes no
  `history.jsonl` record at all, so `AntigravityProvider` now asks the held registry which folder a
  conversation it holds was started in — first-hand, and the store's own record still wins where one
  exists.

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

| Channel                                      | Question form                                                        | Available while open?           | Answer path                                                        |
| -------------------------------------------- | -------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------ |
| `AskUserQuestion` in an **observed TUI**     | structured — but written to the transcript at **resolve**, backdated | **no**                          | keystrokes at that TUI only → **notify and jump**                  |
| **Cross-session message bus**                | **prose**, options embedded as text                                  | yes, instantly                  | prose reply; the peer's human may interpose                        |
| **SDK-held session** (panel-launched)        | structured `tool_use`, streams live                                  | yes                             | **full structured loop**, ~6s round trip                           |
| **Permission prompt** in an **observed TUI** | structured — the `tool_use` is written BEFORE the dialog opens       | **yes**, and so is what it asks | keystrokes at that TUI → **answered from the panel, built (#203)** |

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
- **Row four is the one that turned out to be answerable, and the only one (#203).** It differs from
  row one on the single axis that decides everything: the assistant's `tool_use` block reaches the
  transcript BEFORE the CLI draws its dialog, where an `AskUserQuestion` reaches it only on resolve.
  So while the dialog stands, that call sits in the tail with no `tool_result` — and a
  `permission_prompt` Notification, Claude Code's own word that a dialog is open for that
  `session_id`, says the rest. Neither half names a request alone; together they do, and nothing is
  read out of prose. Where more than one call is open at once — a parallel batch, whose results are
  all written in one message — the panel refuses to name any of them and falls back to the mark and
  the console jump, because a card naming a sibling is how somebody approves a command they did not
  read.

  **The keys, measured [V] on Claude Code 2.1.261, Windows console, 2026-09-05.** The dialog is a
  **selector**, not the `Confirmation` context the keybindings reference documents — a lone `y` does
  nothing. A **digit picks that option and fires it immediately**, no Enter; **Esc cancels the
  prompt**. The option list varies by tool: two options in places, three for a file write, four for
  a Bash `rm` (`1` Yes, `2` Yes-and-always-allow, `3` Yes-and-switch-to-auto-mode, `4` No). **Yes is
  always first and No is always last**, which is why **Allow is `1`** and **Deny is `Esc`** rather
  than a digit — the panel cannot count rows in a dialog it does not draw, and a positional key
  would eventually press "always allow" for somebody who pressed the button that refuses. The panel
  offers only those two for the same reason: "always allow" and "auto mode" exist only in that
  terminal, and nothing the panel sends outlives the prompt.

  **A late keystroke.** The runtime rescans and re-matches the open call immediately before pressing
  anything, because a key presses whatever dialog is actually up. Past that, a late `1` is one stray
  character in the session's idle input and a late `Esc` interrupts the running turn — accepted, and
  said out loud in the panel's status line under a deny. Row one stays unbuilt, and unbuildable from
  anything this app reads.

### 4c. The AskUserQuestion picker's own keys — measured 2026-09-10 (#362)

Row one above is about whether the panel can SEE an observed ask; this is the separate question of
what it could press if it did, and the answer turned out to be the same shape as a permission
dialog. Measured [V] by the maintainer on **Claude Code 2.1.267, Windows Terminal**, over three
rounds — the first two are recorded because each was WRONG in a way that would have shipped a
miscounted keypress, and re-deriving either produces the wrong sequence.

| Round | What was measured                                     | What it found                                                                                                                                                                               |
| ----- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | one call carrying two questions, a single and a multi | a digit selects; **Enter does not submit a multi-select** — it toggles the row the cursor is on. Numbering follows the order the agent gave the options                                     |
| 2     | the same call, hunting the submit gesture             | below the options and below the Other row sits a **Submit row with no digit**, reached by arrow-down; then a **summary**, and a further Enter accepts it                                    |
| 3     | **one question per call** — the round that settled it | a single-select fires on its digit ALONE, with no confirmation; a multi-select's digits toggle without moving the cursor, and **Right arrow** shows the summary with **Enter** accepting it |

Round 3's isolation is what made the sequences deterministic. `End` does nothing, and `PageDown`
jumps to the **Other** row and waits for free text — so neither is a route to Submit, and an Enter
landing there would open a composer nobody asked for. Right arrow is equivalent to arrowing down to
the Submit row, without the count that made round 2's reading fragile: one miscounted press lands
Enter on the Other row or on an option it would toggle.

| Question form                   | Keystroke sequence                                      |
| ------------------------------- | ------------------------------------------------------- |
| single-select, option _n_       | `n`                                                     |
| multi-select, options _a, b, …_ | `a`, `b`, … (ascending), then `{RIGHT}`, then `{ENTER}` |

Both are built as pure SendKeys builders beside the graceful exit's (`sendKeys.ts`), from digits
resolved by `questionKeys.ts`, and sent under the discipline row four's keys already hold: the
kick's delivery route, the console-input capability, the board re-read and the ask re-matched
immediately before the press, and never on a shared terminal window. Two things stay refused rather
than guessed. A call carrying **more than one question** is refused with its reason, because only
its first question reaches the wire — answering that one walks the picker on to a question the
panel does not know exists. And **Other** is left inert, because a free-text answer is a payload
the panel would be putting in the person's mouth; the composer already carries free text as a
message.

**Known hazard, inherited rather than introduced.** This route lands its keys wherever the
foreground is, so it carries #371 whole: a Windows Terminal window with several tabs can be focused
as a whole, and until #371 lands a digit aimed at one session's picker can reach another tab's. The
shared-window refusal catches it wherever the focus check can tell.

**Still to observe.** A late `{RIGHT}{ENTER}` at an idle prompt — expected to be a no-op followed
by an empty submit, on the same reasoning that made a late `1` one harmless character.

---

## 4b. The delivery channel matrix, and which tier each act takes

§4 is about **questions**. This one is about **text going the other way**, and it is the table #308
reordered and #319 reordered back. Two acts, two orders, one target: a `terminal` target that also
carries a registry `sessionName` is one session with two answers, and `resolveTextDelivery` /
`resolveKickDelivery` give them separately [code: `src/main/textDelivery/resolve.ts`].

| Target                             | Message (`sendDwarfText`)                        | Kick (`kickDwarf`)                             | Touches a window? |
| ---------------------------------- | ------------------------------------------------ | ---------------------------------------------- | ----------------- |
| `terminal` **with** a session name | `terminal` (paste), relay only if it can't focus | **ends the verified pid** (#329), relay behind | message only      |
| `terminal` **without** one         | `terminal` (paste) — the only channel it has     | **ends the verified pid**, nothing behind it   | message only      |
| `claude-relay`                     | `claude-relay`                                   | `claude-relay` (a semantic ask)                | no                |
| `codex-queue`                      | `codex-queue`                                    | refused — drains between turns (#97)           | no                |
| `held-session`                     | the stream this panel holds                      | a real interrupt, where the protocol has one   | no                |
| `hosted-stdin`                     | the pipe this panel holds                        | ends the process (#194)                        | no                |
| `launched-process`                 | refused — no inbox (#217)                        | ends the process                               | no                |

The message column assumes a platform that can write into a console, which is Windows alone: where
`supportsConsoleInput` is false the first two rows' MESSAGE degrades to the relay (or to no channel,
without a name) and the kick does not — see #366 below, and `degradedForSend` in `resolve.ts`.

**Row one is #319, and it reverses #308 back to #24's order — but not #24's mechanism.** #24 made
the console the primary for the honest reason that keystrokes are instant where a relay turn is a
whole `claude -p` run. #308 reversed it because that console tier **typed** the message character by
character into the **focused** window — a 441-char message took ~16 s [V, #308, 2026-09-09] and a
person who clicked away mid-typing had the rest of their sentence written into **that** application.
#319 keeps the console primary but changes HOW it writes: the message goes on the clipboard, the
window comes forward, **Ctrl+V pastes the whole thing at once**, then the clipboard is restored. A
441-char message then lands in well under a second, so the window in which a focus change could steal
the text nearly disappears — and it arrives as the person's own prompt rather than labelled as
another session, which a relayed message cannot be. So the defect #308 named was the per-character
typing, not the console itself; paste answers it without giving up the console.

**The fallback is one-directional and conditional, and it reversed with the order.** A console paste
whose window would not come forward pasted nothing, so it may fall back to the relay — that is
`TextDeliveryOutcome.neverStarted`. A paste that RAN and reported failure may already have landed —
Ctrl+V can put the clipboard into the window before the command's non-zero exit — so it does **not**
fall back, because a second delivery over the relay would put the message into the session twice.
`neverStarted` is that distinction, carried rather than inferred from the error string, and it reads
the same in both directions the tiers have ever run.

**A focus that succeeded is not proof the session's window is in front — #329.** The focus step
resolves one of two things (§6): a console window the session is on, or, when the ancestor walk had
to reach one, a named terminal **host**. A host draws several sessions in tabs of one window and
exposes no way to select a tab by pid, so foregrounding it raises whichever tab the person last
used. Every keystroke tier read a plain `true` from focus as "this session's console is in front",
and for a host that is false. Measured live, 2026-09-09: two Claude sessions in two tabs of one
Windows Terminal window — same `WindowsTerminal.exe` host pid for both — and an Esc aimed at one
foreman interrupted the other, which logged `[Request interrupted by user]` and stopped its turn
[V, #329]. So `focusSessionConsole` reports WHICH window it reached
[code: `src/main/platform/focus.ts`], and `pasteToConsole`, `sendToConsole` and `sendInterrupt` all
refuse a host-level focus with `neverStarted` rather than pressing a key. An **ancestor's** console
is not a host and is not refused: in a classic `cmd.exe` console the shell and the session share one
window and nothing else is drawn on it (#190), which is the session's own window in every sense a
keystroke cares about. Click-to-focus still accepts both — somebody who clicked to see the terminal
is served by either.

**Kick's tier never moved; what it DOES changed with #329.** It stayed at the console through #308
and #319 on the reasoning that an interrupt is a keystroke by nature and carries no user text that
could land in the wrong window — the missing half being that the keystroke itself lands in the wrong
window, and cancels a stranger's turn when it does. So the terminal tier **ends the session's
process tree** now, through the same `ProcessEndPort` a launched session's exit uses [#217]: no
focus step, no window, and nothing another tab can notice. The terminal tab stays open at its shell
prompt. `taskkill /T` walks DOWN from the pid the provider reported, so the session's own tool
processes go with it while the shell, the terminal host and every other tab above it are untouched —
ending an ancestor would end all of them, which is why the pid is passed straight through with no
ancestor walk anywhere on the path.

**A pid is never signalled unverified, and the check runs inside the act.** #231's rule — a pid is
acted on only with its creation time verified — reaches this tier too, and reaches it twice. The
Claude provider already probes each `(pid, procStart)` pair for its pid-reuse guard [#45]; the
verdict is now on the wire as `Dwarf.pidStartedAt`, present **only** where the probe AGREED, and the
runtime refuses to ask for an end at all when it is absent. Then `endConsoleSession` re-probes the
pid immediately before `taskkill` and compares against that value with the same 2s tolerance
[`sameProcessStart`], because the provider's verification happened at the last poll and a poll can
be two seconds old.

**This is the one guard in the app that fails closed**, and the asymmetry is deliberate. The
liveness guard treats an unreadable process list as "alive", because a wrong "dead" only hides a
dwarf. A kill treats it as a refusal, because `taskkill /T` on a recycled pid ends a stranger's
program and everything under it, and no verdict afterwards can take that back. Mismatch and unknown
are therefore the same answer here: nothing is ended, and the panel says the process could not be
verified.

Three more consequences worth stating. The dwarf is **retired** on a delivered end (#46's path, not
#293's dismissal: a dismissal lifts on a `'working'` status, which is exactly what a session kicked
mid-turn was last reported as), so the walk starts at once instead of waiting out the provider's
liveness window. A refused end — including a refused verification — still **falls back to the relay
cancel instruction** where the session has a registry name: weaker than what was asked for, and
still better than nothing tried. And a port with no end tier at all says so
(`NO_TERMINAL_END_TIER`), rather than having the relay quietly substituted for the act.

**Kick means the same thing on all three platforms — #366.** Until then it did not. On macOS and
Linux the button fell through to the relay, a `claude -p` turn that _asks_ the agent to stop and
leaves the decision to it: a request rather than a stop, costing a model turn and declinable. Two
acts behind one label. The cause was one line of routing: a `terminal` target was degraded to its
relay address wherever `supportsConsoleInput` was false, and that degrade reached both acts.
**Console input and an end tier are different capabilities.** A message needs the window server; an
end needs a pid, which every platform can signal. So the degrade moved to the send route
(`degradedForSend` in `resolve.ts`) and the kick route keeps the console.

The POSIX act is **strictly simpler than the Windows one**, which is why it was worth doing rather
than declaring symmetric. Windows had to imitate a clean exit with keystrokes (#358), and a
keystroke drags in a focus step, the shared-tab refusal (#329) and the whole mouse-mode repair.
**SIGTERM is catchable**: the signal itself gives the CLI its own exit path, so it resets the
terminal modes on the way out with no window focused and no key synthesized. The escalation behind
it is SIGKILL after the same bounded grace, and the two constants are shared with the Windows tier
(`endSession.ts`) so the two ports cannot drift into refusing in different words.

The signal is aimed at the **pid, not the group** — `kill -TERM <pid>`, never `-<pid>`. The negative
form the launched tier uses (#217) is right for a process this panel started detached, which is a
group leader whose children inherit its group; an observed session is one process inside the
terminal's own group and the panel started none of it, so a negative pid there addresses a group we
never created. `processEnd.ts` holds both builders and the comment saying why they differ.

### To measure on a real Mac — the POSIX kick's one unverified input

**Undated because it has not been taken; noted 2026-09-10.** The act above is unit-tested per
platform, but the fail-closed guard's INPUT is not measured on POSIX, and that decides whether the
tier is reachable at all today.

`EndSessionRequest.expectedStartMs` comes from `Dwarf.pidStartedAt`, which `claudeProvider` sets
**only** where the session registry's `procStart` agreed with a live probe — and §1.5 records
`procStart` as a Windows **FILETIME**, read through `filetimeToEpochMs`. What to look for, on a real
macOS or Linux machine with an interactive `claude` session running:

1. `~/.claude/sessions/<pid>.json` — does it exist at all, and does it carry a `procStart` key?
2. If it does: what UNIT is it in? A FILETIME is a ~18-digit count of 100ns ticks since 1601;
   epoch milliseconds is ~13 digits. `filetimeToEpochMs` rejects anything that converts outside
   2000–2200, so an epoch-ms value there answers `null` rather than a wrong instant.
3. Is `pidDomain` still `win32:<host>`-shaped, or does it name the platform? That field is the
   registry's own hint that pid identity is namespaced per OS.
4. Does the value agree with the platform's own probe — `ps -o lstart=` on macOS,
   `/proc/<pid>/stat` field 22 plus `/proc/stat`'s `btime` on Linux — inside the 2s tolerance?

**If it carries nothing comparable, the verdict is `'unknown'`, `pidStartedAt` is absent, and the
runtime refuses the kick before the port is ever called** (`PID_UNVERIFIED`). That is the correct
failure and the tier simply stays unreached until this is measured. Do **not** weaken the guard to
make it reachable: signalling a pid nothing verified is how an unrelated process gets killed (#231),
and the refusal is visible to the person with its reason. Record the finding in
`docs/provider-formats.md` §1.5 either way — a negative is what tells the next person to solve pid
identity differently there (a `/proc` read of the CLI's own start time, say) rather than to re-try
this.

**The permission digits still type.** A decision is answered at the terminal drawing the dialog, so
it reads the kick's old route rather than the message's — `sendToConsole` for the measured `1`,
`sendInterrupt` for the `Esc` — because a paste of that digit into a live selector is unverified and
#319 changed only the message. Those two are the last keystroke callers left, and they inherit the
shared-window refusal above rather than escaping it: a dialog can only be answered at the window
drawing it, so where the panel cannot tell which tab that is, it says so instead of pressing.

**A per-OS paste is a follow-up, not built here.** The console-paste tier is Windows-verified only.
macOS and Linux keep the relay for a message exactly as they did (`supportsConsoleInput` is false, so
a named terminal degrades to the relay before it ever reaches the paste path); an osascript paste on
macOS or an `xdotool`/`wtype` paste on Linux is a separate issue, noted in `platform-ports`. A
Settings switch between the visible paste and the invisible relay is likewise deferred to whoever
owns the Settings surface.

### What is not measured yet

Step 2 of #308 still asks for these numbers and they are **not in this document yet**. They now
measure the RELAY as the fallback rather than the default, and the per-character typing timings §4b
and #308 recorded are superseded by paste — a paste is one keystroke, not one per character, so the
~16 s figure no longer describes the primary path. Listed as columns so the gap is visible rather
than filled with plausible ones:

| Quantity                                                     | Value                | How it will be taken                                            |
| ------------------------------------------------------------ | -------------------- | --------------------------------------------------------------- |
| Wall-clock latency of one relay turn                         | **not yet measured** | the `relay=` stage already in every `[runtime] Message to` line |
| Token cost of one relay turn                                 | **not yet measured** | the relay session's own usage, at `SENDTEXT_RELAY_MODEL`        |
| When a queued message is read — target mid-turn              | **not yet measured** | send during a long tool call, watch the transcript              |
| When a queued message is read — target at its prompt         | **not yet measured** | send to an idle session, watch the transcript                   |
| Whether `REACTION_WINDOW_MS` (60 s) covers the read boundary | **not yet measured** | follows from the two rows above                                 |

#21's earlier estimate of 5–20 s for a relay turn is an **estimate**, taken from the issue text and
not from this app's own stage timings; it is why the first row says not measured rather than
repeating it as a finding.

---

## 5. Session lifetime, per mode

| Mode                            | Survives the panel quitting                        | Loses                                         |
| ------------------------------- | -------------------------------------------------- | --------------------------------------------- |
| **Detached launch**             | yes — the child is detached and `unref`'d          | nothing the panel was responsible for         |
| **Held (SDK) session**          | the **persisted** session does; the child does not | the **in-flight turn**; resumable by id after |
| **Observed (terminal / Herdr)** | yes, including mid-turn                            | nothing — but no structured question channel  |

Surviving the quit is not the same as being beyond reach. A detached launch can be ended
deliberately from the panel — Kick ends its process tree — because the pid it started is retained
[#217]. Quitting still ends nothing, which is the point of detaching in the first place; what
changed is that "the app cannot stop what it started" stopped being true.

It stayed true across a restart for longer, and for a reason worth keeping in view: signalling a
remembered number is how an unrelated process gets killed. What re-opened that exit was not
remembering the number harder but remembering something a recycled pid cannot forge — the
**creation time** of that exact process, checked against the machine again before the row is
believed and again before anything is signalled [#231]. Where the machine will not answer, the
panel says so rather than guessing.

Claude and Codex sessions persist to disk and resume by id [V, #95], so a panel restart costs nothing
already written. Both models are supported; neither had to win.

---

## 6. The terminal handoff, when the panel is not the host

> **Since #319 a message to a session with a console takes this path again** — see §4b: it brings
> the window forward and PASTES, the relay behind it only when the window will not come forward.
> (#308 had routed a named session's message over the relay instead; #319 reversed that.) The focus
> mechanics below govern that paste, the permission keystrokes of #203, and a message to a session
> with no name at all. **They no longer govern Kick** — since #329 it ends the session's process and
> asks for no window at all (see §4b).

Path 4 keeps one act the other three never need: bringing **somebody else's** terminal window to the
front before typing into it. Three things about that are counter-intuitive enough to have cost an
issue each — two of them #190's three rounds, the third #329 — and none is legible in the code that
does it [code: `src/main/platform/focus.ts`].

**Windows refuses the foreground to a process that has not earned it.** `SetForegroundWindow` is
granted to a process that already owns the foreground or received the last input event; this app has
no window of its own and drives the call from a freshly spawned `powershell.exe`, so it is neither.
The documented mitigation is `AttachThreadInput` — borrow the input state of the thread owning the
current foreground window for the duration of the call — and **the thread id it needs is
`GetWindowThreadProcessId`'s return value; the out parameter is the _process_ id.** Reading those
two the wrong way round is not a type error in PowerShell and fails as a plain `False`, which is how
the mitigation sat in the tree unexecuted from #182 until #190 measured it. Measured live,
2026-09-04: out parameter 39872 (explorer's pid) against a return value of 31976 (its foreground
thread); attaching returned `False` for the first and `True` for the second [V, #190]. The attach
also makes the **read-back** meaningful — without it `GetForegroundWindow()` called immediately
after the switch returned `0`, the switch still in flight, three times out of three [V, #190].

**A console window a probe finds may not be a window anyone can see.** Windows 11's default-terminal
handoff puts a `cmd.exe` session inside Windows Terminal, and `AttachConsole` + `GetConsoleWindow`
then resolves a ConPTY **`PseudoConsoleWindow` phantom** rather than the terminal — measured live on
one session, handle 133320 class `PseudoConsoleWindow` owned by `cmd.exe`, against handle 133266
class `CASCADIA_HOSTING_WINDOW_CLASS` owned by `WindowsTerminal.exe` [V, #190]. `IsWindowVisible`
reports the phantom **true**, so #182's visibility guard does not filter it, and the handoff leaves
`WT_SESSION` unset, so that does not either. Foregrounding the phantom nevertheless works: Windows
raises the window that **owns** it. So the foreground afterwards is the terminal, not the handle that
was asked for, and verification accepts `GetAncestor(GA_ROOTOWNER)` of the target as well as the
target itself — it returns the handle unchanged when nothing owns it, so an ordinary window verifies
as before. It also insists the window is **visible**, because text delivery types into whatever holds
the foreground and a phantom raised alone would take the keystrokes somewhere nobody is looking.

**A window that came forward may not be the window the session is in.** The third fact, and the one
that cost #329. Resolution ends on either a console window or a named terminal **host**, and only
the first is provably the session's: a host window is a tab strip, `WindowsTerminal.exe` exposes no
way to raise a tab by pid, and the tab in front is whatever the person last used. Two sessions in
two tabs of one window therefore resolve to the SAME target — the same host pid for both — so a
keystroke sent after the focus reaches one of them at random [V, #329, see §4b]. This is a limit of
the terminal rather than of this code: nothing here can select a tab, so the honest answer is not to
type. Which of the two was reached is now reported rather than collapsed into a boolean, and every
keystroke tier refuses the host case; click-to-focus still takes it, because raising the terminal is
all it promised.

Neither fact is reachable from a unit test: both live in what user32 does, not in what the generated
PowerShell says. #190 closed once on pure builders and reopened. A change here is measured live
against a real hosted session, and the measurement goes in the issue. The third is testable, because
it is a fact about which of two shapes resolution ended on rather than about what user32 then did —
`resolveFocusTarget` and `focusSessionConsole` are unit-tested over a fake shell runner for both.

---

## 7. Open edges

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
