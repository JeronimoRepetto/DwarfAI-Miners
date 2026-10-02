# S-018-1 — notification from a windowless tray process: manual checks

Spike register S-018-1; ADR-018 item 5; testing strategy `17` §4. The record is `spike-results/S-018-1.md`. This guide
is the manual half: a person clicks a notification, and a person looks at a Linux panel. The CI legs already ran the
automatic half (the windowless tray process, and an unattended notification on each runner).

It is written so that a person who is not a developer, or an agent guiding them, can follow it step by step. Every
command is meant to be copied exactly. Nothing here needs administrator rights, changes a system setting or installs
anything beyond the repository's own dependencies.

## What the check does

A small throwaway app (`spikes/S-018-1/trayApp.cjs`) starts with **no window**. It shows a small blue square in the
tray (Windows: the notification area by the clock; macOS: the menu bar; Linux: the panel), waits a moment, and shows
**one notification** titled "DwarfAI spike S-018-1" that says "Click this notification to finish the check." When you
click it, the app records the click and closes. The app first runs once without any notification (the blue square
appears and goes away after about two seconds); that is expected.

You have **2 minutes** to click the notification. If you miss it, run the same command again.

## Before you start (once per machine)

1. Open a terminal **inside the desktop session** (not over SSH): Windows PowerShell, macOS Terminal, or the Linux
   desktop's terminal.
2. Go to your DwarfAI-Miners checkout and get the spike branch. Ask the person who sent you this guide which branch
   name to use if it is not `feat/issue-318-cut1-entry-spikes`:

   ```sh
   git fetch origin
   git switch feat/issue-318-cut1-entry-spikes
   pnpm install --frozen-lockfile
   ```

   Expected: `pnpm install` ends without an error.

3. Turn off "Do not disturb" / "Focus" for the duration of the check, so the notification is not hidden.

## Step 1 — Windows 11

In **PowerShell**:

```powershell
$env:S0181_MODE = 'click'
$env:S0181_REPORT = 'spike-results/S-018-1/windows-11-click.json'
pnpm vitest run --config vitest.os.config.ts spikes/S-018-1
Remove-Item Env:S0181_MODE, Env:S0181_REPORT
```

Click the notification when it appears (bottom right of the screen).

Expected last lines: `Tests  2 passed | 1 skipped (3)`.

Optional, if you have 10 minutes: the same check after the app sat idle for 10 minutes before it shows the
notification (the register's "click activation after the process was idle"):

```powershell
$env:S0181_MODE = 'click'
$env:S0181_IDLE_MS = '600000'
$env:S0181_REPORT = 'spike-results/S-018-1/windows-11-click-idle.json'
pnpm vitest run --config vitest.os.config.ts spikes/S-018-1
Remove-Item Env:S0181_MODE, Env:S0181_IDLE_MS, Env:S0181_REPORT
```

## Step 2 — macOS

In **Terminal**:

```sh
S0181_MODE=click S0181_REPORT=spike-results/S-018-1/macos-click.json pnpm vitest run --config vitest.os.config.ts spikes/S-018-1
```

- The first time, macOS may ask whether "Electron" may send notifications. Choose **Allow**. If the notification does
  not appear at all, open System Settings → Notifications → Electron, turn **Allow notifications** on, and run the
  command again.
- If a banner appears and disappears before you can click it, open Notification Center (click the clock in the menu
  bar) and click it there.

Expected last lines: `Tests  2 passed | 1 skipped (3)`.

Optional idle variant (10 minutes):

```sh
S0181_MODE=click S0181_IDLE_MS=600000 S0181_REPORT=spike-results/S-018-1/macos-click-idle.json pnpm vitest run --config vitest.os.config.ts spikes/S-018-1
```

## Step 3 — Linux, one run per desktop

Run this once on every Linux desktop you can reach. The desktop you use every day is required; the other rows are
optional (a second machine, a live USB session or a virtual machine). Log in to that desktop first, then open its
terminal.

```sh
S0181_MODE=click S0181_REPORT=spike-results/S-018-1/linux-$(echo "${XDG_CURRENT_DESKTOP:-unknown}" | tr ':A-Z' '_a-z')-click.json pnpm vitest run --config vitest.os.config.ts spikes/S-018-1
```

While it runs, look at the panel: does a **small blue square** appear in the tray area? Then click the notification.

Expected last lines: `Tests  2 passed | 1 skipped (3)`. If the test fails with "the click reached the tray process",
the notification did not arrive or the click was not delivered: write down what you saw.

| Desktop (`echo $XDG_CURRENT_DESKTOP`)         | Required | Blue square in the panel? | Notification shown? | Click recorded (test passed)? |
| --------------------------------------------- | -------- | ------------------------- | ------------------- | ----------------------------- |
| your daily desktop                            | yes      |                           |                     |                               |
| GNOME on Ubuntu (Ubuntu's AppIndicator dock)  | optional |                           |                     |                               |
| GNOME on Fedora (no tray extension installed) | optional |                           |                     |                               |
| KDE Plasma                                    | optional |                           |                     |                               |
| XFCE                                          | optional |                           |                     |                               |
| Cinnamon                                      | optional |                           |                     |                               |

The report file also records, without your help, whether the desktop has a tray host (`statusNotifierWatcher`) and a
notification server, and its name and version.

## What to send back

1. Every JSON file the steps wrote under `spike-results/S-018-1/` (they hold no names or paths: those are replaced by
   `<home>`, `<user>`, `<repo>`).
2. For each run: did you see the blue square, did you see the notification, and the last lines the command printed.
3. The Linux table above, filled in.
4. The OS versions: Windows `winver`; macOS: Apple menu → About This Mac; Linux `cat /etc/os-release | head -3`.

Then, if you are comfortable with git, commit the files:

```sh
git add spike-results/S-018-1/
git commit -m "docs(spikes): add the S-018-1 manual click runs"
```

Otherwise send them to the person who gave you this guide; they update `spike-results/S-018-1.md`.
