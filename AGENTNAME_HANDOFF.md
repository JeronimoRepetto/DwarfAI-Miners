# AgentName Handoff

> **Note:** the product was later renamed from AgentName to DwarfAI-Miners. This document is
> kept as-is below for historical record; it is not updated to the new name.

This document is the continuation brief for a future AgentName session.

## 1. Current state

AgentName is a functional Windows Electron MVP that visualizes active AI coding sessions as mines, dwarfs, and foremen.

| Area                                          | Status                                                 |
| --------------------------------------------- | ------------------------------------------------------ |
| Claude Code detection                         | Implemented and tested                                 |
| Codex detection                               | Implemented and tested; liveness is heuristic          |
| Gemini CLI                                    | Deferred: no usable Gemini CLI artifacts found locally |
| Mine aggregation and complexity tiers         | Implemented                                            |
| Electron runtime and typed IPC                | Implemented                                            |
| Frameless floating panel, hotkey, tray        | Implemented                                            |
| Interactive mines/dwarfs/foreman UI           | Implemented                                            |
| Terminal focus and transcript fallback        | Implemented; Codex PID correlation is limited          |
| Packaged first-run autostart and tray opt-out | Implemented                                            |
| NSIS installer and portable executable        | Implemented                                            |
| Code signing and custom application icon      | Not implemented                                        |
| Renderer component tests                      | Not implemented; backend tests are comprehensive       |

The agreed Claude+Codex MVP is complete. Remaining work is production hardening, distribution polish, and optional provider expansion.

## 2. Repository and privacy

- Local root: `C:\Users\jeron\Desktop\AI-Tools\agent-name`
- Branch: `main`; working tree was clean at handoff creation.
- Private remote: `https://github.com/JeronimoRepetto/AgentName`
- GitHub visibility was verified as **PRIVATE**. Never make this repository public.
- Latest implementation commit before this document: `48e7743 build(windows): package installer and portable app`.
- No `.env`, certificates, keys, or secrets are versioned. `.env`, `release/`, `out/`, and `.codegraph/` are ignored.
- Local provider transcripts can contain sensitive project information; do not add fixtures with real content to Git.

## 3. Product requirements and acceptance

The panel must be frameless, floating, hidden by default, and toggled with `Ctrl+Alt+Shift+P`. It has a close button and tray presence, with no traditional title bar. Each active project is a mine whose tier is bronze, copper, silver, gold, or uranium according to bounded source-file complexity. A dwarf represents an agent; a foreman is an orchestrator. Hovering shows provider/model/effort; clicking attempts to focus the terminal and otherwise opens a live transcript/feed fallback. Speech bubbles summarize recent messages and truncate with an ellipsis.

Acceptance checks:

- Frameless, transparent, always-on-top, resizable window; close hides it.
- Tray menu can show/hide, enable/disable autostart, and quit.
- Global hotkey toggles visibility.
- Packaged first launch enables Windows startup by default; tray opt-out persists.
- Empty/no-active-session state is understandable.
- Claude and Codex sessions, agents, parent relationships, model, effort, and recent messages render when available.

## 4. Runtime architecture

```text
ClaudeProvider + CodexProvider
              |
            Poller -> aggregateMines + TierService
              |
        AgentRuntime (latest state + activation)
              |
     Electron IPC / preload bridge
              |
          Vue renderer UI
```

Important files:

- `src/main/runtime.ts` — constructs providers, poller, tier service; publishes updates; activates dwarfs.
- `src/main/index.ts` — Electron lifecycle, window/tray/shortcut, dotenv, autostart, IPC handlers.
- `src/main/providers/claude/**` — Claude session/process/transcript parsing.
- `src/main/providers/codex/**` — Codex rollout parsing and liveness heuristics.
- `src/main/tier/tierService.ts` — bounded source-file counting, cache, tier thresholds.
- `src/main/autostart.ts` — packaged first-run marker and persistent opt-out.
- `src/shared/contracts.ts` — canonical cross-process types and channels.
- `src/preload/index.ts` — safe typed `window.api` bridge.
- `src/renderer/src/App.vue` — mine overview, mine scene, animated CSS dwarfs, foreman, tooltips, bubbles, activation/feed fallback.
- `README.md` and `.env.example` — usage, configuration, architecture, privacy, and packaging instructions.

IPC channels are `panel:hide`, `mines:get`, `mines:update`, and `dwarf:activate`. `src/main/domain/types.ts` re-exports the shared contracts for compatibility.

## 5. Provider facts and limits

### Claude Code

Default roots are `~/.claude;~/.claude-multitec`; the second root matters because the two local Claude accounts share the projects junction but have separate session directories. `~` is expanded with the OS home directory. Claude sessions are discovered from `sessions/<pid>.json`, PID liveness, project cwd, transcripts, and `subagents/`. Waiting sessions are normalized to idle. `procStart` is preserved, but creation-time validation is not yet strict; bounded transcript tails can miss older launch records.

### Codex

Recent rollouts from today/yesterday are scanned. Liveness uses mtime plus open `task_started`/`task_complete` turns and is therefore heuristic. A reliable Codex PID is not available, so terminal focus generally falls back to the transcript feed. Model/effort parsing includes a head-context fallback because `turn_context` may be outside the tail window. Parent relationships use verified `thread_spawn.parent_thread_id` data.

### Gemini CLI

Gemini is intentionally deferred. The local `.gemini` directory is Antigravity protobuf data, not Gemini CLI transcripts, so there is no reliable parser or live-session contract yet. Add support only after real Gemini CLI fixtures are available.

## 6. Configuration

Values are read from environment variables; see `.env.example`.

| Variable                  |                        Default |
| ------------------------- | -----------------------------: |
| `POLL_INTERVAL_MS`        |                         `2000` |
| `LIVENESS_WINDOW_S`       |                           `90` |
| `CODEX_LIVENESS_WINDOW_S` |                          `300` |
| `TIER_CACHE_TTL_S`        |                          `600` |
| `TIER_COPPER_AT`          |                           `25` |
| `TIER_SILVER_AT`          |                          `100` |
| `TIER_GOLD_AT`            |                          `400` |
| `TIER_URANIUM_AT`         |                         `1500` |
| `CLAUDE_CONFIG_DIRS`      | `~/.claude;~/.claude-multitec` |

Tier thresholds are increasing source-file counts. Adjust them only with tests and documentation updates.

## 7. Verification and packaging

The final verification passed:

```text
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test        # 14 files, 144 tests
pnpm build
pnpm package
 git diff --check
```

Generated artifacts:

- `release/AgentName-Setup-0.1.0-x64.exe` (~112.5 MB)
- `release/AgentName-Portable-0.1.0-x64.exe` (~112.4 MB)

They are unsigned and still use the default Electron icon. Packaging alone does **not** launch the app or register the hotkey. Install/run one of the executables first; then confirm the tray icon and `Ctrl+Alt+Shift+P`.

## 8. Implementation commits

- `8eb6346 feat(providers): harden live Claude and Codex detection`
- `537e197 feat(runtime): wire providers through typed IPC`
- `c68e36a feat(ui): render interactive mines and dwarfs`
- `48e7743 build(windows): package installer and portable app`

Commits follow Conventional Commits and contain no AI attribution.

## 9. Prioritized next steps

### P0 — validate the delivered app

1. Run `release\AgentName-Setup-0.1.0-x64.exe` (or the portable executable).
2. Launch AgentName once if the installer did not auto-launch it.
3. Confirm the tray icon and `Ctrl+Alt+Shift+P` toggle.
4. Confirm the first packaged launch creates the Windows Run entry; disable autostart from the tray and verify it stays disabled.

### P1 — production hardening

- Improve Codex process correlation so click-to-focus can target the exact terminal.
- Validate Claude `procStart` against process creation time where Windows APIs permit it.
- Make subagent discovery incremental for very large transcripts.
- Add diagnostics/log export for missing or malformed provider files.
- Add renderer tests with Vue Test Utils/jsdom.
- Add CI for typecheck, lint, tests, build, and package.

### P2 — distribution and optional scope

- Add a real AgentName icon and code signing certificate when credentials are available.
- Add update/release automation.
- Implement Gemini only with real Gemini CLI transcript fixtures and a documented live-session signal.
- Consider a settings UI only after the MVP behavior is stable.

## 10. Continuing in a new instance

```powershell
Set-Location C:\Users\jeron\Desktop\AI-Tools\agent-name
git status --short --branch
git log --oneline -8
pnpm install
pnpm typecheck
pnpm test
```

For structural questions, resolve the repo root and use CodeGraph before broad filesystem searches; `.codegraph/` is intentionally ignored and should not be committed. Keep the remote private, avoid real transcript fixtures/secrets, use conventional commits without `Co-Authored-By`, and keep work split into reviewable units. Receipt-driven review mode is currently off and must remain off unless the user explicitly enables it.
