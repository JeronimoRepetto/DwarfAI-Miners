# Hook-Based Session Detection — Evaluation (Issue #13)

> **Status: implemented (phase 1: Claude).** Phases 1 and 2 shipped in issue #14 —
> loopback listener, debounced nudge, idempotent Claude installer, tray opt-in. See
> `src/main/hooks/` and the "Instant updates (Claude hooks)" section of the README.
> Phase 3 (Codex) and Phase 4 (uninstall-time hook removal) remain open.
>
> Two decisions changed during implementation, both settled by measurement rather
> than by the reasoning below:
>
> - **Relay mechanism: option (a), `curl.exe`, not the compiled helper (b).** §3.3
>   recommended (b) as primary. The measured relay is a sub-millisecond loopback
>   round trip, which is far inside Phase 0's "well under 50 ms" exit criterion, so
>   the extra build step buys nothing. Presence of `curl.exe` is verified when the
>   toggle is enabled and refuses with an explanation if it is absent.
> - **Command shape: every argument is one whitespace-free, quote-free token.**
>   Claude Code parses a shell-form hook with `sh` on Unix but with Git Bash _or_
>   PowerShell on Windows, and a bare `@-` is a hard PowerShell parse error. `-d@-`
>   was verified to parse identically in all three, which is why the command looks
>   the way it does.

Push-based detection via provider hooks, evaluated against DwarfAI-Miners' current
polling architecture. Source: `ntd4996/agentpet` (MIT), read directly from its
`windows/` Tauri/Rust port (the closest analog to our own Windows/Electron app —
its macOS Swift core was consulted only for the parity matrix, not read line-by-line).

**Verdict: implement, narrow scope.** Add a loopback-HTTP push channel as a second,
optional event source layered on top of the existing 2-second poller — never a
replacement for it. Ship Claude-only first (Phase 1–2 below); Codex is a
straightforward fast-follow once the relay mechanism is proven (Phase 3). Do not
build agentpet's 12-provider hook catalog — `DwarfProvider` is `'claude' | 'codex'`
today (`src/shared/contracts.ts:79`) and stays that way.

---

## 1. agentpet's actual architecture (read from source, not the README)

Repo tree confirms two independent implementations: `Sources/AgentPetCore` +
`Sources/App` (native Swift/SwiftUI, macOS-only) and `windows/src-tauri/src`
(Rust, Tauri 2, Windows + Linux). The Windows one is what we compared against
line-by-line, since it targets the same platform we do.

### 1.1 Hook installation per provider

`windows/src-tauri/src/hooks.rs` keeps a static table (`fn spec(kind)`, lines
35–66) of one entry per agent: a config-file style enum (`ClaudeNested`,
`CursorFlat`, `WindsurfFlat`, `KiroFlat`, `AntigravityNested`, `OpencodePlugin`,
`PiExtension`), a relative config path, and the list of hook events to wire.
Claude Code's entry (lines 37–38):

```rust
"claude" => Spec { style: Style::ClaudeNested, rel_path: &[".claude", "settings.json"],
    events: &["SessionStart", "UserPromptSubmit", "PreToolUse", "Notification", "Stop", "SubagentStop", "SessionEnd"] },
```

Codex reuses the same nested shape into `~/.codex/hooks.json`, plus a **second**,
separate mutation: `enable_codex_hooks()` (lines 292–315) patches
`~/.codex/config.toml` to insert `[features]\nhooks = true` if it isn't already
there — checked idempotently by scanning existing lines for `hooks=true` before
writing. The catalog note for Codex (`lib.rs`/`hooks.rs` line 71) is explicit that
this alone is not enough: _"After enabling, run `/hooks` in Codex and Trust the
AgentPet hook"_ — Codex itself gates hook execution behind a one-time interactive
trust step inside the CLI that no installer can automate.

**Idempotency**, the part directly reusable regardless of language: entries are
identified by substring-matching the hook's own `command` string
(`fn is_ours`, line 103–106: `cmd.to_lowercase().contains("agentpet") &&
cmd.contains("hook")`), never by any other marker. `install()` (lines 180–219)
filters out any of _our own_ prior entries per event before appending a fresh
one (so re-running install replaces, never duplicates), and never touches an
entry that fails `is_ours`. `uninstall()` (lines 221–241) mirrors this: it
removes only matching entries, drops an event key once its array is empty, and
drops the whole `hooks` container key once every event is empty — so a clean
uninstall leaves the file exactly as if AgentPet had never been installed,
without disturbing any other tool's hooks in the same file.

### 1.2 Event push protocol

The issue's premise (and our own `ecosystem-research.md` §5) assumed a Unix
socket on macOS and a Windows named pipe as the natural port. **That is not
what agentpet's Windows build does.** Its own parity doc says so directly
(`windows/PARITY.md` line 9):

> Hook CLI → app (socket/HTTP) | unix socket | ✅ HTTP 127.0.0.1:47628

`windows/src-tauri/src/server.rs` runs a `tiny_http::Server::http(("127.0.0.1",
47628))` (line 126) on a background thread. The same compiled binary doubles as
the hook CLI (`windows/src-tauri/src/cli.rs`): `agentpet.exe hook --agent
<kind>` reads the agent's hook payload — JSON on stdin for most providers, or
explicit `--event/--session/--project` flags for the opencode plugin and the
generic `agentpet run --` wrapper — normalizes it into one `Payload` struct
(agent, event, session, project, message, tool, file, desc, transcript,
subagent, terminal info, timestamp) and POSTs it with a hand-rolled minimal
HTTP/1.1 request (`fn post`, lines 412–427), bounded by a 500 ms connect/write
timeout. The doc comment on `run_hook` (lines 1–9) states the contract plainly:
_"ALWAYS exits 0 so it never blocks an agent (Copilot PreToolUse is
fail-closed)."_

One deliberate exception: a whitelisted `PreToolUse` (opt-in via
`~/.agentpet/approval-gate.json`) uses `post_await` instead (lines 128–145),
blocking up to 12 s to relay the app's Allow/Deny back as Claude's
`permissionDecision` JSON on stdout — and even that falls back to `"ask"`
(the CLI's normal interactive prompt), never a silent allow or deny, on
timeout or if the app isn't running.

**Why this matters for us:** a fixed loopback TCP port needs zero
platform-specific server _or_ client code — the same hook `command` string
works on every OS a given provider's hooks run on. A named pipe would need
Windows-specific server code (`net.createServer({ path: '\\\\.\\pipe\\...' })`
in Node) _and_ a Windows-specific invocation from the hook command itself.
agentpet's own Windows engineers, building the exact port we're evaluating,
chose HTTP over a pipe. We should follow that precedent rather than the
issue's original "named pipe on Windows, Unix socket elsewhere" framing.

### 1.3 Startup-state recovery

There is no socket-level session or replay-from-daemon protocol. Recovery is a
**client-side on-disk queue**: `cli.rs::queue()` (lines 261–272) writes the
JSON payload to `%LOCALAPPDATA%/AgentPet/queue/<ts>-<pid>.json` whenever `post()`
fails (app not running). `server.rs::start()` (lines 108–123) drains that
directory in filename order (= chronological, since names are millisecond
timestamps) on the next launch, replaying each line through the same
`handle_event()` a live POST would use — the comment calls out _why_:
"replayed with their original timestamps so stale sessions prune instead of
resurrecting."

This is the load-bearing gap in agentpet's design, and it applies to any
hook-only architecture: **the queue only replays events that fired while the
app was down.** It gives agentpet zero information about a session that
started and produced no further hook events before the app relaunched (e.g.
the machine slept mid-turn). There is no independent reconciliation pass
anywhere in `lib.rs`/`server.rs` beyond that queue drain. Hooks are additive
to a ground truth, not a ground truth themselves.

### 1.4 State mapping and transcript enrichment

`windows/src-tauri/src/statemap.rs` is a pure `fn state(kind, event) ->
Option<&str>` lookup, generic states first (`working|waiting|done|registered|
idle`, lines 6–18), then per-provider event names. Claude's Stop always maps to
`"done"` (line 25) — but Claude's `Stop` fires identically whether the agent
really finished or just asked the user something, so `server.rs::handle_event`
(lines 200–259) resolves that ambiguity by reading the transcript tail
(`transcript::latest_assistant_text` + `looks_like_question`, a question-starter
/ trailing-`?` heuristic with an explicit allowlist of non-question closers like
"let me know if...") and corrects `done → waiting` **before** ever emitting the
event, on a spawned thread so the HTTP responder isn't blocked.

Two more details worth carrying over independent of the hooks-vs-polling
question:

- Token/cost accounting reuses the _same_ transcript file a hook event points
  at, via a byte-offset cache (`USAGE_OFFSETS`, keyed per path) so a hook only
  ever triggers a delta read of newly appended `usage` objects, never a
  full re-scan (`transcript.rs::new_usage_delta`, lines 60–110).
- Claude's inferred transcript path when a hook payload omits
  `transcript_path` (`transcript.rs::inferred_path`, lines 115–127) sanitizes
  the cwd by replacing path separators with `-` — the same convention our own
  `encodeClaudeProjectDir` (`src/main/providers/claude/parse.ts:90`) already
  implements. Confirms we're reading the same on-disk contract Claude Code
  itself publishes.

---

## 2. Mapping to our architecture

Our current pipeline (confirmed via CodeGraph, not assumed): `Poller.tick()`
(`src/main/runtime/poller.ts`) fires every `config.pollIntervalMs` — **2000 ms by
default** (`src/main/config/config.ts:82`) — calls `provider.scan()` on
`ClaudeProvider` and `CodexProvider` via `Promise.allSettled` (one provider
failing never kills the loop), aggregates into `Mine[]`, and pushes over the
`mines:update` IPC channel.

- `ClaudeProvider.scan()` walks `~/.claude/sessions/*.json` (+ any additional
  configured Claude roots — multiple accounts are supported) for
  `pid`/`status`, probes liveness with `process.kill(pid, 0)`, then tails up to
  256 KB of each session's transcript for model/effort/last-assistant-text/
  in-flight subagents (`parseClaudeTranscriptTail`). This already extracts
  **more** per-session detail than agentpet's hook payload ever carries (see
  §2.2) — we already read model _and_ effort; agentpet's normalized `Payload`
  struct has neither field.
- `CodexProvider` reads Codex's own SQLite registry (`state_5.sqlite` thread
  rows + spawn edges, `logs_2.sqlite` as a heartbeat source) plus a day-directory
  rollout walk (`codexScanDays`, default 7) with a cached process-liveness probe.
  This is richer than agentpet's Codex integration, which has no SQLite access
  at all and relies purely on Codex's `hooks.json`/`config.toml` event stream.

### 2.1 What hooks actually fix

Both latency pains named in the task are real and hooks solve them the same
way agentpet solves them:

1. **Status flip lag.** Today a working→waiting/done flip is visible up to
   `pollIntervalMs` (2 s) late, compounded by however long Claude Code's own
   registry write lags the real state change. A hook fires synchronously at
   the exact `Stop`/`SessionStart` moment — flip latency drops to one HTTP
   round-trip plus an in-process event, on the order of tens of milliseconds.
2. **Turn boundaries.** `PreToolUse`/`PostToolUse`/`Stop`/`SubagentStop` are
   exact, ordered signals for when a turn starts/ends. Our transcript-tail
   parsing has to infer this from JSONL content that may not have flushed to
   disk yet at poll time, and costs a fresh read (up to 256 KB) every 2 s per
   session regardless of whether anything changed.

### 2.2 What hooks do NOT solve

Checked directly against `cli.rs`'s `Payload` struct and `statemap.rs`'s
`state()` table — not assumed:

- **Model/effort detail.** agentpet's `Payload` carries `agent, event, session,
project, message, tool, file, desc, transcript, subagent, terminal_program,
terminal_focus_url, ts` — no model, no effort, anywhere. It relies entirely on
  the same transcript-tail read we already do. Hooks add nothing here; we would
  keep tailing transcripts for model+effort exactly as today.
- **Tokens/cost.** Same story: the hook payload carries no usage numbers.
  agentpet re-opens the transcript/rollout file after every hook event and
  diffs a byte offset — hooks only tell it _when_ to re-check, they don't
  replace the read.
- **Startup state.** Confirmed in §1.3: zero information about sessions that
  started and produced no further hook traffic before the app (or our
  listener) launched. The 2 s poller remains our only startup-reconciliation
  source, full stop.
- **cwd — partial exception.** Claude's and Codex's own native hook payloads
  _do_ carry `cwd`/`workspace_roots` (that's how agentpet's `cli.rs` extracts
  `project` at all), so this is one thing a hook event gives us essentially for
  free and slightly more reliably than inference — but it's a minor win, not a
  gap we currently have.

### 2.3 A finding agentpet's architecture forces, that ours doesn't need

agentpet has to run `looks_like_question` text-heuristics on the _transcript_
because its only signal for "did Claude finish or just ask something" is the
`Stop` hook, which is identical either way, and it has no access to Claude
Code's own live session registry. **We already have that registry.**
`ClaudeProvider.snapshotSession` sets `status: session.status === 'busy' ?
'working' : 'waiting'` straight from the registry's own `status` field
(`src/main/providers/claude/claudeProvider.ts:579`) — a field Claude Code
itself writes. If a hook only triggers us to re-read the session registry (as
proposed below), we get the done-vs-waiting distinction for free, with no
question-detection heuristic to port or maintain.

### 2.4 Proposed hybrid design

- Poller and both providers are untouched and remain the **zero-config default
  and sole startup-reconciliation source**. A user who never opts in sees no
  behavior change whatsoever.
- Add a loopback HTTP listener in the Electron **main** process (Node's
  built-in `node:http`, no new dependency — mirrors `tiny_http`'s own choice,
  see §1.2) on a fixed `127.0.0.1:<port>`.
- On any received event, do the simplest thing that captures the latency win:
  trigger an out-of-band `poller.tick()` immediately, **debounced/coalesced**
  (e.g. a 150–300 ms leading-edge window so a burst of `PreToolUse` events in
  one turn causes one rescan, not N). This reuses the existing, already-tested
  `scan()`/`aggregateMines()` path unchanged — no new "rescan just this
  session" API surface, no risk of a partial-state bug the full scan doesn't
  already guard against. A missed or malformed hook self-heals within one
  regular 2 s poll cycle regardless.
- Do **not** port `QuestionDetector`/`looks_like_question` (§2.3) — the
  registry's own `status` field already resolves it once we re-read it.

---

## 3. Hook installation UX

### 3.1 Where it lives

`src/main/shell/tray.ts` already has the exact right pattern for an opt-in toggle: a
`Menu.buildFromTemplate` checkbox item wired to `isAutostartEnabled()` /
`enableAutostart()` / `disableAutostart()`, re-labeled via `refreshTrayMenu()`
after every toggle (lines 24–52). A "Live hook detection (beta)" checkbox added
the same way is consistent, requires no new settings window (there isn't one —
`App.vue` is just the panel), and satisfies "opt-in from the tray, never
silently" directly.

### 3.2 What we'd write

- **Claude Code** → `~/.claude/settings.json`, nested-hooks shape, for each of
  `config.claudeConfigDirs` (plural — multiple Claude roots/accounts are
  supported; `src/main/config/config.ts:91`). Event set: mirror agentpet's minimal list minus
  the two we don't need per-tool-call granularity for — **`SessionStart`,
  `Notification`, `Stop`, `SubagentStop`, `SessionEnd`** for v1. Skip
  `PreToolUse`/`UserPromptSubmit` initially: they fire on every tool call, and
  the marginal latency win over a 2 s poll (§2.1 already covers turn
  boundaries via `Stop`) is small next to doubling hook-invocation frequency —
  revisit only if Phase 0 benchmarking (below) shows the relay is cheap enough
  to not matter.
- **Codex** → `~/.codex/hooks.json` (same nested shape) + patch
  `~/.codex/config.toml` to add `[features]\nhooks = true` if absent, exactly
  like `enable_codex_hooks()`. Must also surface, once, the same caveat
  agentpet documents: the user has to run `/hooks` inside Codex and press
  Trust — we cannot automate Codex's own consent gate, only prompt for it on
  first enable.
- **Idempotency**: adopt the same command-substring `is_ours` pattern (e.g.
  command contains `"dwarfai-miners"` and `"hook"`) so install/uninstall never
  touches a foreign hook entry and re-running install replaces our entry
  instead of duplicating it. This logic is language-agnostic and ports
  directly.
- **Default OFF**, always, matching the existing autostart toggle's UX and the
  task's explicit requirement.

### 3.3 Failure modes

- **Hook survives app uninstall.** agentpet does not solve this either —
  nothing in `windows/src-tauri` or its packaging manifests (`scoop`, `winget`)
  runs a hook-removal step on uninstall. Claude Code's own hook contract
  tolerates a command that fails to spawn (it logs/ignores), so a dangling
  entry pointing at a deleted exe is not catastrophic, but it is a real gap we
  should not silently inherit: our own future installer (NSIS/electron-builder)
  should run a `--uninstall-hooks` pass before removing files, and until that
  exists, the README should say "toggle hook detection off before
  uninstalling" — the same assumption agentpet's own docs implicitly make.
- **Hook slowing the provider.** Our relay command must be at least as fast as
  agentpet's "always exits 0, never blocks" contract. This is where our
  packaging differs materially from agentpet's, and is the single biggest
  open risk in this whole evaluation (see Phase 0 below): agentpet ships one
  small **native binary** that doubles as the hook CLI — invoking it costs a
  few milliseconds. We ship an Electron app; invoking our own packaged
  executable per hook event would cold-start a whole new Electron/Chromium
  process (roughly 1–2 s) unless the invoked path is a genuinely separate,
  tiny relay — not `electron.exe ourApp --hook`. Two options, neither requiring
  a new build toolchain for this workspace:
  - **(a) `curl.exe`-based one-liner.** Windows 10 1803+ ships `curl.exe` in
    `System32`; the hook `command` can be
    `curl.exe -s -X POST --data-binary @- http://127.0.0.1:<port>/event`
    reading the agent's stdin JSON directly. Zero build step, but adds an
    environment assumption (curl.exe present) that install-time should verify
    and warn about if missing.
  - **(b) A tiny compiled relay helper**, self-contained, whose only job is
    stdin → one HTTP POST → exit. This workspace already has precedent for
    exactly this kind of single-file native helper compiled with the
    machine's built-in `csc.exe` (a pattern proven in a sibling project's
    WinForms helper) — no new dependency, and it removes the curl.exe assumption
    entirely.
    Recommendation: (b) as the primary path (self-contained, no environment
    assumption), with (a) as a fast spike to validate the architecture before
    committing to a compiled helper.
- **Foreign hook coexistence.** Since Claude Code's `hooks` field is an array
  per event, an idempotent installer only ever touches its own entries — any
  hook already installed by another tool (agentpet itself, a user's own
  script) is left untouched, the same guarantee `group_is_ours`/`flat_is_ours`
  give agentpet.

---

## 4. Verdict and follow-up plan

**Implement, at Claude-first, debounced-full-rescan scope.** The two named
latency pains (status flip lag, turn boundaries) are real and directly
addressed; the two real gaps (model/effort, tokens, both already covered by
our existing transcript-tail reads) are correctly out of scope for hooks and
stay solved the way they are today. Startup state stays fully owned by the
existing poller — this is additive, never a replacement path, and ships with
zero behavior change for anyone who doesn't opt in.

The one substantive open risk is packaging-shaped, not protocol-shaped: our
Electron packaging makes "the hook command is a fast native process" nontrivial
in a way agentpet's single-binary architecture never had to solve, and Phase 0
exists specifically to close that before any installer code is written.

### Phases

**Phase 0 — Relay spike (0.5–1 day).** Build and benchmark both relay options
from §3.3 (curl.exe one-liner vs. a tiny csc.exe-compiled helper) against a
throwaway `node:http` listener. Exit criterion: relay completes in well under
50 ms so it is invisible inside a `Stop`/`Notification` hook. Decide the
mechanism before any installer code exists. No files beyond a scratch spike.

**Phase 1 — Loopback listener + debounced trigger (1–2 days).**

- `src/main/hooks/hookServer.ts`: `http.createServer` on `127.0.0.1:<port>`,
  parses `POST /event`, ignores malformed/unrecognized bodies, always responds
  200 (never blocks the caller).
- Wire into `src/main/runtime/runtime.ts`: on a received event, call a debounced
  `poller.tick()` (150–300 ms coalescing window).
- Tests: `hookServer.test.ts` — real ephemeral port, raw socket client (no new
  test dependency), covering malformed JSON, an unrecognized event, and burst
  coalescing (N events in the debounce window → one `tick()`).

**Phase 2 — Claude hook installer + tray toggle (1–2 days).**

- `src/main/hooks/hookInstaller.ts`: idempotent install/uninstall across
  every root in `config.claudeConfigDirs`, using the Phase-0 relay as the
  command string, events `SessionStart, Notification, Stop, SubagentStop,
SessionEnd`.
- `src/main/shell/tray.ts`: add a checkbox item next to "Start with Windows",
  default OFF, persisted via a small JSON flag under `app.getPath('userData')`
  (autostart persists at the OS level via `setLoginItemSettings`, which this
  toggle has no equivalent of — needs its own tiny store).
- Tests: installer idempotency suite reusing the existing `FsLike` fake
  pattern already used by `ClaudeProvider`/`CodexProvider` tests — fresh
  install (no `settings.json`), install alongside a foreign hook (preserved
  untouched), re-install (no duplicate entries), uninstall (only our entries
  removed, empty event arrays and the `hooks` key itself dropped when empty).

**Phase 3 — Codex hooks (1–2 days).** `~/.codex/hooks.json` + the
`config.toml` `[features]\nhooks = true` patch, same idempotent installer
shape as Phase 2. Surface the one-time "run `/hooks` and Trust it in Codex"
instruction on first enable (a tray submenu note or a one-shot notification —
we have no settings window to put it in yet). Same idempotency test suite,
retargeted at the TOML patcher.

**Phase 4 — Uninstall safety + docs (0.5–1 day).** Wire a `--uninstall-hooks`
pass into whatever installer/uninstaller mechanism we adopt later
(NSIS/electron-builder); until then, document "toggle hook detection off
before uninstalling" in the README as the interim safe path.

Total estimate: roughly 5–8 days across four phases, Phase 0 gating everything
after it.
