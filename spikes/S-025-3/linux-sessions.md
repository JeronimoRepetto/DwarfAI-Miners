# S-025-3 — click-through forwarding and transparent compositing per Linux session type: procedure

Spike register S-025-3; ADR-025 D4 (click-through: `setIgnoreMouseEvents(true, { forward: true })` with renderer
hit-testing on Windows and macOS; on Linux, where `forward` is not expected to work, the window bounds hug the island);
ADR-025 D6 (XWayland first); testing strategy `17` §4 (manual Linux, then the release checklist). The record is
`spike-results/S-025-3.md`.

## What is measured

For each Linux session type:

1. **Compositing.** Is a transparent, frameless window see-through, or are its transparent parts drawn black, grey or
   with a frame?
2. **Forwarding.** While the window ignores the mouse with `forward: true`, does the page still receive mouse moves
   (`movesWhileIgnoring` > 0)?
3. **Click-through.** Does a click on a transparent corner reach the window underneath?
4. **Island hit-testing.** When the pointer is over the island, the probe stops ignoring the mouse: is the island then
   clickable (`clicksOnIsland` > 0)?

Session types to cover (one machine may offer several at its login screen):

| Session                                                                                             | How to recognise it                   | Probe command suffix                |
| --------------------------------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------- |
| X11 (GNOME on Xorg, KDE Plasma X11, Xfce, Cinnamon, MATE)                                           | `echo $XDG_SESSION_TYPE` prints `x11` | none                                |
| Wayland with XWayland (GNOME, KDE Plasma Wayland)                                                   | prints `wayland`                      | `--ozone-platform=x11` (ADR-025 D6) |
| Native Wayland (same sessions)                                                                      | prints `wayland`                      | `--ozone-platform=wayland`          |
| X11 without a compositor (Xfce with compositing turned off, or a bare window manager), if available | prints `x11`                          | none                                |

Windows and macOS are run once each as the reference: the same steps, no suffix.

The tool is `spikes/S-025-3/clickThroughProbe.cjs`: a 320 × 200 transparent window in the middle of the primary
display, with an amber island reading "S-025-3 island" and transparent corners. It prints one JSON line per event and a
`summary` line when it quits after 90 s (`--seconds <n>` to change it; `--no-forward` to compare without `forward`).

```sh
pnpm exec electron spikes/S-025-3/clickThroughProbe.cjs [--seconds <n>] [--no-forward] [<suffix>]
```

## Before you start (once per machine)

As in `spikes/S-024-1/display-facts.md` "Before you start", and note the distribution and version
(`cat /etc/os-release`), the desktop and its version, and the session type.

## Steps (each session type)

1. Open a text editor or a file manager window and place it so it fills the middle of the screen.
2. Start the probe: `pnpm exec electron spikes/S-025-3/clickThroughProbe.cjs --seconds 120 <suffix>`.
   Expected: the amber island appears in the middle; the terminal shows a `shown` line (check its `sessionType` and
   `ozonePlatform`).
3. **Compositing.** Look at the area around the island. Do you see the editor through it (see-through), or a black,
   grey or white rectangle, or a frame or shadow?
4. **Forwarding.** Move the pointer slowly over a transparent corner without clicking, for about 3 s. In the terminal,
   do `ignoreMouseEvents` lines appear only when you cross the island's edge?
5. **Click-through.** Click a transparent corner where the editor is underneath. Did the editor get the click (its
   caret moves or its window comes forward)? Did the terminal print a `click` line with `"onIsland": false`?
6. **Island.** Move onto the island and click it. Did the terminal print `ignoreMouseEvents` with `"ignoring": false`
   and then a `click` line with `"onIsland": true`?
7. Move off the island and click a transparent corner again: does the click reach the editor again?
8. Wait for the `summary` line. Keep the whole terminal output.
9. Run steps 2–8 once more with `--no-forward` added, for comparison.

## What to record

Per session type (and Windows and macOS as the reference), in `spike-results/S-025-3.md`:

| Check                                                       | Observed                         |
| ----------------------------------------------------------- | -------------------------------- |
| transparent parts see-through                               | yes / no (what is shown instead) |
| `movesWhileIgnoring` with `forward`                         | the number from `summary`        |
| click on a transparent corner reaches the window underneath | yes / no                         |
| island clickable after the pointer enters it                | yes / no                         |
| the same with `--no-forward`                                | as above                         |

with the distribution, desktop, session type, `ozonePlatform`, the Electron version and the date. Send back the terminal
output of each run.

## How the result is read

Where `movesWhileIgnoring` is 0 with `forward`, renderer hit-testing cannot switch click-through, and ADR-025 D4's
Linux rule applies: the Veta window's bounds hug the island and its corners are not transparent to the mouse. Where the
transparent parts are not see-through, the record names the session as one where Veta's transparent window does not
composite, and the release checklist names it. The record's Decision states the click-through and compositing
behaviour ISSUE-285 builds on, per session type.
