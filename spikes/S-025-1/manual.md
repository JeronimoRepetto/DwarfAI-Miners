# S-025-1 — mode windows: L9 case and manual checks

Spike register S-025-1; ADR-025 D1, D3; ADR-024 D3 (OQ-37 B); testing strategy `17` §4 (L9 plus manual per OS, then
the ADR-024/025 E2E acceptance). The record is `spike-results/S-025-1.md`.

## Part 1 — the L9 case (each OS)

`spikes/S-025-1/modeWindows.e2e.ts` measures, inside the built app, two frameless windows moved in one transition run
from a shared `t0`: the first renderer frame of each at or after `t0`, the time each window reports its final bounds,
and the draft, caret and selection carried from one renderer to the other. Its header says what it covers and what it
cannot see.

It shows two small windows (160 × 100) at the bottom right of the primary display for about a second, plus the app's
own window, so run it when nobody is using the machine, or on CI.

```sh
pnpm build
S0251_REPORT=s0251-<os>.json pnpm exec playwright test spikes/S-025-1 --retries=0
```

On Linux, under X11 or Xvfb: prefix with `xvfb-run --auto-servernum` when there is no desktop session. On Windows
PowerShell, set the variable first: `$env:S0251_REPORT = "s0251-windows.json"`.

CI runs the same case on Windows, macOS and Linux (Xvfb) in the E2E release lane (`pnpm test:e2e` matches
`spikes/**/*.e2e.ts`): on every push to `main`, nightly, on release tags, and on a pull request labelled `e2e`.

Record from the JSON report: `displayFrequency`, `frameMs`, `firstFrameAfterT0Ms`, `renderJitterMs`,
`moveSettledAfterIssueMs`, `moveJitterMs` and whether `viewState.restored` equals `viewState.flushed`.

**Load-bearing check.** Set `OS_WINDOW_ANIMATION = true` in `modeWindows.e2e.ts`, run the case, and confirm it fails;
then set it back. Electron animates `setBounds` only on macOS, so this break is expected to fail on macOS only; on
Windows and Linux the flag is ignored, and the OS animation check is Part 2.

## Part 2 — manual checks (each OS)

What the L9 case cannot see: the compositor's own show/hide animation of a window, and an IME composition.

### 2a. OS show/hide animation

ADR-025 D1 requires every mode window to show and hide with no OS animation (Windows: DWM transitions, UNVERIFIED native
call; macOS: the window animation behaviour, UNVERIFIED; Linux: none known). With a screen recorder at 60 frames per
second (Windows: Xbox Game Bar, Win+Alt+R; macOS: Shift+Command+5; Linux: OBS Studio or the desktop's recorder):

1. Start recording, then run Part 1's case once.
2. Stop recording. Step through the frames where the two small windows appear and disappear.
3. Record per OS: does a window fade, scale or slide in or out over several frames (an OS animation), or does it appear
   and disappear between one frame and the next?
4. Windows only: repeat with Settings › Accessibility › Visual effects › Animation effects turned off, and note whether
   the result changes (this is a system-wide setting, not a per-window one; turn it back on afterwards).

### 2b. IME composition at the switch

OQ-37 B: an in-progress IME composition does not travel; it ends at the switch. Record how each OS ends it. This needs
an input method installed (Windows: add Japanese (Microsoft IME) in Settings › Time & language › Language; macOS: add
Japanese – Romaji in Keyboard › Input Sources; Linux: IBus or Fcitx5 with Mozc). Once the mode windows exist
(ISSUE-284), start a composition in the chat composer (type `nihon` without confirming), then switch mode with the
keyboard shortcut. Record per OS: is the composed text committed, discarded, or left half-composed in the source
window? Until ISSUE-284 ships, this check is pending.

## What to record

In `spike-results/S-025-1.md`, per OS: the OS version, Electron version, the Part 1 numbers, the load-bearing result,
the Part 2a observation and, when available, the Part 2b observation, with the date.
