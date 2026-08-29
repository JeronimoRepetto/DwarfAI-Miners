# DwarfAI-Miners

[![CI](https://github.com/JeronimoRepetto/DwarfAI-Miners/actions/workflows/ci.yml/badge.svg)](https://github.com/JeronimoRepetto/DwarfAI-Miners/actions/workflows/ci.yml)

DwarfAI-Miners is a floating desktop panel that turns active AI coding sessions into mines and
dwarfs. A mine represents one project; workers and foremen represent the agents currently
operating in that project.

**Status:** functional MVP. Claude Code and Codex session detection, live IPC updates, mine
tiers, animated dwarfs, terminal focus with transcript fallback, autostart, and packaging are
implemented. Windows is the verified platform; macOS and Linux build and are unit-tested but
have not been run end to end yet — see the support matrix below.

## Install

Download the installer for your OS from the
[latest release](https://github.com/JeronimoRepetto/DwarfAI-Miners/releases/latest):

| Platform | File                                                          |
| -------- | ------------------------------------------------------------- |
| Windows  | `DwarfAI-Miners-Setup-*.exe` (installer) or `-Portable-*.exe` |
| macOS    | `DwarfAI-Miners-*.dmg` (arm64 or x64, matching your Mac)      |
| Linux    | `DwarfAI-Miners-*.AppImage` or the `.deb` package             |

Nothing is code-signed or notarized (see [`docs/signing.md`](docs/signing.md)), so:

- **macOS**: Gatekeeper blocks the unsigned app on a normal double-click. Right-click (or
  Control-click) the app and choose **Open**, then confirm in the dialog — only needed once.
- **Linux**: make the AppImage executable before running it: `chmod +x DwarfAI-Miners-*.AppImage`.

Every release is built and packaged on the target OS, but Windows is the only platform that has
been run end to end — see the support matrix below for exactly what is verified versus built and
unit-tested only.

## Platform support

Every operating-system-specific behavior sits behind a port selected in one place
(`src/main/platform/platformAdapters.ts`), and each adapter's commands and file contents are
unit-tested as pure builders. What has _not_ happened is running those commands on a real Mac
or Linux desktop, so the table is honest about the difference.

| Capability                              | Windows                       | macOS                                  | Linux                                  |
| --------------------------------------- | ----------------------------- | -------------------------------------- | -------------------------------------- |
| Overall                                 | **Verified**                  | Built, integration-pending             | Built, integration-pending             |
| Session detection (Claude Code / Codex) | Verified                      | Expected to work (home-relative paths) | Expected to work                       |
| Codex liveness probe                    | PowerShell `Win32_Process`    | `pgrep -f codex`                       | `pgrep -f codex`                       |
| Click-to-focus a terminal               | user32 via PowerShell         | `ps` + System Events (`osascript`)     | **Unsupported** — falls back to viewer |
| Live transcript viewer                  | Windows Terminal / PowerShell | Terminal.app via `osascript`           | `x-terminal-emulator` → … → `xterm`    |
| Type a message into a terminal session  | SendKeys                      | **Disabled** (built, gated)            | **Unsupported**                        |
| Relay a message to a named session      | Supported                     | Supported                              | Supported                              |
| Start at login                          | HKCU Run key                  | `~/Library/LaunchAgents` plist         | `~/.config/autostart` desktop entry    |
| Packaging                               | NSIS + portable               | dmg + zip (arm64 & x64)                | AppImage + deb                         |

Notes on the three honest gaps:

- **Linux window focus** is unsupported on purpose. `wmctrl`/`xdotool` are X11-only, absent by
  default, and blocked outright under Wayland; guessing would mean hanging on a tool that is not
  there. Clicking a dwarf goes straight to the transcript viewer instead.
- **macOS keystroke injection** is implemented (`osascript` + System Events) and unit-tested,
  but it is gated off behind `DARWIN_CONSOLE_INPUT_ENABLED` until it has been run on a real Mac —
  it also needs the user to grant Accessibility permission, which the app cannot detect. While it
  is off, Send and Kick render disabled with their reason rather than silently typing nowhere.
- **Session-data layouts** (`~/.claude`, `~/.codex`) are assumed to be identical on all three
  platforms. They are home-relative already and nothing in the formats is Windows-specific, but
  this has not been confirmed against real macOS/Linux fixtures.

## Quick start

```bash
pnpm install
pnpm dev
```

The panel starts hidden. Press **Ctrl+Alt+Shift+P** or click the tray icon to show it.

> pnpm 11 build scripts are allowed through `allowBuilds` in `pnpm-workspace.yaml`. If the
> Electron binary is missing after an interrupted install, run `pnpm rebuild electron`.

CI (`.github/workflows/ci.yml`) runs typecheck, lint, format check, tests, and build on every
push to `main` and on every pull request.

## What the panel shows

The panel is an isometric idle-game with two views:

**Map view (default).** A painted moonlit valley where every project with an observed AI CLI
session appears as a mine mound. Positions are derived from a hash of the mine id, so mounds
stay put across refreshes. Each tier has its own painted entrance and mineral palette —
bronze (earthy brown), copper (teal patina), silver (grey shimmer), gold (warm glow), uranium
(dark rock with a radioactive green pulse). Hovering a mound shows project name, tier, path,
and dwarf count; clicking enters the mine.

**Mine interior.** The painted cave for that tier, with the crew standing on the walkable
floor along the bottom. Each agent is a dwarf animated by swapping painted poses:

- **working** alternates two pickaxe swings,
- **waiting** alternates two resting poses with a drifting "z z z",
- **leaving** alternates two walking poses, mirrored toward the exit, fading during the
  runtime grace window,
- the **foreman** stands apart and looks up from his log book now and then.

The provider is shown by a small badge on the sprite rather than by tinting the painting.
Hovering a dwarf shows name, provider, model, effort, and status. When an agent's last
message changes, a comic speech bubble appears above it for a few seconds.

### Art pipeline

The renderer ships processed art in `src/renderer/src/assets/art/` — committed, so a clone
builds and runs without the source paintings. `pnpm art:build` regenerates it from the
originals, which live outside the repository (default `<home>/Downloads/DwarfAI-Miners`,
overridable with `--src <dir>` or `DWARFAI_MINERS_ART_SRC`) and are never modified. The script
itself is platform-neutral: every path goes through `node:path`.

The script chroma-keys the dwarf and mound paintings off their flat backdrop — sampling the
key color from each image's own four corners, because it differs per image — crops all nine
dwarf poses to one shared canvas so animation frames never jitter, and downscales the opaque
background scenes. Its pure helpers are unit tested in `scripts/art/keying.test.mjs`.

Clicking a dwarf first tries to focus its terminal window. Claude sessions provide a PID, so
this works when their process ancestry reaches a supported terminal host (and on a platform
where focusing is supported at all — see the matrix above). Codex rollouts do not expose a
reliable PID; DwarfAI-Miners then opens a terminal tailing the transcript live, and failing
that shows the recent activity feed on a parchment board inside the panel.

The live viewer ships twice, once per shell: `resources/dwarf-feed-viewer.ps1` for Windows and
`resources/dwarf-feed-viewer.sh` for macOS and Linux. The POSIX one is a plain `sh` script
around `tail -f`, and it parses JSONL with a small JavaScript formatter run on the Node runtime
the app already bundles (`process.execPath`, via `ELECTRON_RUN_AS_NODE`), so no system Node is
required. If that formatter cannot run, the viewer falls back to showing the raw JSONL rather
than nothing.

### Application icon

Same idea as the art pipeline: committed, derived output, regenerated by a script rather than
hand-edited. `pnpm icons` (`scripts/build-icons.mjs`) composites the painted `mound-gold.png`
onto a dark circular badge — a strong, high-contrast silhouette is what actually survives being
shrunk to a 16x16 tray icon — and writes every size electron-builder and the app itself need:
`build/icon.ico` (Windows, multi-size), `build/icon.icns` (macOS), `build/icon.png` (Linux, 512),
and `resources/tray-icon.png` / `tray-icon@2x.png` / `app-icon.png` for the tray and window icons
at runtime. The badge math is unit tested in `scripts/art/badge.test.mjs`; running the script
twice in a row reproduces every output file byte-for-byte.

## Provider support

| Provider    | Support | Liveness and hierarchy                                                                                                                            |
| ----------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | Active  | Uses `~/.claude*/sessions/<pid>.json`, verifies a live PID, and reads parent/subagent transcripts. Multiple Claude roots are supported.           |
| Codex       | Active  | Uses recent rollout mtimes and open-turn events. `thread_spawn.parent_thread_id` is used for verified worker/foreman relationships.               |
| Gemini CLI  | Planned | No Gemini CLI session artifacts were available for verification. The local `.gemini` data belongs to Antigravity and is intentionally not parsed. |

Codex liveness is heuristic: a recently modified rollout can remain visible until the
configured liveness window expires after the CLI closes.

For Claude, the main session dwarf is always the foreman — it is the orchestrator whether or
not it currently has subagents out — and subagents are always workers. A subagent leaves the
crew as soon as its `<task-notification>` reports `completed`, `failed` or `killed`, and
DwarfAI-Miners remembers that so an agent whose notification later scrolls out of the transcript
tail can never come back as a ghost. Codex promotion still comes from a verified
`thread_spawn` parent link.

## Startup and tray behavior

- Packaged builds enable autostart on the first successful launch (the tray item reads **Start
  with Windows** on Windows and **Start at login** elsewhere).
- A marker in Electron's user-data directory prevents later launches from overriding a tray
  opt-out.
- Development runs never write an autostart entry or the marker.
- Closing the panel hides it; **Quit** in the tray exits the process.
- On macOS the app hides its Dock tile: it lives in the menu bar, and its only window is the
  floating panel.

Where the entry is written, per platform:

| Platform | Location                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------- |
| Windows  | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, value `DwarfAI-Miners`                      |
| macOS    | `~/Library/LaunchAgents/com.jeronimorepetto.dwarfaiminers.plist` (`RunAtLoad`, `KeepAlive=false`) |
| Linux    | `$XDG_CONFIG_HOME/autostart/dwarfai-miners.desktop`, defaulting to `~/.config/autostart/`         |

Only Windows has a migration to run: existing installs move automatically on first launch after
the update — the legacy `AgentName` Run value is removed, and the new value is written only if
autostart was on. No macOS or Linux build shipped before the rename, so there is nothing to
migrate there.

## Instant updates (Claude hooks)

Off by default, opt-in from the tray: **Instant updates (Claude hooks)**. It adds a push
channel on top of the 2-second poller so a session appearing, a turn ending or a subagent
finishing shows up in tens of milliseconds instead of on the next poll.

Turning it on does three things, and turning it off undoes all three:

1. Binds a loopback HTTP listener on `127.0.0.1:HOOKS_PORT` (47821 by default). Loopback only —
   it is never reachable from the network.
2. Writes one hook entry per event into `settings.json` in every configured Claude root, for
   `SessionStart`, `Notification`, `Stop`, `SubagentStop` and `SessionEnd`. The command is a
   one-line `curl.exe` that forwards the hook's own JSON to the listener and exits; Windows
   10 1803+ ships `curl.exe`, and enabling refuses with an explanation if it is missing.
3. Records the choice in a marker file under Electron's user-data directory, so the channel
   comes back on the next launch.

Every event triggers the same full rescan the poller already runs, coalesced so a burst inside
one turn costs one extra scan rather than one per event. **The poller stays the ground truth**:
it remains the only startup-reconciliation source, and a missed or malformed hook self-heals on
the next 2-second tick. A user who never opts in sees no behavior change at all.

Safety around `settings.json`, which is the user's own global Claude configuration:

- A pristine copy is taken as `settings.json.dwarfai-backup` before the file is modified for
  the first time, and never overwritten afterwards.
- Install and uninstall only ever touch entries whose command carries the `dwarfai-miners-hook`
  marker. Hooks belonging to any other tool keep their position and content, and unknown keys
  anywhere in the file are preserved.
- Re-enabling replaces our entries instead of duplicating them; disabling removes only ours,
  dropping an event key (and `hooks` itself) once it held nothing else.
- Indentation, line endings and the trailing newline are read back and reproduced, so the diff
  is our addition and nothing more. A file that cannot be parsed is reported and left untouched.
- Requests carry a per-install random token generated on first enable, so another local process
  cannot forge events; a request without it is dropped before its body is read, and bodies are
  capped at 4 KB.

**Turn the toggle off before uninstalling DwarfAI-Miners.** Nothing runs a hook-removal pass at
uninstall time yet, so entries left behind would point at a listener that no longer exists —
harmless (Claude Code treats a failed hook command as a non-blocking error) but untidy.

## Configuration

Copy `.env.example` to `.env`. Every key is optional; invalid values fail fast at startup.

| Variable                  | Default                        | Meaning                                                                             |
| ------------------------- | ------------------------------ | ----------------------------------------------------------------------------------- |
| `POLL_INTERVAL_MS`        | `2000`                         | Provider scan interval in milliseconds.                                             |
| `LIVENESS_WINDOW_S`       | `90`                           | Reserved general activity window.                                                   |
| `CODEX_LIVENESS_WINDOW_S` | `300`                          | Maximum rollout mtime age considered live.                                          |
| `CODEX_SCAN_DAYS`         | `7`                            | How many day-directories (today back N-1 days) to scan for rollouts.                |
| `CODEX_IDLE_RETENTION_S`  | `3600`                         | Extra time a quiet-but-open rollout stays visible while a codex process is running. |
| `CODEX_SESSIONS_ROOT`     | `~/.codex/sessions`            | The Codex rollout directory to scan. A leading `~` is expanded.                     |
| `DWARF_LEAVE_GRACE_S`     | `20`                           | How long a dwarf whose agent finished/disappeared stays visible as "leaving".       |
| `TIER_CACHE_TTL_S`        | `600`                          | Mine-tier cache lifetime.                                                           |
| `TIER_COPPER_AT`          | `25`                           | Source-file threshold for copper.                                                   |
| `TIER_SILVER_AT`          | `100`                          | Source-file threshold for silver.                                                   |
| `TIER_GOLD_AT`            | `400`                          | Source-file threshold for gold.                                                     |
| `TIER_URANIUM_AT`         | `1500`                         | Source-file threshold for uranium.                                                  |
| `CLAUDE_CONFIG_DIRS`      | `~/.claude;~/.claude-multitec` | Semicolon-separated Claude roots.                                                   |
| `HOOKS_PORT`              | `47821`                        | Loopback port for instant updates (see below). Nothing binds it until you opt in.   |

Tier thresholds must be strictly increasing.

## Verification and packaging

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

The whole test suite is platform-independent: every per-OS builder is tested by passing the
platform explicitly, so the same assertions run and pass on any host. CI currently runs the
Windows leg only; a macOS/Linux matrix is a follow-up (see `.github/workflows/ci.yml`).

Packaging is per-platform and must run on that platform (electron-builder cannot cross-build a
dmg or a deb):

| Command              | Runs on | Output in `release/`                        |
| -------------------- | ------- | ------------------------------------------- |
| `pnpm package`       | Windows | unsigned NSIS installer + portable exe, x64 |
| `pnpm package:mac`   | macOS   | dmg + zip, arm64 and x64                    |
| `pnpm package:linux` | Linux   | AppImage + deb, x64                         |

Nothing is code-signed or notarized, so Windows SmartScreen and macOS Gatekeeper will both warn —
see [`docs/signing.md`](docs/signing.md) for exactly what that means and what it takes to fix.
The application icon (installer, exe, tray, and window) is generated from the painted mound art
by `pnpm icons` (`scripts/build-icons.mjs`); see `build/icon.*` and `resources/*-icon*.png`.

## Architecture

```text
ClaudeProvider / CodexProvider
            |
          Poller -> aggregateMines + TierService
            |
        AgentRuntime  <- createPlatformAdapters (focus, viewer, text delivery, process probe)
            |
      Electron IPC / preload
            |
       Vue renderer
```

The shared contract in `src/shared/contracts.ts` is the single type boundary for main,
preload, and renderer. Providers depend on the `FsLike` port so parsers and scans can be tested
without the real filesystem.

`src/main/platform/platformAdapters.ts` is the single composition point for everything
operating-system-specific. Nothing else in the app reads `process.platform`: the runtime gets a
focus function, a `TextDeliveryPort`, a transcript-viewer launcher and a `ProcessProbePort`, and
autostart gets an `AutostartPort` — all selected there and all injectable in tests. Each adapter
is split into pure builders (a command's argv, a plist's exact bytes) and a thin runner, which is
what makes platforms that cannot be executed here still testable here.

## Security posture

The renderer runs with context isolation enabled and Node integration disabled. The preload
exposes only the typed DwarfAI-Miners API. External navigation is denied in the panel and opened in
the system browser instead.
