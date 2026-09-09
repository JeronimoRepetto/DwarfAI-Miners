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
dwarf voices; autostart; and packaging are all implemented. Windows is the verified platform;
macOS and Linux build and are unit-tested but have not been run end to end yet — see the
[support matrix](#platform-support) below.

## The bigger picture

DwarfAI-Miners is growing toward an **idle game for AI agents**: your agents work in the mines,
you watch the colony develop, and you step in when a session needs direction. The project is
intended to make working with agents feel both useful and alive — part control room, part
observer, and eventually part game.

### What it is today

- **Observer:** reads the session data Claude Code, Codex and Antigravity already write locally and
  turns projects, agents, status, messages, and mined materials into a living colony.
- **Control surface:** lets you launch supported sessions, choose their model and effort, focus
  their external terminal, open a live transcript viewer, send messages, kick work, and answer
  agent questions.
- **Terminal companion:** it works alongside the provider's terminal rather than replacing it with
  a terminal emulator. The panel is already the interactive surface for the actions it supports;
  the underlying provider still owns the actual process and terminal.

All three providers can be **read** and **launched**; how far past that the panel can go differs
per provider, and the [provider table](#provider-support) below is the detail. More providers can
be added once their session artifacts and interaction paths meet the project's verification bar.

### Where it is going

Once the provider integrations and core interaction model are complete, the **Laboratory** and
**Market** will turn the colony's mined materials into game systems. The planned direction is to
use the Lab to change dwarf skins and other cosmetic loadouts, and the Market to spend the raw
materials the agents mine. Those systems are intentionally not shipped yet: both screens currently
show an unavailable state, while the material ledger provides the foundation for the future
economy.

The goal is not to make agent work less trustworthy by hiding it behind game mechanics. The game
layer should make real agent activity easier and more enjoyable to understand — an idle game built
around work that is actually happening.

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

Every capture and animation here uses generic, privacy-safe content — no real project names, paths
or session data — and some predate features described below: the message panel is a floating window
of its own now, and Settings has gained an Audio section. The pixel-art assets and interface design
are by Jeronimo Repetto; the [art pipeline](CONTRIBUTING.md#artwork) explains how the shipped assets
are processed.

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
  of it optional, from [Settings](#settings).
- **Panel motion** — pages and floating panels open and close in 250 ms, independent of display
  scale. The system's reduced-motion preference makes these transitions instantaneous.
- **Instant updates** — an opt-in Claude-hooks push channel turns the 2-second poll into tens of
  milliseconds.
- **Terminal focus** — clicking a dwarf focuses its terminal window, with a live transcript
  viewer as the fallback.
- **Autostart and tray** — starts at login, lives in the tray, and hides instead of closing.

Platform caveats apply — the [support matrix](#platform-support) below is honest about what is
verified versus built and unit-tested only.

## Install

Download the installer for your OS from the
[latest release](https://github.com/JeronimoRepetto/DwarfAI-Miners/releases/latest):

| Platform | File                                                          |
| -------- | ------------------------------------------------------------- |
| Windows  | `DwarfAI-Miners-Setup-*.exe` (installer) or `-Portable-*.exe` |
| macOS    | `DwarfAI-Miners-*.dmg` (arm64 or x64, matching your Mac)      |
| Linux    | `DwarfAI-Miners-*.AppImage` or the `.deb` package             |

Signing, honestly: the Developer ID signing and notarization config is wired into `package.json`
and CI's macOS release job, so **macOS installers are signed and notarized from the first release
tagged after that change** — which is any release later than v0.7.0. It has not yet been exercised
end to end; [`docs/signing.md`](docs/signing.md) carries the checklist the first such tag has to
pass. Windows and Linux are never signed. So:

- **macOS**: an installer built before that change — v0.7.0 and earlier — still gets blocked by
  Gatekeeper on a normal double-click. Right-click (or Control-click) the app and choose **Open**,
  then confirm in the dialog — only needed once — or clear the quarantine attribute:
  `xattr -cr "/Applications/DwarfAI-Miners.app"`. Neither is needed for a signed release.
- **Windows**: SmartScreen shows "Windows protected your PC" and an unverified publisher on a
  fresh machine. Click **More info** → **Run anyway**.
- **Linux**: make the AppImage executable before running it: `chmod +x DwarfAI-Miners-*.AppImage`.

Every release is built and packaged on the target OS, but Windows is the only platform that has
been run end to end — see the support matrix below for exactly what is verified versus built and
unit-tested only.

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
  it should stay off. See [Sound](#sound).
- **The first few launches do a one-time history scan** of your existing transcripts, to fill the
  coal pile with the tokens you burned before installing this. It is bounded, resumable, and
  described in full in [`docs/privacy.md`](docs/privacy.md#the-one-time-history-scan).

## Quick start

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

CI (`.github/workflows/ci.yml`) runs seven checks on every push to `main` and on every pull
request: privacy guard, typecheck, lint, format check, skills-sync check, tests, and build.

## Platform support

Every operating-system-specific behavior sits behind a port selected in one place
(`src/main/platform/platformAdapters.ts`), and each adapter's commands and file contents are
unit-tested as pure builders. What has _not_ happened is running those commands on a real Mac
or Linux desktop, so the table is honest about the difference.

<details>
<summary><strong>Full support matrix</strong> (Windows verified; macOS/Linux built, integration-pending)</summary>

| Capability                               | Windows                       | macOS                                  | Linux                                  |
| ---------------------------------------- | ----------------------------- | -------------------------------------- | -------------------------------------- |
| Overall                                  | **Verified**                  | Built, integration-pending             | Built, integration-pending             |
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
  `src/main/platform/platformAdapters.ts` until it has been run on a real Mac — it also needs the
  user to grant Accessibility permission, which the app cannot detect. While it is off, a session
  with a registry name still takes the relay, and one without gets a Send and a Kick rendered
  disabled with their reason rather than silently typing nowhere. A per-OS paste path for macOS
  and Linux is a follow-up, not a gap in this one.
- **Session-data layouts** (`~/.claude`, `~/.codex`, `~/.gemini/antigravity-cli`) are assumed
  platforms. They are home-relative already and nothing in the formats is Windows-specific, but
  this has not been confirmed against real macOS/Linux fixtures.

</details>

## What the panel shows

The panel docks against one screen edge as a thin rail; the arrow on the rail slides it open. Along
its outer edge sits the app mark — pressing it takes the window away, exactly as the global
shortcut does — and under that a column of **five areas**, plus a note button at the bottom for the
music:

| Area         | What it is                                                                        |
| ------------ | --------------------------------------------------------------------------------- |
| **Settings** | The shortcut, the panel's side, sound, the metrics wipe, and the running version. |
| **Map**      | The default view: every project with a live session, at a glance.                 |
| **Mines**    | The searchable list of projects, with tier filters and a sort by last activity.   |
| **Lab**      | Planned. Shows an unavailable state today.                                        |
| **Market**   | Planned. Shows an unavailable state today.                                        |

An **opened mine** is not a sixth area. It sits beside whichever area is selected, which is why you
can browse the Mines list and watch a crew at the same time.

**Map view (default).** An illustrated world seen from orbit, in one of four paintings chosen by
your own clock — morning (07:00–11:59), day (12:00–16:59), sunset (17:00–19:59) and night
(20:00–06:59), re-read once a minute. Every project with an observed AI CLI session appears on one
of the map's 74 spawn locations as a pulsing hexagon coloured by tier: Bronze (cyan), Copper
(orange-brown), Silver (grey), Gold (yellow), Uranium (green). A project is assigned a free
location at random the first time the app sees it and that location is remembered, so a mine never
moves — not between refreshes and not across restarts. Resting the pointer on a marker for a moment
shows its tier, the project name and how many agents are working in it; clicking enters the mine.

**Mines view.** The same projects as a list of cards, ten at a time. A search box matches on the
project name, a chip row filters to one tier (**All** is the only chip an unmeasured project
appears under), and the date control flips the order by last activity. A card can also **remove**
its mine — which hides the row and nothing else: the ore stays, and adding the folder again brings
the mine back. That is why removal asks a plain confirmation rather than the typed word Settings'
irreversible metrics wipe asks for. Picking a folder that turns out to be a **git worktree** does
not add it as its own mine — see [Git worktrees](#git-worktrees) below.

**Mine interior.** The cave art for that tier, with the crew standing on the walkable floor along
the bottom, the vault's material chip in the corner, and four round controls: **close**, **history**
and **add** on the right, and the **ambience mute** alone at the top left. Each agent is a dwarf
animated by swapping poses:

- **working** alternates two pickaxe swings,
- **waiting** sits still on one resting pose beneath a drifting "z z z",
- **leaving** alternates two walking poses, mirrored toward the exit, fading during the
  runtime grace window,
- the **foreman** stands apart and looks up from his log book now and then.

The provider is shown by a small badge on the sprite rather than by tinting the art.
Hovering a dwarf shows name, provider, model, effort, and status. When an agent's last
message changes, a comic speech bubble appears above it for a few seconds.

Selecting a dwarf opens its [message panel](#the-message-panel), and — for a session this panel is
holding open — a **session strip** along the interior's lower edge, showing that session's model,
context window and MCP roster. Where the session's own protocol allows it (Claude Code today), the
model and effort can be changed from the same line, which is the point of putting the control beside
the reading that proves it changed: until the session's next `init` names the new value, the strip
says _pending_ rather than claiming the change landed. A session the panel only observes gets no
strip at all — there is nothing first-hand to put on it, and drawing one disabled said less than
drawing none.

### The message panel

Clicking a dwarf opens its conversation in **a window of its own** — not a page inside the panel.
It arrives docked beside the shell, and from there you can drag it anywhere on the desktop: closing
it, reopening it, or restarting the app brings it back where you left it, so it can sit beside your
editor while the shell stays on its edge. If the spot you left it in no longer exists — a monitor
unplugged, a resolution change — it comes back beside the shell rather than off-screen.

What is in it:

- **The conversation**, oldest first, opening on the newest message. It does not resize itself when
  a message arrives, and it does not scroll you to the bottom mid-sentence — the exception being a
  message you just sent, which it does follow.
- **Markdown, in agent and person bubbles alike.** Paragraphs, emphasis, lists, block quotes,
  inline code, fenced code and links draw as such instead of the raw `**`, `-` and backtick
  characters, with a heading drawn as a bold paragraph rather than at heading size — a bubble is
  not a page. Tables, strikethrough, horizontal rules and images are outside that vocabulary and
  are shown as the plain characters that were written, on purpose, rather than an invented
  drawing; raw HTML is never interpreted. A link opens in your system browser and never inside the
  panel. Conversation text is set in a different typeface (Pixelify Sans) from the rest of the
  interface (Tiny5), since a paragraph needs a bold weight a single-weight pixel font cannot draw.
- **A composer.** Enter sends, Shift+Enter writes a newline. It is drawn disabled, with the reason
  on it, whenever the session cannot receive text.
- **Runs of tool calls, folded.** A stretch of consecutive activity lines collapses into one
  **Working…** disclosure under the bubble above it; click to unfold. Unfolding one never moves the
  list. An `edit` or `read` line's own path is clickable and opens that file — in that dwarf's own
  git worktree, when it is working in one rather than the project's main folder.
- **Which worktree it's in**, beside the dwarf's name in the header, whenever a project's crew is
  spread across more than one git worktree: the branch it has checked out, or the worktree's
  folder name if its checkout is detached. Nothing is shown for a dwarf working in the project's
  own folder, which is most of them — see [Git worktrees](#git-worktrees) below.
- **Question and permission cards**, directly above the composer, when the session is blocked on a
  human. They are cleared only by the session's next snapshot, never by the panel.
- **A history tab**, which expands the panel to full height and back.
- **Kick** and **close**, plus a **jump to terminal** control where one exists.
- **Boost**, which is drawn and permanently disabled, saying so and naming the session's current
  effort. No provider exposes a channel for raising effort mid-turn, and the panel shows the slot
  with its reason rather than hiding it. Effort on a held Claude session is changed from the mine's
  session strip instead.

The panel resizes by dragging its top edge, or with the arrow keys on that handle.

### Sending a message to a session

<!-- TODO(maintainer): screenshot of a message bubble carrying its ✓/✓✓ delivery mark, and one showing a folded "Working..." disclosure — docs/assets/feature-tour/messages.png predates both (#309, #294). -->

Press Enter and **the message is drawn in the panel immediately**, as your own bubble, before
anything has been delivered. The bubble then carries what actually happened to those words:

| Mark | Means                                                                                       |
| ---- | ------------------------------------------------------------------------------------------- |
| `…`  | Being delivered.                                                                            |
| `✓`  | Handed to the session — it reached the queue or the console, and the panel is now watching. |
| `✓✓` | The session was **seen acting** on it.                                                      |
| `✕`  | Not delivered, with the reason. **Send again** appears beside it; the ✕ stays where it is.  |

`✓` and `✓✓` are deliberately different facts, and the panel never promotes one to the other on a
guess: it watches for up to a minute, and a watch that closes without proof stays at "handed over,
no reaction seen" rather than claiming a reaction.

Which channel carries it depends on the session, not on a preference:

| The session…                              | Message goes by                                                              |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| runs in a console the panel can reach     | **clipboard paste** into that console; the relay if it will not come forward |
| is a named Claude session with no console | Claude Code's own cross-session messaging (`claude -p` relay)                |
| is a Codex CLI session                    | Codex's own message queue, read between turns                                |
| is one this panel is **holding** open     | straight onto the stream the panel already owns                              |
| was launched with a single prompt         | nothing — it has no inbox, and the composer says so                          |

The per-platform half of that is the [support matrix](#platform-support); the reasoning behind both
reversals of the paste-versus-relay order is [`docs/console-hosting.md`](docs/console-hosting.md).
A message to a worker is delivered to its foreman, tagged for that worker by name.

**Kick** does one of three things, and says which:

- cuts the current turn short, where the session has an interrupt channel;
- **ends the process**, for a session this panel launched itself;
- **sends the dwarf off the rock**, where nothing can be interrupted at all — the board stops
  showing it, and nothing is asked of the session. It comes back the moment that session shows new
  activity, which the panel tells you, because otherwise the return reads as a bug.

### Focusing a session's terminal

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

### Git worktrees

Running several agents on one codebase from several `git worktree` checkouts no longer produces
several mines. Every worktree of a repository is detected — from the `.git` file a worktree
checkout carries, with no `git` binary needed — and folded into the **main working tree's** mine,
so the map shows one project rather than one per open worktree, and the material vault credits
that one mine rather than splitting the total across several.

Each dwarf still knows exactly where its own session runs: its [message panel](#the-message-panel)
header names the branch beside its name (or the worktree's folder, if its checkout is detached),
and an `Edited <path>` line opens that file in the worktree the dwarf is actually in rather than in
the project's main folder. Nothing is shown for a dwarf working in the project's own folder, which
is most of them.

Adding a folder from the [Mines list](#what-the-panel-shows) that turns out to be a worktree does
not declare it as a separate mine. Instead a dialog names the project it belongs to and asks
whether to open that project's mine instead — opening the worktree itself is not offered, since the
board would fold it in anyway.

Two kinds of folder are deliberately **not** folded: a git submodule, and a bare repository's own
checkout. Both are shown as their own project, exactly as before.

### Art pipeline

The renderer ships processed art in `src/renderer/src/assets/art/` — committed, so a clone
builds and runs without the source images. `pnpm art:build` regenerates it from the
originals: AI-generated, opaque high-resolution files delivered by the product owner, which
live outside the repository (default `<home>/Downloads/DwarfAI-Miners`, overridable with
`--src <dir>` or `DWARFAI_MINERS_ART_SRC`) and are never modified. The script itself is
platform-neutral: every path goes through `node:path`.

The script chroma-keys the dwarf and mound images off their flat backdrop — sampling the
key color from each image's own four corners, because it differs per image — crops all nine
dwarf poses to one shared canvas so animation frames never jitter, and downscales the opaque
background scenes. Its pure helpers are unit tested in `scripts/art/keying.test.mjs`.

### Application icon

Same idea as the art pipeline: committed, derived output, regenerated by a script rather than
hand-edited. `pnpm icons` (`scripts/build-icons.mjs`) composites `mound-gold.png`
onto a dark circular badge — a strong, high-contrast silhouette is what actually survives being
shrunk to a 16x16 tray icon — and writes every size electron-builder and the app itself need:
`build/icon.ico` (Windows, multi-size), `build/icon.icns` (macOS), `build/icon.png` (Linux, 512),
and `resources/tray-icon.png` / `tray-icon@2x.png` / `app-icon.png` for the tray and window icons
at runtime. The badge math is unit tested in `scripts/art/badge.test.mjs`; running the script
twice in a row reproduces every output file byte-for-byte. The README logo
(`docs/assets/logo.png`) is a committed copy of that same `build/icon.png`.

## Provider support

Three questions get three separate answers, because they are three different bars: can this app
**read** a provider's sessions, can it **launch** one, and can it **hold** one open so its words
arrive live.

| Provider    | Read | Launch | Hold   | Notes                                                                                                                                                                                                                                                                                                                                                           |
| ----------- | ---- | ------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | yes  | yes    | yes    | Uses `~/.claude*/sessions/<pid>.json`, verifies a live PID, and reads parent/subagent transcripts. Multiple Claude roots are supported. The one provider with a complete held-session surface: interrupt, context reading, and answers to its own question and permission prompts.                                                                              |
| Codex       | yes  | yes    | no     | Uses the `state_5.sqlite` registry, `logs_2.sqlite` heartbeats, rollout growth and open-turn events; mtime is the last resort, never the lead (#1). `thread_spawn.parent_thread_id` gives verified worker/foreman relationships. A launch is detached — `codex exec` in the mine's folder, discovered afterwards by the poll. Messages go to Codex's own queue. |
| Antigravity | yes  | yes    | partly | Reads the `agy` CLI's own store under `~/.gemini/antigravity-cli`: a presence lock per running conversation, `history.jsonl` for the workspace, and the conversation's `transcript.jsonl` for the feed and for whether a turn is open. A held `agy` session can be spoken to; see the paragraph below for what its protocol does not offer.                     |
| Gemini CLI  | no   | no     | no     | Planned. No Gemini CLI session artifacts were available for verification. The local `.gemini` data belongs to Antigravity and is intentionally not parsed.                                                                                                                                                                                                      |

Codex liveness is heuristic: a recently modified rollout can remain visible until the
configured liveness window expires after the CLI closes.

**Antigravity is narrower than the other two, and every limit is an absence of evidence rather
than an unbuilt feature.** Its CLI keeps a private on-disk format with no compatibility promise.
A session the panel launched and is holding can be spoken to, and can be launched with a model and
one of Antigravity's own three effort levels (low, medium, high) — but the protocol's input side
carries user text and nothing else: it documents no turn cancellation, no context reading and no
mid-session model or effort change, so a held Antigravity session offers none of those and answers
no question or permission prompt. The panel therefore says "this protocol has no cancel" rather
than "the interrupt was refused". An _observed_ Antigravity conversation — one you started
yourself in a terminal — records no token usage and no blocked-on-a-human state, and nothing ties a
running `agy` process to a particular conversation: so its dwarf mines no ore, is never shown as
blocked, and cannot have its terminal focused. Its transcript can still be tailed in a terminal.
`docs/provider-formats.md` §3.1 records the format and the version it was verified against.

A session started from the panel's Add panel can also carry a **model and an effort level**. The
effort levels are each CLI's own documented set, not one shared list — Claude Code accepts `low`,
`medium`, `high`, `xhigh` and `max`; Codex those five plus `ultra`, which is Codex's alone;
Antigravity only `low`, `medium` and `high` — and a level a CLI does not have is refused outright
rather than quietly dropped, because a launch that discarded `max` would start a real session at the
CLI's default and report success. Model names are never hardcoded here: each provider's
catalogue is read live from that CLI. For a Claude session the panel is holding, the same model and
effort can be changed later, from the session strip in the mine.

For Claude, the main session dwarf is always the foreman — it is the orchestrator whether or
not it currently has subagents out — and subagents are always workers. A subagent leaves the
crew as soon as its `<task-notification>` reports `completed`, `failed` or `killed`, and
DwarfAI-Miners remembers that so an agent whose notification later scrolls out of the transcript
tail can never come back as a ghost. Codex promotion still comes from a verified
`thread_spawn` parent link.

## Sound

Three independent channels, all off one engine:

- **Music.** Eight background tracks, shuffled — nothing plays them in the order they are declared.
  The note button at the bottom of the navigation column starts and stops them **for this run**;
  Settings' **Music at startup** is the separate statement about what should happen tomorrow.
  Silencing the music for one meeting is not a preference, which is why the button persists nothing.
- **Mine ambience.** Two beds, and which one plays is a reading of the crew currently on screen:
  picks on rock while a worker is producing tokens, and the quiet bed otherwise. A mine holding only
  a foreman hears the quiet one — a foreman is not a worker. The round **mute** at the interior's
  top-left corner silences the ambience alone, also for this run.
- **Effects.** One recording per dwarf rank, played when you click a dwarf, plus the shell's own
  interface sounds — a click on the five navigation buttons and a sound when the side panel opens
  and closes. One channel, one volume: a rank with no recording is simply silent rather than
  borrowing another rank's voice, and the same is true of an interface action with no sound of its
  own.

All of it stops while the window is away — hidden, minimised, or sent to the tray — and the music
alone survives the shell being collapsed to its rail. Nothing a media element refuses ever reaches
the rest of the app: a machine with no audio pipeline at all shows the same map, mines and crew it
always did.

The three volumes and the startup switch live in [Settings](#settings). Audio assets are the
maintainer's own and are covered by [`ARTWORK-LICENSE.md`](ARTWORK-LICENSE.md), not by the code's
MIT license.

## Settings

Reached from the top button of the navigation column. Four sections and a small group of
application controls:

| Section            | What it holds                                                                                                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Panel shortcut** | Record a new global toggle combination, or reset it to **Ctrl+Alt+Shift+P**. If another application already owns the one you record, registration fails, the previous shortcut is re-claimed, and this section says so rather than showing a shortcut that does nothing. |
| **Position**       | Which screen edge the docked shell opens on — left or right. Right by default.                                                                                                                                                                                           |
| **Audio**          | **Music at startup** (on by default), plus a volume slider each for **Music**, **Ambience** and **Effects**. They start at 10%, 100% and 70%. See [Sound](#sound).                                                                                                       |
| **Data Base**      | **Reset metrics** — the one irreversible action in the app. It wipes the material vault, behind a confirmation that makes you type `yes`.                                                                                                                                |
| _Application_      | **Always on top**, **Hide panel**, and the running version.                                                                                                                                                                                                              |

The version is the release number for an installed build, and the same number with a `-dev` suffix
when the app was started from a checkout. Those four characters are the point of it: both report the
same number, and a bug report that does not say which was being run has already been misdiagnosed
once. Hovering spells it out in words. If main cannot answer, no version is shown at all rather than
a guessed one.

<!-- TODO(maintainer): screenshot of the Settings screen including the Audio section — docs/assets/feature-tour/settings.png predates it (#174). -->

Settings is where the app's own preferences live. It is not where operational
[configuration](#configuration) goes: a volume is something you set in the app, a poll interval is
something an operator configures, and the two are stored differently on purpose.

## Startup and tray behavior

- Packaged builds enable autostart on the first successful launch (the tray item reads **Start
  with Windows** on Windows and **Start at login** elsewhere).
- A marker in Electron's user-data directory prevents later launches from overriding a tray
  opt-out.
- Development runs never write an autostart entry or the marker.
- Closing the panel hides it; **Quit** in the tray exits the process.
- On macOS the app hides its Dock tile: it lives in the menu bar, and its only window is the
  floating panel.

<details>
<summary><strong>Where the autostart entry is written</strong>, per platform</summary>

| Platform | Location                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------- |
| Windows  | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, value `DwarfAI-Miners`                      |
| macOS    | `~/Library/LaunchAgents/com.jeronimorepetto.dwarfaiminers.plist` (`RunAtLoad`, `KeepAlive=false`) |
| Linux    | `$XDG_CONFIG_HOME/autostart/dwarfai-miners.desktop`, defaulting to `~/.config/autostart/`         |

Only Windows has a migration to run: existing installs move automatically on first launch after
the update — the legacy `AgentName` Run value is removed, and the new value is written only if
autostart was on. No macOS or Linux build shipped before the rename, so there is nothing to
migrate there.

</details>

## Instant updates (Claude hooks)

Off by default, opt-in from the tray: **Instant updates (Claude hooks)**. It adds a push
channel on top of the 2-second poller so a session appearing, a turn ending or a subagent
finishing shows up in tens of milliseconds instead of on the next poll.

Turning it on does three things, and turning it off undoes all three:

1. Binds a loopback HTTP listener on `127.0.0.1:HOOKS_PORT` (47821 by default). Loopback only —
   it is never reachable from the network.
2. Writes one hook entry per event into `settings.json` in every configured Claude root, for
   `SessionStart`, `Notification`, `Stop`, `SubagentStop` and `SessionEnd`. The command is a
   one-line curl invocation — `curl.exe` on Windows to bypass PowerShell's alias, plain `curl`
   elsewhere — that forwards the hook's own JSON to the listener and exits; Windows 10 1803+
   ships `curl.exe`, and enabling refuses with an explanation if it is missing.
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

Everything below is optional — the defaults work out of the box. **Which mechanism you use
depends on how you are running DwarfAI-Miners**, because `dotenv` resolves `.env` relative to the
working directory, and an installed app never runs from this repository.

| How you run it                    | Where settings go                                                     |
| --------------------------------- | --------------------------------------------------------------------- |
| Development checkout (`pnpm dev`) | Copy `.env.example` to `.env` in the repo root.                       |
| Installed app                     | A `config-v1.json` file in the app's user-data directory (see below). |

Settings are resolved most specific first: **real environment variables → the user-data config
file → built-in defaults.** A real environment variable therefore always wins, on either setup,
and a development checkout with a `.env` behaves exactly as it always has.

### Configuring an installed app

Create `config-v1.json` next to the app's other preference files, in the user-data directory:

| Platform | Path                                                          |
| -------- | ------------------------------------------------------------- |
| Windows  | `%APPDATA%\DwarfAI-Miners\config-v1.json`                     |
| macOS    | `~/Library/Application Support/DwarfAI-Miners/config-v1.json` |
| Linux    | `~/.config/DwarfAI-Miners/config-v1.json`                     |

It is a flat JSON object whose keys are the variable names from the table below. Values may be
strings or numbers, so both spellings below work:

```json
{
  "CLAUDE_CONFIG_DIRS": "~/.claude;~/.claude-work",
  "TIER_COPPER_KB": 200
}
```

Restart the app to pick up changes. A missing or corrupt file is ignored and the app starts on
defaults, so it is safe to delete if you want to start over. An invalid _value_ — a port of
`70000`, tier thresholds out of order — fails fast at startup with the same message it would
produce as an environment variable, rather than being silently ignored; setting the same key as a
real environment variable overrides the file if you ever need to start the app without editing it
first.

<details>
<summary><strong>All settings</strong> (defaults work out of the box)</summary>

Use these names as `.env` keys in a development checkout, and as JSON keys in the config file
above for an installed app.

| Variable                          | Default                     | Meaning                                                                                               |
| --------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------- |
| `POLL_INTERVAL_MS`                | `2000`                      | Provider scan interval in milliseconds.                                                               |
| `LIVENESS_WINDOW_S`               | `90`                        | Reserved general activity window.                                                                     |
| `CODEX_LIVENESS_WINDOW_S`         | `300`                       | Maximum rollout mtime age considered live.                                                            |
| `CODEX_HEARTBEAT_WINDOW_S`        | `300`                       | How recent a `logs_2.sqlite` row must be to count as a liveness heartbeat.                            |
| `CODEX_SCAN_DAYS`                 | `7`                         | How many day-directories (today back N-1 days) to scan for rollouts.                                  |
| `CODEX_IDLE_RETENTION_S`          | `3600`                      | Extra time a quiet-but-open rollout stays visible while a codex process is running.                   |
| `CODEX_SESSIONS_ROOT`             | `~/.codex/sessions`         | The Codex rollout directory to scan. A leading `~` is expanded.                                       |
| `CODEX_STATE_DB`                  | `~/.codex/state_5.sqlite`   | Codex's thread registry, opened read-only. Missing file: rollout-only detection.                      |
| `CODEX_LOGS_DB`                   | `~/.codex/logs_2.sqlite`    | Codex's structured log stream, used read-only as a liveness heartbeat.                                |
| `ANTIGRAVITY_STORE_ROOT`          | `~/.gemini/antigravity-cli` | The Antigravity CLI (`agy`) store to observe. A leading `~` is expanded.                              |
| `ANTIGRAVITY_BUSY_WINDOW_S`       | `120`                       | How recent a still-`RUNNING` transcript step must be to count as an open turn.                        |
| `ANTIGRAVITY_LOCK_GRACE_S`        | `30`                        | How long a conversation survives its presence lock no longer being listed.                            |
| `ANTIGRAVITY_STALE_LOCK_WINDOW_S` | `86400`                     | How silent a locked conversation may be before its lock is read as stale.                             |
| `DWARF_LEAVE_GRACE_S`             | `20`                        | How long a dwarf whose agent finished/disappeared stays visible as "leaving".                         |
| `TIER_CACHE_TTL_S`                | `600`                       | Mine-tier cache lifetime.                                                                             |
| `TIER_COPPER_KB`                  | `100`                       | Source-code byte-weight threshold for copper, in KB.                                                  |
| `TIER_SILVER_KB`                  | `500`                       | Source-code byte-weight threshold for silver, in KB.                                                  |
| `TIER_GOLD_KB`                    | `2048`                      | Source-code byte-weight threshold for gold, in KB.                                                    |
| `TIER_URANIUM_KB`                 | `8192`                      | Source-code byte-weight threshold for uranium, in KB.                                                 |
| `CLAUDE_CONFIG_DIRS`              | `~/.claude`                 | Semicolon-separated Claude roots. Add more to scan several accounts, e.g. `~/.claude;~/.claude-work`. |
| `SENDTEXT_RELAY_MODEL`            | `haiku`                     | Model the one-shot `claude -p` relay runs. The relay only forwards a string, so the cheapest wins.    |
| `SENDTEXT_TIMEOUT_S`              | `60`                        | How long a message delivery may take before it is reported as timed out.                              |
| `HOOKS_PORT`                      | `47821`                     | Loopback port for instant updates (see above). Nothing binds it until you opt in.                     |
| `CLAUDE_CLI_PATH`                 | _(detect)_                  | Explicit path to the `claude` binary. Blank detects it in the known install locations, then PATH.     |
| `CODEX_CLI_PATH`                  | _(detect)_                  | Explicit path to the `codex` binary. Blank detects it in the known install locations, then PATH.      |
| `ANTIGRAVITY_CLI_PATH`            | _(detect)_                  | Explicit path to the `agy` binary. Blank detects it in the known install locations, then PATH.        |

Tier thresholds must be strictly increasing.

`CODEX_CLI_PATH` is also what the Codex message queue addresses. If detection lands on an
npm-global `codex.cmd`/`.bat` shim, sending is refused with that reason rather than run: a shim
cannot be spawned without a shell, and a shell would re-parse the message — expanding `%VAR%`
into it, or letting a quote end the argument. Point this at the real executable to fix it.
Launching a new Codex session from the Add panel has no such limit: the panel reads the shim and
starts the `node` entry it names directly, so an npm or pnpm install launches without an override.

</details>

### Diagnostic switches

These are separate from the table above, and deliberately so: they are **real environment variables
only**, never keys in `config-v1.json`. A debugging device does not belong in the file an installed
app reads on every launch. Each is on for `1` or `true` and off for anything else.

| Variable       | What it prints                                                                        |
| -------------- | ------------------------------------------------------------------------------------- |
| `DWARFAI_PERF` | What each poll cost, in wall-clock milliseconds, per stage.                           |
| `TIER_DEBUG`   | One line per file the tier walk skipped and why, plus a tally per project.            |
| `CODEX_DEBUG`  | Which candidate Codex rollouts the liveness gate refused, and on which rule.          |
| `SHELL_DEBUG`  | What main does to its two windows — the one place a silent failure was undiagnosable. |

`DWARFAI_PERF` has to be a real environment variable even in a development checkout
(`DWARFAI_PERF=1 pnpm dev`): its module is imported before `.env` is loaded, so a `.env` line
arrives too late to be read. The other three work either way.

The development-only simulated valley (`DWARFAI_SIMULATE=1` and its seven `DWARFAI_SIMULATE_*`
companions) is documented
in [`docs/simulated-provider.md`](docs/simulated-provider.md). It is likewise environment-only, and
for a stronger reason: a packaged app must never be talked into inventing mines that do not exist.

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

| Command              | Runs on | Output in `release/`                                |
| -------------------- | ------- | --------------------------------------------------- |
| `pnpm package`       | Windows | unsigned NSIS installer + portable exe, x64         |
| `pnpm package:mac`   | macOS   | dmg + zip, arm64 and x64 (signed + notarized in CI) |
| `pnpm package:linux` | Linux   | AppImage + deb, x64                                 |

`package:mac` names no targets on the command line, and that is deliberate. Naming any target
there replaces the configured list _including its architectures_, after which electron-builder
falls back to the build host's own architecture — which is how two releases shipped arm64 only
from an arm64 runner. Leaving the list off keeps `build.mac.target` in `package.json` the single
place that decides which architectures ship.

Every installer carries the Claude Agent SDK runtime for **its own** platform and architecture,
whatever machine built it — so, for example, the x64 macOS installer built on an Apple Silicon
Mac still holds the x64 runtime, which held Claude sessions need to start (see
[Contributing](CONTRIBUTING.md#packaging-dependencies) for how that is declared and kept out of
the other three installers).

Windows and Linux builds are never code-signed, so SmartScreen and unsigned-`.deb`-aware package
managers will warn — see [`docs/signing.md`](docs/signing.md) for exactly what that means and
what it takes to fix. macOS is signed and notarized only when the five Apple/Developer-ID secrets
are present in the environment — true for the CI `release-mac` job, not for a local
`pnpm package:mac` run without them, which still succeeds but produces an unsigned/ad-hoc build
(see [`docs/signing.md`](docs/signing.md#local-packaging-without-a-certificate)).
The application icon (installer, exe, tray, and window) is generated from the mound art
by `pnpm icons` (`scripts/build-icons.mjs`); see `build/icon.*` and `resources/*-icon*.png`.

## Architecture

```text
ClaudeProvider / CodexProvider / AntigravityProvider     (+ the simulated one, dev only)
            |
          Poller -> aggregateMines + TierService -> MaterialLedger
            |                                          ^
        AgentRuntime  <- createPlatformAdapters (focus, viewer, text delivery,
            |                                    clipboard, process probe, process end)
            |          <- HeldSessionRegistry (the sessions this panel keeps open)
      Electron IPC / preload
            |
       Vue renderer  ->  shell window  +  message-panel window
```

The shared contract in `src/shared/contracts.ts` is the single type boundary for main,
preload, and renderer. Providers depend on the `FsLike` port so parsers and scans can be tested
without the real filesystem.

Both windows are the **same** renderer bundle: main loads `index.html` a second time with
`?surface=message-panel` and the entry point picks its root component from that. One bundle, one
stylesheet, one Content-Security-Policy, and every design token already defined in the first.

`src/main/platform/platformAdapters.ts` is the single composition point for everything
operating-system-specific: the runtime gets a focus function, a `TextDeliveryPort`, a
transcript-viewer launcher and a `ProcessProbePort`, and autostart gets an `AutostartPort` — all
selected there and all injectable in tests. No adapter branches on `process.platform` itself; it
is read at three call sites (four occurrences), all outside the adapters — `currentPlatform()`,
which normalises it onto a supported family, and the entry point twice, for the modifier names
the settings panel prints and for the value handed to the hook channel. Each adapter
is split into pure builders (a command's argv, a plist's exact bytes) and a thin runner, which is
what makes platforms that cannot be executed here still testable here.

## Security posture

The renderer runs with context isolation enabled and Node integration disabled. The preload
exposes only the typed DwarfAI-Miners API. A request to open a new window is denied and its URL
handed to the system browser instead. There is no `will-navigate` handler, so navigation within
the panel's own frame is not intercepted — the panel loads one local document and has no links,
which is why that has never been reachable, not because it is blocked.

One local side effect is worth stating plainly here rather than only in the privacy document:
sending a message into a session's console **uses your system clipboard**. The message is written
to it, pasted, and the previous contents are put back immediately afterwards. Anything that writes
to the clipboard in that window loses its value to the restore — a single focus plus one keystroke —
and not restoring at all would be worse, so the race is accepted and stated. Only the paste channel
does this; the relay and the Codex queue touch no clipboard.

The app makes no outbound network requests of its own — no telemetry, no auto-updater.
[`docs/privacy.md`](docs/privacy.md) documents the full data boundary (what is read, what is
stored, what is transmitted, with the source file behind each claim), and
[`SECURITY.md`](SECURITY.md) covers supported versions and how to report a vulnerability
privately.

## Reporting a problem

- **Bugs, features and roadmap** → [GitHub issues](https://github.com/JeronimoRepetto/DwarfAI-Miners/issues).
  Name your platform, the version the Settings panel shows (the `-dev` suffix matters), and how to
  reproduce it. Check your platform's row in the [support matrix](#platform-support) first — an
  integration-pending row is often the whole explanation.
- **Vulnerabilities** → privately, through the flow in [`SECURITY.md`](SECURITY.md). Never a public
  issue.
- **Questions about what the app reads or stores** → [`docs/privacy.md`](docs/privacy.md) answers
  those with the source file behind each claim.

If you run macOS or Linux, the single most useful thing you can file is what happened when you
walked the support matrix on real hardware — including "it all worked". See
[CONTRIBUTING.md](CONTRIBUTING.md#platform-validation--help-wanted).

## Documentation

The pixel-art assets and interface design are by Jeronimo Repetto. The code is MIT-licensed; the
visual and audio assets have their own [artwork license](ARTWORK-LICENSE.md).

**Start here:**

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
