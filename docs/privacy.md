# Privacy and data boundary

DwarfAI-Miners is a local desktop app. Almost everything it does happens on your machine: it reads
the local files Claude Code, Codex, Antigravity and OpenCode already write, renders them in a
floating panel, and keeps a handful of small files of its own. The one exception is Jev, an
optional launch assist that calls out to TypeSafe's API — off unless you turn it on, and covered
in full in [What it transmits](#what-it-transmits). This document states exactly what is read,
what is stored, and what is transmitted. Every claim names the source that implements it, so it
can be checked rather than trusted.

## What it reads

- **Claude Code session registries.** Every configured Claude root (default `~/.claude`, plus
  any further roots configured via `CLAUDE_CONFIG_DIRS`) is scanned for
  `sessions/*.json` entries — small per-session files carrying the pid, session id, project
  directory, and status. An entry counts as alive only while its pid exists, and it is dropped
  when the running process's real start time contradicts the one the entry recorded, so a
  recycled pid is caught wherever that start time can be read. Where it cannot be — no start
  time in the entry, or a probe that fails — the pid check stands alone
  (`src/main/providers/claude/claudeProvider.ts`).
- **Claude transcripts, tail only.** For live sessions the provider tail-reads the session's
  transcript `.jsonl`, and each running subagent's own
  `projects/<dir>/<sessionId>/subagents/agent-<id>.jsonl` — a bounded number of bytes from the
  end, never the whole file — to derive status, the last message, and the activity feed
  (`src/main/providers/claude/claudeProvider.ts`).
- **Codex rollouts and registries.** The Codex sessions root (default `~/.codex/sessions`,
  overridable with `CODEX_SESSIONS_ROOT`) is scanned for recent rollout `.jsonl` files, with
  bounded head and tail reads. When present, Codex's own SQLite databases
  (`~/.codex/state_5.sqlite` and `~/.codex/logs_2.sqlite`) are opened **read-only** for
  thread relationships and liveness heartbeats (`src/main/providers/codex/codexProvider.ts`,
  `src/main/adapters/sqliteLike.ts`).
- **Antigravity's own store.** The `agy` CLI's directory (default `~/.gemini/antigravity-cli`,
  overridable with `ANTIGRAVITY_STORE_ROOT`) is read for three things: the presence lock the CLI
  writes per running conversation, `history.jsonl` for which workspace a conversation belongs to,
  and the conversation's `transcript.jsonl` for the feed and for whether a turn is still open
  (`src/main/providers/antigravity/antigravityProvider.ts`, `discovery.ts`, `parse.ts`). Read-only,
  bounded, and in place.
- **`opencode.db`, read-only.** The OpenCode CLI's SQLite store (default
  `~/.local/share/opencode`, overridable with `OPENCODE_STORE_ROOT`) is opened **read-only** for
  session rows, an event log used only for liveness, and message/part rows for the feed — the
  same read-only seam Codex's own databases go through. No other file under that store is ever
  listed or read (`src/main/providers/opencode/opencodeProvider.ts`, `state.ts`,
  `src/main/adapters/sqliteLike.ts`).
- **Project directories: names, sizes, and the first 4 KB of every source file counted.** To
  pick a mine's tier, the tier service walks the project directory and adds up the byte size
  of the source files it finds — a bounded, capped walk that skips `node_modules`, `.git`,
  `dist`, `out`, `.venv`, `target`, `release`, and `build`. It also reads the first 4 KB of
  each file it counts and hashes that sample, so a file copied into several places is counted
  once instead of inflating the tier. Neither the sample nor its hash outlives the walk: both
  are held in memory for that one walk, and nothing about them is stored, displayed, or sent
  (`src/main/tier/tierService.ts`).
- **Process lists, and process start times.** Liveness probes ask the operating system whether
  a pid is alive, when that process started, and whether a `codex` process is running —
  PowerShell `Get-CimInstance Win32_Process` on Windows, `pgrep -f` and `ps -o lstart=`
  elsewhere (`src/main/platform/processProbe.ts`).
- **Two small git files, to tell a worktree from its project.** To fold every git worktree of a
  repository into its main working tree's mine, a session's `cwd` is walked upward for a `.git`
  entry; where that entry is a file (a worktree checkout, never a main one) its `gitdir:` pointer
  is read, then the `commondir` file beside the directory it names, and — once a worktree is
  confirmed — the `HEAD` file, for the branch it has checked out. Each read is capped at 4 KB, no
  `git` binary is ever run, and a folder that is not a worktree costs one stat and nothing more
  (`src/main/projects/worktree.ts`).

- **Files you attach to a message, and only those.** Attaching a file — by dropping it on the
  composer or through the picker — lets the app measure it (its size, and whether it is a folder),
  and, for an image inside the size limit, decode it once to draw the 40px chip you see. Nothing is
  copied anywhere: the path you chose is the path handed to the session, and for a session this app
  holds open the image's bytes are read at send time and go to that session and nowhere else — see
  [What it transmits](#what-it-transmits) for the turn that carries them off this machine. No
  directory is walked, no sibling file is looked at, and a file you removed from the composer before
  pressing Enter is never read again (`src/main/textDelivery/attachmentFiles.ts`, #408).

### The one-time history scan

The widest read this app performs happens on its first launches, and you should know about it
before you install. To fill the coal pile — the material standing for every token burned
_before_ DwarfAI-Miners existed on your machine — it walks **every Claude project directory
under every configured Claude root, every day directory under the Codex sessions root, and every
session row in the OpenCode store**, not only the sessions that are live. In each Claude and Codex
file it reads only the transcripts and rollouts whose last write pre-dates that first launch: 64 KB
from the end of a Claude transcript, and 16 KB from the start plus 128 KB from the end of a Codex
rollout. The OpenCode read is a single SQL query over `opencode.db` instead of individual files,
since one session row already carries its own token counters and its own last-write time; a
session still being written to at that first launch is skipped the same way a Claude or Codex file
still being written to is. From each source it keeps two things — the project path it records, and
its final token count. Message text is parsed and discarded (`src/main/ledger/coalBackfill.ts`,
`src/main/ledger/coalScan.ts`).

Antigravity is not part of that scan, and not by choice: its format records no token usage at all,
so there is nothing in it to count.

The scan is bounded rather than instantaneous: at most 1 500 files or 8 seconds per launch,
and never more than 400 files out of any single directory. It therefore resumes across
launches until it has been round the whole tree once, and then never runs again. What it
produces is a floor on your past usage rather than an audit — subagent transcripts, anything
past the per-directory limit, and any transcript carrying no project path are all left out.

## What it stores, and where

Everything the app keeps lives in Electron's per-user data directory:

| Platform | Directory                                      |
| -------- | ---------------------------------------------- |
| Windows  | `%APPDATA%\DwarfAI-Miners`                     |
| macOS    | `~/Library/Application Support/DwarfAI-Miners` |
| Linux    | `~/.config/DwarfAI-Miners`                     |

Fourteen entries: thirteen the app writes, and one (`config-v1.json`) it only reads. All but
`hook-token` and the SQLite database are plain JSON or an empty marker, so you can read them in any
text editor.

**Your preferences** — one tiny JSON document each, so a corrupt one can only cost you that one
setting:

| File                             | Purpose                                                                                                                                                                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pin-preference-v1.json`         | Whether you left the panel pinned always-on-top (`src/main/shell/pinPreference.ts`).                                                                                                                                                   |
| `shortcut-preference-v1.json`    | The global panel-toggle accelerator you chose (`src/main/shell/shortcutPreference.ts`).                                                                                                                                                |
| `panel-edge-v1.json`             | Which screen edge the docked shell opens on (`src/main/shell/panelEdgePreference.ts`).                                                                                                                                                 |
| `message-panel-position-v1.json` | Where you last dragged the message panel's window (`src/main/shell/messagePanelPosition.ts`).                                                                                                                                          |
| `audio-preferences-v1.json`      | Whether music starts on launch, and the three volumes (`src/main/shell/audioPreference.ts`).                                                                                                                                           |
| `jev-preferences-v1.json`        | Your Jev routing profile (`economy` / `balanced` / `premium`) and default launch (provider, model, effort) — plain JSON, not a secret; re-validated against the launch gate before it is written (`src/main/shell/jevPreferences.ts`). |

**Markers and secrets:**

| File                          | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `autostart-default-v1.marker` | Remembers that the packaged app already applied its one-time autostart default, so a tray opt-out is never overridden (`src/main/index.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `hooks-enabled.marker`        | Remembers that you opted into instant updates (`src/main/hooks/hookChannel.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `hook-token`                  | The per-install random secret that authenticates hook requests. It is embedded in the hook commands in your own Claude config and goes nowhere else (`src/main/hooks/hookToken.ts`).                                                                                                                                                                                                                                                                                                                                                                                                               |
| `jev-api-key-v1.json`         | The TypeSafe API key you type into Settings for Jev, holding only Electron `safeStorage` ciphertext — base64 in `{ "encrypted": "..." }` — never the plaintext key. Clearing the key rewrites the file to `{}`. There is no plaintext fallback: on a machine (typically Linux, with no real keyring behind it) where `safeStorage.isEncryptionAvailable()` reads false, nothing is ever written here and the option shows why it is off instead (`src/main/shell/jevApiKey.ts`, `src/main/adapters/safeStorageLike.ts`). See [What it transmits](#what-it-transmits) for what the key is used for. |

**Read, never written:**

| File             | Purpose                                                                                                                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config-v1.json` | Settings for an installed app, which has no repository `.env` to read. It is read on every launch; no screen in the app writes it, so it exists only if you created it by hand (`src/main/config/configFile.ts`). |

**Your history** — the two entries that accumulate, and the ones worth reading the next section
about:

| File                    | Purpose                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projects-v1.db`        | One SQLite file holding the projects list (name, **absolute path**, measured tier, when it was added, when it was last active, and whether you have removed it from the list), the material vault, and the sessions this app has launched (`src/main/appDatabase/appDatabase.ts`, `src/main/projects/projectsStore.ts`, `src/main/ledger/sqliteLedgerStore.ts`). Opened read-write; nothing else reads it. |
| `coal-backfill-v1.json` | The history scan's bookmark: when it first ran, whether it has finished, and — while it has not — the absolute paths of the transcript directories it has already read (`src/main/ledger/coalBackfill.ts`).                                                                                                                                                                                                |

One more file may be there from an older version. `material-ledger-v1.json` was the vault before it
moved into the database. It holds the same thing — cumulative tokens per material, keyed by absolute
project path, plus a last-seen counter per session id. On the first launch after the move it is read
once and then **kept as a backup and ignored forever**; nothing in the app ever writes to, renames,
or deletes it (`src/main/ledger/ledgerMigration.ts`). It becomes the live vault again only on a run
where the database will not open, which the app says in its log
(`src/main/ledger/openLedgerStore.ts`). Delete it yourself if you would rather it not sit there —
after the move, nothing needs it.

Every JSON document above is rewritten through a sibling `.tmp` file and a rename, so an
interrupted write can only leave the previous file intact, plus at worst a stray `.tmp` beside
it.

Outside that directory, and only if you opt into **Instant updates (Claude hooks)**:

- one hook entry per event in each Claude root's `settings.json`, every entry carrying the
  `dwarfai-miners-hook` marker so install and uninstall can never touch another tool's hooks
  (`src/main/hooks/hookInstaller.ts`);
- a one-time pristine backup of each modified `settings.json`, saved beside it as
  `settings.json.dwarfai-backup` and never overwritten afterwards.

When autostart is on, the platform's standard autostart entry also exists — the HKCU `Run`
key, a LaunchAgents plist, or an XDG autostart desktop entry; the README's startup section
lists the exact locations.

**The vault is a durable record of your projects, and it is worth being plain about it.**
`projects-v1.db` holds one row per project you have run an agent in, named by its absolute path,
with a running token total beside it — so it says which projects exist on this machine and roughly
how much work each has had. Nothing prunes it by project: a project you deleted a year ago keeps its
row and its totals, and **removing a mine from the Mines list does not remove it either** — that
control sets a "you stopped tracking this" timestamp, which is exactly why adding the folder again
brings the mine back with its ore. Settings' **Reset metrics** wipes the material totals; it is the
only thing in the app that does. While the history scan is unfinished, `coal-backfill-v1.json`
likewise lists transcript directory paths.

Beyond those files nothing is copied. Transcripts, rollouts, and Codex's SQLite files are read
in place, and no message text the panel displays is written to disk by this app.

**A finished turn's own conclusion, kept in memory only (#510).** A held session (Claude,
Antigravity) keeps its most recently finished turn's outcome: whether it concluded, was capped,
errored, or was interrupted; the provider's own word for what happened; the turn's own final
text, when the provider handed one over, bounded to the same 250,000-character ceiling every
message on this wire answers to; and when it ended (`Dwarf.lastTurn`, the `TurnOutcome` type in
`src/shared/contracts.ts`, read off the provider's own end-of-turn message by
`claudeTurnOutcome.ts`'s `resultTurnOutcome` and `antigravityHeldSession.ts`'s `turnOutcomeOf`). A
held Claude session's own subagent crew keeps the same shape for the last 50 conclusions it has
sealed (`HeldCrew`, `MAX_ENDED_CONCLUSIONS`, `heldCrew.ts`). A one-shot launch this app started and
is still watching — Codex or OpenCode today — keeps one outcome the same way, read off its own
exit status and stdout (`oneShotTurnOutcome.ts`, kept on the launch's own record in
`LaunchedSessionRegistry`, `launchedSessions.ts`). None of it reaches `projects-v1.db` or any
preference file: it lives only in this process's memory, for as long as the session or the launch
record does, and is gone the moment the app restarts.

That does not loosen the promise just above. A held session's turn text is still never written to
disk — it is the same conversation text this app already keeps only in memory, carried one field
further. A one-shot launch is where that promise now has one transient, honest exception. To read
back what its own process actually wrote, this app captures that process's stdout to a temp file
it creates beside the stderr file it already captured for early-failure detection
(`StdoutFile`/`StderrFile`, `launchRunner.ts`) — both under Node's own OS temp directory, never
this app's own data directory — reads back a bounded tail of it once the process exits (16 KB,
`STDOUT_TAIL_BYTES`), and deletes it. Codex's own `--output-last-message` file, which Codex writes
itself with just the turn's clean final message, is read back and deleted the same way whenever it
has anything in it. Both happen only if this app is still running to see the process exit: a
detached launch is built to survive the panel quitting, so a launch that outlives the panel leaves
its temp file behind in the OS temp directory, orphaned — exactly as its stderr counterpart
already could, before this app ever read either back.

## What it transmits

The application code contains exactly one outbound HTTP client, and it exists for exactly one
reason: Jev, an optional launch assist that asks TypeSafe's API to pick a provider, model and
effort for a prompt before you launch it (#509). Outside of Jev there is still no telemetry, no
analytics, no crash reporting, and no auto-updater — session data, transcripts, and project paths
are never sent anywhere by DwarfAI-Miners. What follows says exactly what that one call carries,
then the boundaries that keep everything else local.

### Jev: the one outbound call

Jev fires only when both are true: you have entered your own TypeSafe key in Settings, and turned
on **Let Jev choose** in the Add Panel. With both true, pressing Enter on the composer sends
**one** request to `https://api.typesafe.ai/v1/systemone`, over TypeSafe's own `@typesafe-ai/sdk`
(`createTypesafeJevRouter`, `src/main/jev/typesafeJevRouter.ts`; the exact URL is pinned in
`typesafeJevRouter.test.ts`), before the launch itself goes out
(`submit`, `src/renderer/src/composables/useAgentLaunch.ts`).

**What leaves, in that one request (request v2, jev-routing-profiles #509 follow-up):** the `state`
object is now exactly `{ prompt, routing_profile }` — the prompt as typed, and the routing profile
you chose in Settings (`economy`, `balanced` or `premium`, one of those three words and nothing else
about this machine). Jev no longer receives any model name at all. Instead it answers **five fixed
questions about the prompt**, asked in one request, with criteria written by this project rather than
read off any model's own description (`buildJevRouteRequest`, `src/main/jev/routeRequest.ts`):

- **`is_trivial`** — is this small talk or a one-line factual question, or a real request to write,
  read, debug, explain or change code.
- **`needs_large_context`** — does this need many files, modules or a large pasted corpus, or is it
  scoped to one file or function.
- **`provider`** — which agent CLI this machine can launch right now is the best tooling fit, judged
  on tooling and ecosystem fit only, never cost.
- **`model_tier`** — how capable a model this needs (`fast-cheap` / `balanced` / `frontier` /
  `long-context`), judged against the chosen routing profile's own rule.
- **`effort`** — a fixed four-level difficulty rubric, asked the same way regardless of which
  provider ends up chosen (`EFFORT_RUBRIC`, `src/main/jev/routeRequest.ts`).

The concrete model is never asked for and never sent — it is decided **locally**, after Jev answers,
by matching the five answers against a maintained, source-verified model capability table
(`src/main/jev/capabilities/`, `src/main/jev/routeDecision.ts`; see the
[`jev-capabilities`](../skills/jev-capabilities/SKILL.md) skill for how an entry earns its place in
that table and what evidence it needs).

**What comes back, in that one response:** five answers — a probability for each of the two yes/no
questions, a choice and Jev's own confidence for `provider` and `model_tier`, and a score for
`effort` — never a model name, since none was ever offered as an option
(`JevRouteAnswers`, `src/main/jev/jevRouterPort.ts`).

**The TypeSafe API key** rides the same request as its bearer token — read from the encrypted store
at call time and never logged (`createTypesafeJevRouter`, `src/main/jev/typesafeJevRouter.ts`).

**What never leaves:** project paths, session data, transcripts, usernames, model names, or anything
else about this machine beyond the prompt's own text and the three-word routing profile.
`routeRequest.test.ts` pins exactly that for the prompt: a test builds a request from a prompt
containing a fake local path and asserts the path appears in the prompt state and nowhere else in
the request (`'carries nothing about this machine but the prompt itself'`,
`src/main/jev/routeRequest.test.ts`).

**Request size, as observed.** TypeSafe publishes no fixed per-request token count, so this is a
measurement from the maintainer's own `JEV_DEBUG` traces on this machine, not a guarantee: a live
route request under request v2 ran **about 1,550–1,650 input tokens**, observed 2026-09-21. A future
change to the question set, the criteria copy, or the launchable-provider count will move this
figure; re-measure from a live trace rather than trusting this number to stay current.

**What comes back from the local decision, and what is done with it:** one decision on the wire — a
provider, an optional model, an optional effort level, the tier the local decision landed on, and a
per-part breakdown naming which parts were Jev's own answer versus a safe default a confidence floor
or the routing profile substituted — or a typed reason it could not decide, carrying your own
configured default launch when one is set (`JevRouteLaunchResult`, `src/shared/contracts.ts`). Before
that answer ever reaches the renderer, main checks it against the same gate every launch goes through
(`parseLaunchTuning`) — nothing crosses that `agent:launch` could not itself carry out
(`createJevLaunchRouter`, `src/main/jev/routeLaunch.ts`; `decideLaunch`,
`src/main/jev/routeDecision.ts`). The decision is then shown in a card that states the chosen
provider, model and effort with the overall confidence, then says part by part what Jev answered and
what fell to a safe value, with Jev's own reported confidence for each, and whether the prompt was
treated as trivial or a large-context model was preferred (`jevDecisionSummary`, `jevPartsSummary`,
`src/renderer/src/components/launch/AddPanel.vue`). It is applied to the pickers, and can be
overridden or dismissed; it is never a launch by itself; pressing Launch again is what actually starts
the session (`src/renderer/src/composables/useAgentLaunch.ts`).

**When it does not happen:** no key is configured, the toggle is off, or the option is hidden
outright (no key) or shown disabled with the reason (this machine has no encrypted place to keep
one) — `JevSettings`/`JevUnavailableReason`, `src/shared/contracts.ts`. Whatever goes wrong after
that — unreachable, rate-limited, unauthorized, timed out, an unusable answer, no launchable
provider, or a request too large for TypeSafe's own budget — degrades to a typed fallback reason,
and the launch still happens on the pickers' current values, saying that it did (`classifyError`,
`src/main/jev/typesafeJevRouter.ts`; `createJevLaunchRouter`, `src/main/jev/routeLaunch.ts`).
`'low-confidence'` is still a named reason on the wire, kept for a distinguishable low-confidence
failure worth naming again in the future, but no path produces it today: every per-question floor
now resolves to a safe default instead — see the
[`jev-capabilities`](../skills/jev-capabilities/SKILL.md) skill's own tier-routing section. When you
have set a default provider, model or effort in Settings
(see [What it stores](#what-it-stores-and-where)), main attaches it to the fallback on the wire
(`fallbackTo`, `JevRouteLaunchResult`), and the panel applies it to the pickers exactly as it would
a decision, names it in the fallback line ("Your default, … is set below — press Launch again or
change it"), and waits for your Enter unless Auto-accept is on (`jevAnswered`,
`src/renderer/src/lib/launch/launchState.ts`; `AddPanel.vue`). Without a default, a chosen provider
launches on the pickers' current values; with none chosen either, nothing launches and the prompt is
kept (#523). The whole call is bounded at 15 seconds of this app's own wall-clock time
(`DEFAULT_TOTAL_BUDGET_MS`, `src/main/jev/routeLaunch.ts`), whatever TypeSafe's own retries do
underneath, so Jev can delay a launch but never hang one.

**Retention on TypeSafe's side.** This app controls only what it sends, not what TypeSafe keeps
once it has been sent, and this document states only what TypeSafe's own primary sources say
rather than paraphrasing beyond them. TypeSafe's [Privacy Policy](https://typesafe.ai/legal/privacy-policy)
states it will not "train or fine tune any artificial intelligence or machine learning models on
your prompts or other Input," and that it retains personal data "for as long as reasonably
necessary to provide you with the Services, or otherwise in support of our business or commercial
purposes" — no fixed number of days is published there. Its
[Data Processing Agreement](https://typesafe.ai/legal/data-processing) states the same open-ended
standard for data it processes on a customer's behalf: retained "for as long as necessary taking
into account the purpose of the Processing." Neither document verifies a specific retention period
for a System One request, so this document does not claim one. TypeSafe's
[legal index](https://docs.typesafe.ai/legal) separately names zero data retention as an option
for enterprise customers, reachable at `privacy@typesafe.ai`; this app makes no claim about which
tier its own requests fall under, and you would need to arrange that directly with TypeSafe.

### Everything else stays local

Three boundaries keep the rest of this app from opening a socket of its own:

- **The hooks channel is inbound and loopback-only.** The listener binds `127.0.0.1` and is
  never reachable from the network; requests without the per-install token are dropped before
  their body is read, and bodies are capped at 4 KB (`src/main/hooks/hookServer.ts`). The
  hook command written into your Claude config POSTs the hook's own JSON to
  `http://127.0.0.1:<port>` with `--noproxy 127.0.0.1`, so not even a configured proxy can
  route it off the machine (`src/main/hooks/hookCommand.ts`).
- **The Send action never opens a socket of its own; what it does depends on the channel.** Writing
  into a console (the default where the panel can reach one) is entirely local: the message is put
  into the input buffer of the console your session's own process is attached to, addressed by
  process id — no window is raised and nothing is put on your clipboard — see the next section. On
  macOS, writing a message into a Terminal.app tab asks the OS for one new permission, **Automation
  control of Terminal** — prompted once, the first time a message is sent, and used for nothing
  else. Answering a multi-select question or the "Other Thing" prompt there is a different act, a
  keystroke at the foreground window, and that one needs **Accessibility** permission instead; the
  app cannot detect either grant and will not prompt in advance for Accessibility. Neither
  permission lets DwarfAI-Miners read anything from Terminal — both are write-only reach into a
  window you already own. Handing a message to a Codex
  thread's queue spawns your own `codex` binary with the thread id and the text as argv. The relay
  spawns one throwaway `claude -p` turn from `~/.local/bin/claude` (or `claude.exe` under the same
  path on Windows), in `--safe-mode`, restricted to the `ListAgents` and `SendMessage` tools
  (`src/main/textDelivery/relay.ts`, `relayRunner.ts`). That turn runs under your Claude account,
  and its network behavior is Claude Code's — the text you typed travels to Anthropic the same way
  anything you type into Claude Code does, and DwarfAI-Miners itself opens no connection.
- **Launching or continuing OpenCode spawns your own `opencode` binary, and never puts your words
  on its command line.** Pressing Launch starts `opencode run` in the mine's folder with your first
  prompt written to its stdin and the pipe closed right after — the same detached shape Codex's and
  Antigravity's own launches already run on (`src/main/sessionLaunch/launchRunner.ts`). Sending a
  message to a root OpenCode session afterwards — launched by this panel or opened in your own
  terminal — spawns `opencode run --session <id>` again, your message on its stdin the same way; a
  message typed while a turn is already running waits here and is sent once that turn ends, rather
  than starting a second process on the same session
  (`src/main/textDelivery/opencodeContinue.ts`). Codex's own resumed-thread channel,
  `codex-exec-resume`, spawns `codex exec resume <id> -` on the identical terms — the model's
  reply, in both cases, is read back from the CLI's own local store on the next poll, the same way
  every other session's reply already is; neither process is a second network connection this app
  opens.
- **An attached image, on a held session, leaves inside that same turn.** A session this app holds
  runs on the Agent SDK, driving the `claude` binary you already installed and logged into, exactly
  as the relay's turn does. Since #408 an attachment's image bytes ride along as one more content
  block in that turn rather than a second connection of their own — they leave the machine at the
  moment you press Enter, in the same turn your typed words were already taking
  (`src/main/textDelivery/attachmentDelivery.ts`, `src/main/sessionLaunch/sdkHeldSession.ts`).
- **External links open in your browser.** A link that asks for a _new window_ is refused and
  its URL handed to the system browser instead (`setWindowOpenHandler` in
  `src/main/shell/window.ts`). That is the whole of it: there is no `will-navigate` handler,
  so nothing stops the panel's own frame being navigated somewhere else. In practice the
  renderer is a local bundle that navigates nowhere, but the guard is narrower than "all
  navigation is denied" and should not be relied on as if it were that.
- **A link inside a message bubble goes through the same rule, checked twice.** Markdown in a
  bubble can draw a link, but never as a real `<a href>` the panel's own frame could be navigated
  by — it draws a button, and pressing it asks main to open the address (`shell:openExternalLink`).
  Only `http:` and `https:` addresses under 2048 characters pass; the renderer checks this before
  drawing the link at all, and main checks the same raw string again before it ever reaches
  `shell.openExternal`, because a renderer's word is never treated as a permission
  (`src/shared/externalLink.ts`, `src/main/shell/openExternalLink.ts`).

## Your clipboard: nothing borrows it any more

**This section used to say the opposite, and the change is worth stating rather than quietly
deleting.** Until #371, sending a message into a session's console put that message on your
**system clipboard**, pasted it with Ctrl+V into the window it had just brought forward, and
restored what was there before. For the length of that focus and keystroke your clipboard held the
message you had just sent, and anything that wrote to the clipboard in the same instant lost its
value to the restore. Both were accepted deliberately and stated here.

Neither happens now. The message is written straight into the input buffer of the console your
session's own process is attached to, found by **process id**
(`src/main/textDelivery/consoleInputWrite.ts`, `windowsTextDelivery.ts`): no window is brought
forward, no keystroke is synthesized, and **your clipboard is not read or written at all**. The
app no longer holds a clipboard port of any kind — nothing in it reads or writes one, on any
channel.

The text does still leave the app on that path, and it always did: it is handed to the console of
the session you addressed, which is a program running as you on your own machine. What is gone is
the second copy that sat on a system-wide clipboard on its way there.

## What is shown on screen

The panel is an always-on-top window, so whatever it displays can land in screenshots and
screen shares. Transcript **message text** is therefore passed through a redaction pass at the
provider boundary, before it ever reaches the renderer: GitHub tokens, `sk-` keys, Google API
keys, Slack tokens, JWTs, long hex runs, and long entropic runs are replaced with `[redacted]`
(`src/main/domain/redactSecrets.ts`). The pass is deliberately lossy — it will sometimes
redact an innocent git SHA, because a false positive costs a copy-paste while a false
negative costs a key — and it is display hardening, not a guarantee. The files on disk are
untouched either way.

That pass covers message text and nothing else. Three things reach the panel exactly as they
were found:

- **Project paths.** A mine is labelled with its full path above the cave (`MineScene.vue`). The
  world map no longer shows one: since #136 its hover tooltip carries the tier, the project NAME
  and the agent count, which is what the design specifies — so the folder a project sits in is not
  on screen there any more, only what it is called.
- **Session names**, as the Claude session registry records them.
- **Subagent task descriptions**, taken from the `Agent` tool call that launched each worker
  and used as that worker's name and its tooltip line (`claudeProvider.ts`).
- **A worktree's branch name**, beside a dwarf's name in the message panel header, for a session
  running in a git worktree of a project rather than its main folder — the folder name instead,
  when that worktree's checkout is detached (`src/renderer/src/lib/worktree.ts`). The dialog
  offered when you add a worktree folder also names the project's full path, no differently from
  the path already shown above every mine's cave.

A description is free text the orchestrating session wrote, so it is transcript-derived text
that reaches the screen without going through the redaction pass. Read the panel as showing
your project paths and your task descriptions to anyone who can see your screen.

## Where DwarfAI-Miners' responsibility ends

DwarfAI-Miners observes the files other tools write; it does not control what those tools do:

- **Claude Code and Codex** talk to their own backends under your accounts. What they
  transmit, log, or retain is governed by their vendors' terms and privacy policies, not by
  this document.
- **Installers** are downloaded from GitHub Releases — that download is an interaction with
  GitHub, under GitHub's policies.
- **Building from source** makes pnpm fetch dependencies from the npm registry. The packaged
  app fetches nothing.

Anything this document does not cover, the source does — start at `src/main/`.
