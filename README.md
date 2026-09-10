<p align="center">
  <img src="docs/assets/logo.png" width="160" alt="DwarfAI-Miners logo — the gold mine mound on a dark circular badge">
</p>

<h1 align="center">DwarfAI-Miners</h1>

<p align="center">
  Your AI coding sessions as a tiny isometric mining colony, floating on your desktop.
</p>

<p align="center">
  <img src="docs/media/hero01.gif" width="210" alt="Worker2">
  &nbsp;&nbsp;&nbsp;&nbsp;
  <img src="docs/media/hero.gif" width="100" paddin="10" alt="Foreman">
   &nbsp;&nbsp;
  <img src="docs/media/hero03.gif" width="100" alt="Foreman2">
  &nbsp;&nbsp;&nbsp;&nbsp;
  <img src="docs/media/hero02.gif" width="210" alt="Worker">
</p>

<div align="center">

[![CI](https://github.com/JeronimoRepetto/DwarfAI-Miners/actions/workflows/ci.yml/badge.svg)](https://github.com/JeronimoRepetto/DwarfAI-Miners/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/JeronimoRepetto/DwarfAI-Miners?style=flat-square)](https://github.com/JeronimoRepetto/DwarfAI-Miners/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/JeronimoRepetto/DwarfAI-Miners/total?style=flat-square)](https://github.com/JeronimoRepetto/DwarfAI-Miners/releases)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-4a5568?style=flat-square)
[![License: MIT](https://img.shields.io/badge/license-MIT-4a5568?style=flat-square)](LICENSE)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-support%20the%20project-FF5E5B?style=flat-square&logo=kofi&logoColor=white)](https://ko-fi.com/jeronimorepetto)

![Electron](https://img.shields.io/badge/Electron-47848F?style=flat-square&logo=electron&logoColor=white)
![Vue 3](https://img.shields.io/badge/Vue%203-4FC08D?style=flat-square&logo=vuedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Vitest](https://img.shields.io/badge/Vitest-6E9F18?style=flat-square&logo=vitest&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-F69220?style=flat-square&logo=pnpm&logoColor=white)

</div>

DwarfAI-Miners is a floating desktop panel that turns active AI coding sessions into mines and
dwarfs. A mine represents one project; workers and foremen represent the agents currently
operating in that project.

**Status:** functional MVP. Session detection for Claude Code, Codex and Antigravity; live IPC
updates; mine tiers; animated dwarfs; a floating message panel you can send into, kick from and
read history in; terminal focus with a transcript fallback; background music, mine ambience and
dwarf voices; autostart; and packaging are all implemented. Windows is the platform verified end
to end; macOS and Linux have been run on real hardware with lighter coverage — the
[support matrix](#platform-support) says which is which.

## Feature tour

The panel is designed to be understood at a glance: the map answers **where work is happening**, and
the mine answers **what each agent is doing**.

<table>
  <tr>
    <td align="center"><img src="docs/assets/feature-tour/map.png" width="260" alt="World map with tiered mine markers and a project tooltip"></td>
    <td align="center"><img src="docs/assets/feature-tour/mines.png" width="260" alt="Mines list with search, filters, sorting, and project cards"></td>
    <td align="center"><img src="docs/assets/feature-tour/mine.png" width="260" alt="Mine interior with dwarfs working and the message panel open"></td>
  </tr>
  <tr>
    <td align="center"><strong>Map</strong><br>See every active project at once.</td>
    <td align="center"><strong>Mines</strong><br>Search and open a project directly.</td>
    <td align="center"><strong>Mine interior</strong><br>Watch the crew and their status.</td>
  </tr>
  <tr>
    <td align="center"><img src="docs/assets/feature-tour/messages.png" width="260" alt="Message history panel with agent and user messages"></td>
    <td align="center"><img src="docs/assets/feature-tour/launch.png" width="260" alt="Launch panel choosing a supported AI provider"></td>
    <td align="center"><img src="docs/assets/feature-tour/settings.png" width="260" alt="Settings panel with shortcut and application preferences"></td>
  </tr>
  <tr>
    <td align="center"><strong>Messages</strong><br>Read history, send, kick, and answer questions.</td>
    <td align="center"><strong>Launch</strong><br>Start a session in a project mine, with a model and effort.</td>
    <td align="center"><strong>Settings</strong><br>Configure the shortcut, the panel's side, and sound.</td>
  </tr>
</table>

<!-- TODO(maintainer): the tour needs a capture of the message panel as its own floating window, dragged clear of the shell (#296). `messages.png` still shows the older docked panel. -->

The [art pipeline](docs/architecture.md#art-pipeline) explains how the shipped assets are
processed.

## Highlights

- **Live session detection** — Claude Code, Codex and Antigravity sessions become dwarfs the moment
  they appear, no configuration required.
- **Every worktree, one mine** — start a session in any git worktree of a project and it lands in
  that project's own mine, not a new one; a dwarf's message panel names which worktree it is
  actually in whenever a crew is spread across more than one.
- **Two illustrated views** — a world map that follows the time of day, with one tier-coloured
  marker per project, and a mine interior where the crew swings pickaxes, naps, or walks out.
- **A message panel that floats** — click a dwarf and its conversation opens in a window of its
  own, which you can drag anywhere on the desktop and which stays where you left it.
- **Send, with an honest verdict** — your message is drawn in the panel the instant you press
  Enter, and its own bubble carries the delivery mark: ✓ handed over, ✓✓ the session was seen
  acting, ✕ with the reason and a **Send again** beside it.
- **Markdown in bubbles** — an agent's bold text, lists, quotes, inline and fenced code draw as
  such instead of raw asterisks and backticks, and a link in a bubble opens in your system
  browser.
- **Kick in one click** — one press cuts a session's turn short. Where nothing can be interrupted,
  the same press sends the dwarf off the rock instead, and says so.
- **Sound** — eight shuffled background tracks, a mine ambience that follows whether the crew is
  actually mining, and a voice per dwarf rank on click plus the shell's own interface sounds. All
  of it optional, from [Settings](docs/guide.md#settings).
- **Panel motion** — pages and floating panels open and close in 250 ms, independent of display
  scale. The system's reduced-motion preference makes these transitions instantaneous.
- **Instant updates** — an opt-in Claude-hooks push channel turns the 2-second poll into tens of
  milliseconds.
- **Terminal focus** — clicking a dwarf focuses its terminal window, with a live transcript
  viewer as the fallback.
- **Autostart and tray** — starts at login, lives in the tray, and hides instead of closing.

Every screen and control is described in the [user guide](docs/guide.md).

## Install

Download the installer for your OS from the
[latest release](https://github.com/JeronimoRepetto/DwarfAI-Miners/releases/latest):

| Platform | File                                                          |
| -------- | ------------------------------------------------------------- |
| Windows  | `DwarfAI-Miners-Setup-*.exe` (installer) or `-Portable-*.exe` |
| macOS    | `DwarfAI-Miners-*.dmg` (arm64 or x64, matching your Mac)      |
| Linux    | `DwarfAI-Miners-*.AppImage` or the `.deb` package             |

Signing, honestly: **macOS installers are signed and notarized from v0.8.0 onward.** v0.7.0 and
earlier were not, which is what the macOS note below is about. Windows and Linux are never signed —
[`docs/signing.md`](docs/signing.md) records what is signed, what is not, and what fixing the rest
would take. So:

- **macOS**: an installer from v0.7.0 or earlier still gets blocked by Gatekeeper on a normal
  double-click. Right-click (or Control-click) the app and choose **Open**, then confirm in the
  dialog — only needed once — or clear the quarantine attribute:
  `xattr -cr "/Applications/DwarfAI-Miners.app"`. Neither is needed for a signed release.
- **Windows**: SmartScreen shows "Windows protected your PC" and an unverified publisher on a
  fresh machine. Click **More info** → **Run anyway**.
- **Linux**: make the AppImage executable before running it: `chmod +x DwarfAI-Miners-*.AppImage`.

Every release is built and packaged on the target OS. Windows is verified end to end; macOS and
Linux have been run with lighter coverage — see the support matrix below.

### First run

Launch DwarfAI-Miners and it will start minimized to the tray. Use **Ctrl+Alt+Shift+P** (or the
tray menu) to open the panel. Once packaged, the app enables start-at-login by default; you can
change that choice from the tray menu. The first run never sends session data anywhere — see
[Privacy](docs/privacy.md).

Three things worth knowing on that first run:

- **You need nothing to configure.** Start a Claude Code, Codex or Antigravity session in any
  project and its dwarf appears within about two seconds.
- **Music starts playing.** That is the shipped default; the note button at the bottom of the
  navigation column silences it for this run, and Settings' **Music at startup** is where you say
  it should stay off. See [Sound](docs/guide.md#sound).
- **The first few launches do a one-time history scan** of your existing transcripts, to fill the
  coal pile with the tokens you burned before installing this. It is bounded, resumable, and
  described in full in [`docs/privacy.md`](docs/privacy.md#the-one-time-history-scan).

## Run from source

```bash
pnpm install
pnpm dev
```

The panel starts hidden. Press **Ctrl+Alt+Shift+P** or click the tray icon to show it. The
combination is configurable: open the gear in the panel titlebar and record a new one. If
another application already owns a combination, registration fails, the previous shortcut is
re-claimed, and the settings panel says so rather than showing a shortcut that does nothing.

> pnpm 11 build scripts are allowed through `allowBuilds` in `pnpm-workspace.yaml`. If the
> Electron binary is missing after an interrupted install, run `pnpm rebuild electron`.

The checks CI runs, the testing philosophy and the rest of the contribution workflow are in
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Platform support

Every operating-system-specific behavior sits behind a port selected in one place
(`src/main/platform/platformAdapters.ts`), and each adapter's commands and file contents are
unit-tested as pure builders. macOS and Linux have been run on real hardware, but with far less
mileage than Windows, so the table keeps the distinction between verified and expected.

<details>
<summary><strong>Full support matrix</strong> (Windows verified; macOS/Linux run, lighter coverage)</summary>

| Capability                               | Windows                       | macOS                                  | Linux                                  |
| ---------------------------------------- | ----------------------------- | -------------------------------------- | -------------------------------------- |
| Overall                                  | **Verified**                  | Run, lighter coverage                  | Run, lighter coverage                  |
| Session detection (Claude Code / Codex)  | Verified                      | Expected to work (home-relative paths) | Expected to work                       |
| Antigravity session detection            | Verified                      | Expected to work (home-relative paths) | Expected to work                       |
| Codex liveness probe                     | PowerShell `Win32_Process`    | `pgrep -f codex`                       | `pgrep -f codex`                       |
| Click-to-focus a terminal                | user32 via PowerShell         | `ps` + System Events (`osascript`)     | **Unsupported** — falls back to viewer |
| Live transcript viewer                   | Windows Terminal / PowerShell | Terminal.app via `osascript`           | `x-terminal-emulator` → … → `xterm`    |
| Paste a message into a session's console | **Verified — the default**    | **Disabled** (relay instead)           | **Unsupported** (relay instead)        |
| Relay a message to a named session       | Supported — the fallback      | Supported — the default                | Supported — the default                |
| Queue a message to a Codex CLI session   | **Verified**                  | Expected to work (spawns `codex`)      | Expected to work (spawns `codex`)      |
| Start at login                           | HKCU Run key                  | `~/Library/LaunchAgents` plist         | `~/.config/autostart` desktop entry    |
| Packaging                                | NSIS + portable               | dmg + zip (arm64 & x64)                | AppImage + deb                         |

The two message rows are one decision seen from two sides, and it reversed twice —
[`docs/console-hosting.md` §4b](docs/console-hosting.md) records both reversals. Where the panel
can reach a console (Windows today), a message goes on the clipboard, the console comes forward and
**Ctrl+V pastes the whole thing at once**, so it arrives as your own prompt in well under a second;
the clipboard is put back afterwards. Where it cannot (macOS, Linux), a Claude session with a
registry name takes the relay instead, which touches no window at all. The relay is also the
fallback on Windows, and only for the one failure that proves nothing was written: a console that
would not come forward. An interrupt (Kick) never moved — it is a keystroke by nature, and goes to
the console wherever one exists.

Notes on the three honest gaps:

- **Linux window focus** is unsupported on purpose. `wmctrl`/`xdotool` are X11-only, absent by
  default, and blocked outright under Wayland; guessing would mean hanging on a tool that is not
  there. Clicking a dwarf goes straight to the transcript viewer instead.
- **macOS console input** is implemented (`osascript` + System Events) and unit-tested, but it is
  gated off behind the `DARWIN_CONSOLE_INPUT_ENABLED` constant in
  `src/main/platform/platformAdapters.ts` — it also needs the user to grant Accessibility
  permission, which the app cannot detect. While it is off, a session with a registry name still
  takes the relay, and one without gets a Send and a Kick rendered disabled with their reason
  rather than silently typing nowhere. A per-OS paste path for macOS and Linux is a follow-up, not
  a gap in this one.
- **Session-data layouts** (`~/.claude`, `~/.codex`, `~/.gemini/antigravity-cli`) are assumed
  platforms. They are home-relative already and nothing in the formats is Windows-specific, but
  this has not been confirmed against real macOS/Linux fixtures.

</details>

## Provider support

Three questions get three separate answers, because they are three different bars: can this app
**read** a provider's sessions, can it **launch** one, and can it **hold** one open so its words
arrive live.

| Provider    | Read | Launch | Hold   | Notes                                                                                                                                                                                                                                                                                                                                                                          |
| ----------- | ---- | ------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code | yes  | yes    | yes    | Uses `~/.claude*/sessions/<pid>.json`, verifies a live PID, and reads parent/subagent transcripts. Multiple Claude roots are supported. The one provider with a complete held-session surface: interrupt, context reading, and answers to its own question and permission prompts.                                                                                             |
| Codex       | yes  | yes    | no     | Uses the `state_5.sqlite` registry, `logs_2.sqlite` heartbeats, rollout growth and open-turn events; mtime is the last resort, never the lead (#1). `thread_spawn.parent_thread_id` gives verified worker/foreman relationships. A launch is detached — `codex exec` in the mine's folder, discovered afterwards by the poll. Messages go to Codex's own queue.                |
| Antigravity | yes  | yes    | partly | Reads the `agy` CLI's own store under `~/.gemini/antigravity-cli`: a presence lock per running conversation, `history.jsonl` for the workspace, and the conversation's `transcript.jsonl` for the feed and for whether a turn is open. A held `agy` session can be spoken to; see [Providers in depth](docs/guide.md#providers-in-depth) for what its protocol does not offer. |

Each provider's limits, effort levels and how foremen and workers are told apart are in the
[user guide](docs/guide.md#providers-in-depth).

## Configuration

Everything below is optional — the defaults work out of the box. **Which mechanism you use
depends on how you are running DwarfAI-Miners**, because `dotenv` resolves `.env` relative to the
working directory, and an installed app never runs from this repository.

| How you run it                    | Where settings go                                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Development checkout (`pnpm dev`) | Copy `.env.example` to `.env` in the repo root.                                                                                      |
| Installed app                     | A `config-v1.json` file in the app's user-data directory (see the [configuration reference](docs/guide.md#configuration-reference)). |

Settings are resolved most specific first: **real environment variables → the user-data config
file → built-in defaults.** A real environment variable therefore always wins, on either setup,
and a development checkout with a `.env` behaves exactly as it always has.

The config file's location per platform, every setting with its default, and the diagnostic
switches are in the [configuration reference](docs/guide.md#configuration-reference).

## Reporting a problem

- **Bugs, features and roadmap** → [GitHub issues](https://github.com/JeronimoRepetto/DwarfAI-Miners/issues).
  Name your platform, the version the Settings panel shows (the `-dev` suffix matters), and how to
  reproduce it. Check your platform's row in the [support matrix](#platform-support) first — a
  row marked expected rather than verified is often the whole explanation.
- **Vulnerabilities** → privately, through the flow in [`SECURITY.md`](SECURITY.md). Never a public
  issue.
- **Questions about what the app reads or stores** → [`docs/privacy.md`](docs/privacy.md) answers
  those with the source file behind each claim.

If you run macOS or Linux, the single most useful thing you can file is what happened when you
walked the support matrix on real hardware — including "it all worked". See
[CONTRIBUTING.md](CONTRIBUTING.md#platform-validation--help-wanted).

## Documentation

**Start here:**

- [`docs/guide.md`](docs/guide.md) — every screen and control, the message panel, sound, settings,
  the hooks channel, and the full configuration reference.
- [`docs/architecture.md`](docs/architecture.md) — how main, preload and renderer fit together, the
  platform ports, security posture, the art pipeline and packaging.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — development setup, verification commands, testing
  philosophy, commit conventions, and where help is wanted.
- [`SECURITY.md`](SECURITY.md) — supported versions, private vulnerability reporting, scope.
- [`docs/privacy.md`](docs/privacy.md) — the data boundary: what the app reads, stores, and
  transmits.
- [`docs/signing.md`](docs/signing.md) — what is signed, what is not, and what fixing the rest
  takes.
- [`docs/README.md`](docs/README.md) — **the index to every other document in `docs/`**, including
  the provider-format research, the design and evaluation notes, and the measurement records.

- [`LICENSE`](LICENSE) — MIT license for the code.
- [`ARTWORK-LICENSE.md`](ARTWORK-LICENSE.md) — proprietary terms for the project's visual and
  audio assets.

## Support the project

DwarfAI-Miners' code is free and MIT-licensed. The artwork remains the creator's property and is
not separately reusable without authorization. If the project has earned a spot on your desktop,
you can support its development on [Ko-fi](https://ko-fi.com/jeronimorepetto). Entirely optional —
nothing in the app is, or will be, gated on it.

## License

[MIT](LICENSE) © 2026 Jeronimo Repetto — code only. The visual and audio assets are protected by
copyright and covered separately by [`ARTWORK-LICENSE.md`](ARTWORK-LICENSE.md); they may not be
reused without prior written authorization.
