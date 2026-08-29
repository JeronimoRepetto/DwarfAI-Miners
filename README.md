# DwarfAI-Miners

DwarfAI-Miners is a floating Windows panel that turns active AI coding sessions into mines and
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
originals, which live outside the repository (default `C:\Users\jeron\Downloads\DwarfAI-Miners`,
overridable with `--src <dir>` or `DWARFAI_MINERS_ART_SRC`) and are never modified.

The script chroma-keys the dwarf and mound paintings off their flat backdrop — sampling the
key color from each image's own four corners, because it differs per image — crops all nine
dwarf poses to one shared canvas so animation frames never jitter, and downscales the opaque
background scenes. Its pure helpers are unit tested in `scripts/art/keying.test.mjs`.

Clicking a dwarf first tries to focus its terminal window. Claude sessions provide a PID, so
this works when their process ancestry reaches a supported terminal host. Codex rollouts do
not expose a reliable PID; DwarfAI-Miners then opens the recent activity feed on a parchment
board inside the panel.

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

- Packaged builds enable **Start with Windows** on the first successful launch.
- A marker in Electron's user-data directory prevents later launches from overriding a tray
  opt-out.
- Development runs never write the registry or the marker.
- Closing the panel hides it; **Quit** in the tray exits the process.

The registry entry is `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, value
`DwarfAI-Miners`. Existing installs migrate automatically on first launch after the update: the
legacy `AgentName` value is removed, and the new value is written only if autostart was on.

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
exposes only the typed DwarfAI-Miners API. External navigation is denied in the panel and opened in
the system browser instead.
