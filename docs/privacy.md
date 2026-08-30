# Privacy and data boundary

DwarfAI-Miners is a local desktop app. Everything it does happens on your machine: it reads
the local files Claude Code and Codex already write, renders them in a floating panel, and
keeps a few small marker files of its own. This document states exactly what is read, what is
stored, and what is transmitted. Every claim names the source that implements it, so it can be
checked rather than trusted.

## What it reads

- **Claude Code session registries.** Every configured Claude root (default `~/.claude`, plus
  any further roots configured via `CLAUDE_CONFIG_DIRS`) is scanned for
  `sessions/*.json` entries — small per-session files carrying the pid, session id, project
  directory, and status. An entry only counts as alive when its pid exists _and_ the
  process's real start time matches the entry, so a recycled pid is never trusted
  (`src/main/providers/claude/claudeProvider.ts`).
- **Claude transcripts, tail only.** For live sessions the provider tail-reads the session's
  transcript `.jsonl` — a bounded number of bytes from the end, never the whole file — to
  derive status, the last message, and the activity feed
  (`src/main/providers/claude/claudeProvider.ts`).
- **Codex rollouts and registries.** The Codex sessions root (default `~/.codex/sessions`,
  overridable with `CODEX_SESSIONS_ROOT`) is scanned for recent rollout `.jsonl` files, with
  bounded head and tail reads. When present, Codex's own SQLite databases
  (`~/.codex/state_5.sqlite` and `~/.codex/logs_2.sqlite`) are opened **read-only** for
  thread relationships and liveness heartbeats (`src/main/providers/codex/codexProvider.ts`,
  `src/main/adapters/sqliteLike.ts`).
- **Project directories, filenames only.** To pick a mine's tier, the tier service walks the
  project directory counting source files by extension — a bounded, capped walk that reads
  directory listings, never file contents, and skips `node_modules`, `.git`, `dist`, `out`,
  `.venv`, and `target` (`src/main/tier/tierService.ts`).
- **Process lists.** Liveness probes ask the operating system whether a pid is alive and
  whether a `codex` process is running — PowerShell `Win32_Process` on Windows, `pgrep`
  elsewhere (`src/main/adapters/processProbe.ts`).

## What it stores, and where

In Electron's per-user data directory (on Windows `%APPDATA%\dwarfai-miners`):

| File                          | Purpose                                                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `autostart-default-v1.marker` | Remembers that the packaged app already applied its one-time autostart default, so a tray opt-out is never overridden (`src/main/index.ts`).                                         |
| `hooks-enabled.marker`        | Remembers that you opted into instant updates (`src/main/hooks/hookChannel.ts`).                                                                                                     |
| `hook-token`                  | The per-install random secret that authenticates hook requests. It is embedded in the hook commands in your own Claude config and goes nowhere else (`src/main/hooks/hookToken.ts`). |

Outside that directory, and only if you opt into **Instant updates (Claude hooks)**:

- one hook entry per event in each Claude root's `settings.json`, every entry carrying the
  `dwarfai-miners-hook` marker so install and uninstall can never touch another tool's hooks
  (`src/main/hooks/hookInstaller.ts`);
- a one-time pristine backup of each modified `settings.json`, saved beside it as
  `settings.json.dwarfai-backup` and never overwritten afterwards.

When autostart is on, the platform's standard autostart entry also exists — the HKCU `Run`
key, a LaunchAgents plist, or an XDG autostart desktop entry; the README's startup section
lists the exact locations.

DwarfAI-Miners keeps no database of its own. Transcripts, rollouts, and Codex's SQLite files
are read in place and never copied, and nothing the panel displays is persisted by the app.

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
- **The Send action runs your own Claude CLI.** Delivering a message to a session spawns one
  `claude -p` turn from `~/.local/bin/claude`, restricted to the `ListAgents` and
  `SendMessage` tools (`src/main/textDelivery/relay.ts`, `relayRunner.ts`). That turn runs
  under your Claude account, and its network behavior is Claude Code's — DwarfAI-Miners
  itself opens no connection.
- **External links open in your browser.** The panel denies all navigation and hands URLs to
  the system browser (`src/main/window.ts`).

## What is shown on screen

The panel is an always-on-top window, so whatever it displays can land in screenshots and
screen shares. Transcript text is therefore passed through a redaction pass at the provider
boundary, before it ever reaches the renderer: GitHub tokens, `sk-` keys, Google API keys,
Slack tokens, JWTs, long hex runs, and long entropic runs are replaced with `[redacted]`
(`src/main/domain/redactSecrets.ts`). The pass is deliberately lossy — it will sometimes
redact an innocent git SHA, because a false positive costs a copy-paste while a false
negative costs a key — and it is display hardening, not a guarantee. The files on disk are
untouched either way.

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
