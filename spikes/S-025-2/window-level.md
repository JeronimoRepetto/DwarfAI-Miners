# S-025-2 — always-on-top level above full-screen apps: procedure

Spike register S-025-2; ADR-025 D1 (Veta: `alwaysOnTop` at `'screen-saver'` on macOS and `'pop-up-menu'` or the
default elsewhere, to be confirmed here); NFR-PLAT-04; testing strategy `17` §4 (manual per OS, then the release
checklist). The record is `spike-results/S-025-2.md`.

## What is measured

Which Electron always-on-top level keeps a small frameless window (the Veta strip stand-in) visible above:

- a full-screen app (a video player or browser in full screen, a game in borderless full screen);
- the taskbar (Windows) or the Dock and menu bar (macOS) or the panel (Linux);
- on macOS, another Space and a full-screen Space;

without taking the keyboard focus from the app the person is using.

The tool is `spikes/S-025-2/levelProbe.cjs`: a small amber window at the bottom centre of the primary display reading
"S-025-2 probe · level <level>". It is shown without focus, prints one JSON line per second (`isAlwaysOnTop`,
`isVisible`, `bounds`) and quits by itself after 90 s (`--seconds <n>` to change it).

```sh
pnpm exec electron spikes/S-025-2/levelProbe.cjs --level <level> [--all-workspaces] [--seconds <n>]
```

## Before you start (once per machine)

As in `spikes/S-024-1/display-facts.md` "Before you start" (up-to-date `main`, `pnpm install --frozen-lockfile`, a
terminal inside the desktop session), and note the OS name and version.

## Steps

Run each case once per level in the order below and stop at the first level that passes every check of its OS. Levels
to try: Windows and Linux `pop-up-menu`, then `screen-saver`, then `floating`; macOS `screen-saver`, then
`screen-saver` with `--all-workspaces`, then `pop-up-menu`.

For each level:

1. Start the probe in the terminal: `pnpm exec electron spikes/S-025-2/levelProbe.cjs --level <level> --seconds 120`.
   Expected: the amber window appears at the bottom centre; the terminal shows a `shown` line.
2. **Full-screen app.** Open a browser, play any video and switch it to full screen (F11 or the player's full-screen
   button). Is the amber window still visible above the video? Click into the video: does the amber window stay?
3. **Taskbar / Dock / panel.** Leave full screen. Click the taskbar (Windows), the Dock (macOS) or the panel (Linux).
   Does the amber window stay above it where they overlap?
4. **Focus.** Type in another app while the probe runs. Did the probe ever take the focus (the other app stops
   receiving keys)?
5. **macOS only — Spaces.** Swipe to another Space (Control+Right Arrow), then to a full-screen app's Space. Is the
   amber window visible on each?
6. **Linux only — session type.** Note `echo $XDG_SESSION_TYPE`. On a Wayland session run the probe twice: once as is
   (native Wayland) and once with `--ozone-platform=x11` after the `.cjs` path (XWayland, ADR-025 D6).
7. Wait for the probe to quit (or close the terminal). Keep the terminal output.

## What to record

Per OS (and Linux session type) and per level tried, in `spike-results/S-025-2.md`:

| Check                                            | Observed     |
| ------------------------------------------------ | ------------ |
| above a full-screen video                        | yes / no     |
| stays after clicking the full-screen app         | yes / no     |
| above the taskbar / Dock / panel                 | yes / no     |
| never took the focus                             | yes / no     |
| macOS: on another Space / on a full-screen Space | yes / no     |
| `isAlwaysOnTop` in every `tick` line             | true / false |

with the OS version, the Electron version (in the `shown` line) and the date. Send back the terminal output of each
run. A level that fails a check on an OS is recorded as failing there; if no level passes, the record says which check
fails, and NFR-PLAT-04 applies ("failing the same visible way where not").

## How the result is read

The record's Decision names the level per OS (and per Linux session type), and whether `--all-workspaces`
(`setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`) is needed on macOS. ISSUE-285 builds the Veta window
with it, and the release checklist re-checks it per OS.
