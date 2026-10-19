# S-018-2 — window raise on a toast click (Windows 11): manual check

Spike register S-018-2; ADR-018 item 6 (`revealDwarfChat` raises the right window after a click); testing strategy
`17` §4 (it becomes a release checklist item). The record is `spike-results/S-018-2.md`.

Windows lets a process bring its window to the front only under its foreground rules. A toast click is expected to
give the clicked app that right, but this is unverified. When the right is missing, Windows does not raise the
window and flashes its taskbar button instead (FM-049). Only a person can see the flash, so this check is manual.

## What the check does

`spikes/S-018-2/clickRaise.cjs` is a throwaway Electron app. It opens a small window titled "DwarfAI spike S-018-2"
(the "mode window"), or no window at all. It waits 10 seconds while you put another app in front of it, then shows
one notification. When you click the notification, it does what the real app will do: it restores the window if it is
minimized, shows it and focuses it. If no window was open, it creates the window first. It records what Electron
reports about focus, waits 2 seconds and closes.

Nothing here needs administrator rights, changes a setting or installs anything beyond the repository's own
dependencies. Each run takes about a minute.

## Before you start

1. Windows 11, signed in at the desktop (not over Remote Desktop: RDP changes the foreground rules).
2. Turn off **Do not disturb** (Settings → System → Notifications) for the duration of the check.
3. In PowerShell, at the root of a DwarfAI-Miners checkout of the branch you were sent, with
   `pnpm install --frozen-lockfile` done:

   ```powershell
   $electron = node -e "process.stdout.write(require('electron'))"
   $out = 'spike-results/S-018-2'
   New-Item -ItemType Directory -Force $out | Out-Null
   $env:S0182_USER_DATA = Join-Path $env:TEMP 'dwarfai-s0182'
   ```

## Run 1 — window behind another app (`behind`)

```powershell
$env:S0182_VARIANT = 'behind'; $env:S0182_REPORT = "$out/windows-11-behind.json"
& $electron spikes/S-018-2/clickRaise.cjs
```

1. The window "DwarfAI spike S-018-2" opens. **Within 10 seconds**, click on another app's window (for example File
   Explorer or your browser) so that it covers the spike window. Do not touch the spike window again.
2. The notification "DwarfAI spike S-018-2" appears at the bottom right. Click its text.
3. Watch for 2 seconds, then write down:
   - **A.** Did the spike window come to the front, above the other app? (yes / no)
   - **B.** Did its taskbar button flash or turn orange? (yes / no)
   - **C.** Was the spike window's title bar active (not greyed out)? (yes / no)

## Run 2 — window minimized (`minimized`)

```powershell
$env:S0182_VARIANT = 'minimized'; $env:S0182_REPORT = "$out/windows-11-minimized.json"
& $electron spikes/S-018-2/clickRaise.cjs
```

The window opens and minimizes by itself. Click on another app, wait for the notification, click it, then answer A, B
and C.

## Run 3 — no window before the click (`none`)

```powershell
$env:S0182_VARIANT = 'none'; $env:S0182_REPORT = "$out/windows-11-none.json"
& $electron spikes/S-018-2/clickRaise.cjs
```

No window opens. Click on another app, wait for the notification, click it. The spike window is created on the click.
Answer A, B and C.

## Afterwards

```powershell
Remove-Item Env:S0182_VARIANT, Env:S0182_REPORT, Env:S0182_USER_DATA
Remove-Item -Recurse -Force (Join-Path $env:TEMP 'dwarfai-s0182')
```

If you missed a notification, the app closes after 2 minutes; run the same command again.

## What to send back

The three JSON files (they hold no path or machine name: check them before sending), the Windows version
(`winver`: version and build) and this table:

| Run         | A. came to the front | B. taskbar flashed | C. title bar active | Notes |
| ----------- | -------------------- | ------------------ | ------------------- | ----- |
| `behind`    |                      |                    |                     |       |
| `minimized` |                      |                    |                     |       |
| `none`      |                      |                    |                     |       |

## How the record reads it

- **Passed** on Windows 11: in all three runs A is yes and B is no, and each report's `after-reveal-500ms` entry has
  `focused: true`.
- **Failed**: any run with A no or B yes. Then ISSUE-114 follows FM-049 (the reveal still runs; the taskbar flashes),
  and the record names the run that failed.
