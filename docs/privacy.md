# Privacy and data boundary

DwarfAI-Miners is a local desktop app. Everything it does happens on your machine: it reads
the local files Claude Code, Codex and Antigravity already write, renders them in a floating panel,
and keeps a handful of small files of its own. This document states exactly what is read, what is
stored, and what is transmitted. Every claim names the source that implements it, so it can be
checked rather than trusted.

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

### The one-time history scan

The widest read this app performs happens on its first launches, and you should know about it
before you install. To fill the coal pile — the material standing for every token burned
_before_ DwarfAI-Miners existed on your machine — it walks **every Claude project directory
under every configured Claude root, and every day directory under the Codex sessions root**,
not only the sessions that are live. In each one it reads the transcripts and rollouts whose
last write pre-dates that first launch: 64 KB from the end of a Claude transcript, and 16 KB
from the start plus 128 KB from the end of a Codex rollout. From each file it keeps two
things — the project path the transcript records, and its final token count. Message text is
parsed and discarded (`src/main/ledger/coalBackfill.ts`, `src/main/ledger/coalScan.ts`).

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

Twelve entries: eleven the app writes, and one (`config-v1.json`) it only reads. All but
`hook-token` and the SQLite database are plain JSON or an empty marker, so you can read them in any
text editor.

**Your preferences** — one tiny JSON document each, so a corrupt one can only cost you that one
setting:

| File                             | Purpose                                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------------- |
| `pin-preference-v1.json`         | Whether you left the panel pinned always-on-top (`src/main/shell/pinPreference.ts`).          |
| `shortcut-preference-v1.json`    | The global panel-toggle accelerator you chose (`src/main/shell/shortcutPreference.ts`).       |
| `panel-edge-v1.json`             | Which screen edge the docked shell opens on (`src/main/shell/panelEdgePreference.ts`).        |
| `message-panel-position-v1.json` | Where you last dragged the message panel's window (`src/main/shell/messagePanelPosition.ts`). |
| `audio-preferences-v1.json`      | Whether music starts on launch, and the three volumes (`src/main/shell/audioPreference.ts`).  |

**Markers and secrets:**

| File                          | Purpose                                                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `autostart-default-v1.marker` | Remembers that the packaged app already applied its one-time autostart default, so a tray opt-out is never overridden (`src/main/index.ts`).                                         |
| `hooks-enabled.marker`        | Remembers that you opted into instant updates (`src/main/hooks/hookChannel.ts`).                                                                                                     |
| `hook-token`                  | The per-install random secret that authenticates hook requests. It is embedded in the hook commands in your own Claude config and goes nowhere else (`src/main/hooks/hookToken.ts`). |

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

## What it transmits

Nothing. The application code contains no outbound HTTP client, no telemetry, no analytics,
no crash reporting, and no auto-updater — session data, transcripts, and project paths are
never sent anywhere by DwarfAI-Miners. Three boundaries keep that claim precise:

- **The hooks channel is inbound and loopback-only.** The listener binds `127.0.0.1` and is
  never reachable from the network; requests without the per-install token are dropped before
  their body is read, and bodies are capped at 4 KB (`src/main/hooks/hookServer.ts`). The
  hook command written into your Claude config POSTs the hook's own JSON to
  `http://127.0.0.1:<port>` with `--noproxy 127.0.0.1`, so not even a configured proxy can
  route it off the machine (`src/main/hooks/hookCommand.ts`).
- **The Send action never opens a socket of its own; what it does depends on the channel.** Pasting
  into a console (the default where the panel can reach one) is entirely local: the message goes on
  the system clipboard, the console window is brought forward, Ctrl+V is synthesized, and the
  clipboard's previous contents are put back — see the next section. Handing a message to a Codex
  thread's queue spawns your own `codex` binary with the thread id and the text as argv. The relay
  spawns one throwaway `claude -p` turn from `~/.local/bin/claude` (or `claude.exe` under the same
  path on Windows), in `--safe-mode`, restricted to the `ListAgents` and `SendMessage` tools
  (`src/main/textDelivery/relay.ts`, `relayRunner.ts`). That turn runs under your Claude account,
  and its network behavior is Claude Code's — the text you typed travels to Anthropic the same way
  anything you type into Claude Code does, and DwarfAI-Miners itself opens no connection.
- **External links open in your browser.** A link that asks for a _new window_ is refused and
  its URL handed to the system browser instead (`setWindowOpenHandler` in
  `src/main/shell/window.ts`). That is the whole of it: there is no `will-navigate` handler,
  so nothing stops the panel's own frame being navigated somewhere else. In practice the
  renderer is a local bundle that navigates nowhere, but the guard is narrower than "all
  navigation is denied" and should not be relied on as if it were that.

## The one thing it borrows: your clipboard

Sending a message into a session's console writes that message to the **system clipboard**, pastes
it, and restores what was there before, in a `finally` that runs whichever way the paste ends
(`src/main/textDelivery/windowsTextDelivery.ts`). Two consequences, both accepted rather than
hidden:

- For the length of one window focus plus one keystroke, your clipboard holds the message you just
  sent. Anything that reads the clipboard in that window could read it.
- Anything that _writes_ to the clipboard in that same window loses its value to the restore.

Not restoring at all would be worse — your clipboard would silently become your last sent message —
so the race is taken deliberately. It happens only on the console-paste channel: the relay, the
Codex queue, and a session the panel holds open all touch no clipboard, and no other action in the
app reads or writes one.

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
