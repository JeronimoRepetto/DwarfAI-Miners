# AgentName

A floating desktop panel for Windows that visualizes AI coding agents running on this PC as
dwarfs working in mines. Each agent provider (Claude Code, Codex, ...) becomes a mine; each
running agent session becomes a dwarf digging in it.

Current status: **scaffold only** — window shell, tray, hotkey, config and tooling are in
place. Provider scanning (which processes/sessions feed the mines) is not implemented yet.

## Stack

Electron + electron-vite + Vue 3 + TypeScript, tested with Vitest, linted with ESLint +
Prettier, managed with pnpm.

## Dev quickstart

```powershell
pnpm install
pnpm dev
```

The window starts **hidden**. Bring it up with the global hotkey or the tray icon.

> pnpm 11 note: build scripts are allowed via `allowBuilds` in `pnpm-workspace.yaml`
> (`onlyBuiltDependencies` in package.json is ignored by pnpm 11). If
> `node_modules/electron/dist/electron.exe` is missing after install, run
> `pnpm rebuild electron`.

## Hotkey

**Ctrl+Alt+Shift+P** toggles panel visibility (registered globally at startup). If another
application already owns the combination, registration fails and a warning is logged — the
tray icon still toggles the panel.

The ✕ button and the window close event only **hide** the panel; the app keeps running in
the tray. Quit via the tray menu.

## Tray menu

- **Show/Hide Panel** — toggles the floating panel (clicking the tray icon does the same).
- **Start with Windows** — checkbox controlling autostart via the registry Run key
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, value `AgentName`. Default OFF;
  only this checkbox ever writes the key (dev runs never register silently).
- **Quit** — actually exits.

## Configuration

Copy `.env.example` to `.env`. All keys are optional; invalid values fail fast at startup.

| Variable            | Default | Meaning                                                                  |
| ------------------- | ------- | ------------------------------------------------------------------------ |
| `POLL_INTERVAL_MS`  | `2000`  | How often the provider scanner polls for agent activity (ms, int >= 1).  |
| `LIVENESS_WINDOW_S` | `90`    | How long an agent counts as alive after its last activity (s, int >= 1). |

## Scripts

| Script           | What it does                          |
| ---------------- | ------------------------------------- |
| `pnpm dev`       | Run the app with hot reload           |
| `pnpm build`     | Build main/preload/renderer to `out/` |
| `pnpm test`      | Run unit tests (Vitest)               |
| `pnpm lint`      | ESLint over the whole project         |
| `pnpm format`    | Prettier write                        |
| `pnpm typecheck` | Strict TS check (node + web projects) |

## Project structure

```
agent-name/
├── electron.vite.config.ts    # main/preload/renderer build config
├── vitest.config.ts
├── eslint.config.mjs
├── src/
│   ├── main/                  # Electron main process
│   │   ├── index.ts           # app lifecycle, IPC wiring
│   │   ├── window.ts          # frameless always-on-top panel window
│   │   ├── tray.ts            # tray icon + context menu
│   │   ├── shortcuts.ts       # global hotkey registration
│   │   ├── autostart.ts       # HKCU Run key enable/disable/isEnabled
│   │   ├── config.ts          # typed env config, fails fast
│   │   └── config.test.ts
│   ├── preload/
│   │   ├── index.ts           # contextBridge -> typed window.api
│   │   └── index.d.ts
│   └── renderer/              # Vue 3 app
│       ├── index.html
│       └── src/
│           ├── App.vue        # title bar (drag region + hide) and mines grid
│           ├── types.ts       # data shapes + defaultX() factories
│           └── composables/
│               └── useMines.ts # singleton mines store
└── pnpm-workspace.yaml        # allowBuilds for electron/esbuild (pnpm 11)
```

## Security posture

`contextIsolation: on`, `nodeIntegration: off`, a strict CSP in `index.html`, and a minimal
typed `window.api` exposed via `contextBridge`. External links open in the default browser.
