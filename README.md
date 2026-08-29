# AgentName

AgentName is a floating Windows panel that turns active AI coding sessions into mines and
dwarfs. A mine represents one project; workers and foremen represent the agents currently
operating in that project.

**Status:** functional MVP. Claude Code and Codex session detection, live IPC updates, mine
tiers, animated dwarfs, terminal focus with transcript fallback, Windows autostart, and
Windows packaging are implemented.

## Quick start

```powershell
pnpm install
pnpm dev
```

The panel starts hidden. Press **Ctrl+Alt+Shift+P** or click the tray icon to show it.

> pnpm 11 build scripts are allowed through `allowBuilds` in `pnpm-workspace.yaml`. If the
> Electron binary is missing after an interrupted install, run `pnpm rebuild electron`.

## What the panel shows

The panel is an isometric idle-game with two views:

**Map view (default).** A dark 2.5D landscape where every project with an observed AI CLI
session appears as a mine mound. Positions are derived from a hash of the mine id, so mounds
stay put across refreshes. Each tier has its own mineral palette — bronze (earthy brown),
copper (teal patina), silver (grey shimmer), gold (warm glow), uranium (dark rock with a
radioactive green pulse). Hovering a mound shows project name, tier, path, and dwarf count;
clicking enters the mine.

**Mine interior.** A layered cave scene (parallax rock, glowing mineral veins in the tier
palette) where each agent is an animated SVG dwarf:

- **working** swings a pickaxe at the rock with spark particles,
- **waiting** rests on the pick with a drifting "z z z",
- **leaving** walks toward the exit and fades during the runtime grace window,
- the **foreman** stands apart holding a clipboard and checks it now and then.

Hovering a dwarf shows name, provider, model, effort, and status. When an agent's last
message changes, a comic speech bubble appears above it for a few seconds. A mine with no
dwarfs shows tools resting against the wall.

Clicking a dwarf first tries to focus its terminal window. Claude sessions provide a PID, so
this works when their process ancestry reaches a supported terminal host. Codex rollouts do
not expose a reliable PID; AgentName then opens the recent activity feed on a parchment
board inside the panel.

## Provider support

| Provider    | Support | Liveness and hierarchy                                                                                                                            |
| ----------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | Active  | Uses `~/.claude*/sessions/<pid>.json`, verifies a live PID, and reads parent/subagent transcripts. Multiple Claude roots are supported.           |
| Codex       | Active  | Uses recent rollout mtimes and open-turn events. `thread_spawn.parent_thread_id` is used for verified worker/foreman relationships.               |
| Gemini CLI  | Planned | No Gemini CLI session artifacts were available for verification. The local `.gemini` data belongs to Antigravity and is intentionally not parsed. |

Codex liveness is heuristic: a recently modified rollout can remain visible until the
configured liveness window expires after the CLI closes.

## Startup and tray behavior

- Packaged builds enable **Start with Windows** on the first successful launch.
- A marker in Electron's user-data directory prevents later launches from overriding a tray
  opt-out.
- Development runs never write the registry or the marker.
- Closing the panel hides it; **Quit** in the tray exits the process.

The registry entry is `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, value
`AgentName`.

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

Tier thresholds must be strictly increasing.

## Verification and packaging

```powershell
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
pnpm package
```

`pnpm package` creates unsigned NSIS and portable x64 executables in `release/`. Windows
SmartScreen can warn because no signing certificate is configured. Until a custom application
icon is added, electron-builder uses Electron's default icon.

## Architecture

```text
ClaudeProvider / CodexProvider
            |
          Poller -> aggregateMines + TierService
            |
        AgentRuntime
            |
      Electron IPC / preload
            |
       Vue renderer
```

The shared contract in `src/shared/contracts.ts` is the single type boundary for main,
preload, and renderer. Providers depend on the `FsLike` port so parsers and scans can be tested
without the real filesystem.

## Security posture

The renderer runs with context isolation enabled and Node integration disabled. The preload
exposes only the typed AgentName API. External navigation is denied in the panel and opened in
the system browser instead.
