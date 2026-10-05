# S-027-4 — login entry at a real sign-in: manual check

Spike register S-027-4; ADR-027 item 7 (AMENDMENT-5, AMENDMENT-6); testing strategy `17` §4. The record is
`spike-results/S-027-4.md`. The OS-lane harness `loginEntry.os.test.ts` already proves, on each CI runner, that the
per-user entry is written without elevation, read back, starts the app with `--background` when its stored command
runs, and is removed. This guide is the part only a real sign-out and sign-in can prove: **the OS itself starts the
entry at login**, with `--background`, a tray icon and no window. It also asks what the entry reads back after **you**
switch it off in the OS's own startup list.

It is written so that a person who is not a developer, or an agent guiding them, can follow it step by step. Every
command is meant to be copied exactly. Nothing here needs administrator rights or installs anything beyond the
repository's own dependencies.

**Signing out closes every open app.** Use a fresh user account or a virtual machine ("clean VM") if you can.
Otherwise save your work before step 3.

## What the check does

`spikes/S-027-4/loginProbe.ts` writes one login entry with a throwaway name (`DwarfAI-S0274-login-probe` on Windows,
`com.dwarfai.spike.s0274.login-probe` on macOS, `dwarfai-spike-s0274-login-probe.desktop` on Linux). It starts a tiny
throwaway app, not DwarfAI. Your real DwarfAI-Miners login entry, and every other app's, is never read or changed. At
the end you remove it again (step 6).

## Before you start (once per machine)

1. Open a terminal inside the desktop session (not over SSH): Windows PowerShell, macOS Terminal, or the Linux
   desktop's terminal.
2. Go to your DwarfAI-Miners checkout and get the spike branch (ask the person who sent you this guide if the branch
   name differs):

   ```sh
   git fetch origin
   git switch feat/issue-318-cut1-entry-spikes
   pnpm install --frozen-lockfile
   ```

   Expected: `pnpm install` ends without an error.

The commands below are the same on the three OSes. Run them from the checkout folder.

## Step 1 — install the entry

```sh
node spikes/S-027-4/loginProbe.ts install
```

Expected: a block that contains `"present": true` and `"--background"`, then the line
`INSTALLED. Now sign out, sign in again, wait one minute, then run the check command.`

Write down whether the OS showed anything when the entry was written:

- Windows: a notification such as "a new startup app was added"?
- macOS: a notification "Background Items Added"? If so, what name did it show?
- Linux: usually nothing.

## Step 2 — look at the OS's own startup list (do not change anything yet)

- Windows 11: Settings → Apps → Startup. Is there a new row (probably called "Electron")? Is it **On**?
- macOS: System Settings → General → Login Items & Extensions. Under "Allow in the Background", is there a new row
  (probably "Electron")? Is it on?
- Linux GNOME: open "Startup Applications" (or GNOME Tweaks → Startup Applications). Linux KDE: System Settings →
  Autostart. Is "DwarfAI spike S-027-4" listed?

## Step 3 — sign out and sign in again

Sign out of your user account (not a restart), sign in again, and **wait one minute**. Then look at the tray (Windows:
by the clock; macOS: the menu bar; Linux: the panel): a small white square may have appeared for a moment. **No window
should open.** Write down whether any window opened.

## Step 4 — check what happened at login

Open the terminal again, go to the checkout folder, and run (replace `<os>` with `windows-11`, `macos` or
`linux-<desktop>`, for example `linux-gnome`):

```sh
node spikes/S-027-4/loginProbe.ts check --out spike-results/S-027-4/<os>-login.json
```

Expected, when the OS started the entry at login:

```
"startedByTheOsAfterInstall": true,
"startedWithBackground": true,
"windowsOpened": 0,
...
CHECK PASSED
```

`CHECK FAILED` with `"startedByTheOsAfterInstall": false` means the OS did not start the entry at login. That is a
valid result too: keep the file and continue.

## Step 5 — switch it off the way a person would, and read it back

1. Switch the entry **off** in the same place as step 2:
   - Windows: Settings → Apps → Startup → the new row → **Off**.
   - macOS: System Settings → General → Login Items & Extensions → "Allow in the Background" → the new row → **off**.
   - Linux GNOME: Startup Applications → untick or remove the row. KDE: Autostart → disable or remove the row.
2. Run:

   ```sh
   node spikes/S-027-4/loginProbe.ts read
   ```

   Copy the whole output. The value to look at is `"disabledByPerson"`: `true`, `false` or `null`. (On Linux, if the
   desktop removed the file instead, the output says `"present": false`.)

## Step 6 — remove the entry

```sh
node spikes/S-027-4/loginProbe.ts remove
```

Expected: `"removed": true`. Look at the OS's startup list again: the row should be gone. On macOS, if the row is
still listed under "Allow in the Background", write that down.

## What to send back

Per machine (Windows 11, macOS, Linux; on Linux also the desktop name from `echo $XDG_CURRENT_DESKTOP`):

1. The file `spike-results/S-027-4/<os>-login.json` from step 4 (names and paths in it are replaced by `<home>`,
   `<user>`, `<repo>`).
2. What the OS showed in step 1, and what the startup list showed in step 2.
3. Whether a window opened after signing in (step 3).
4. The output of the `read` command in step 5, and what you switched off.
5. The output of the `remove` command in step 6, and whether the row disappeared from the startup list.
6. The OS version: Windows `winver`; macOS: Apple menu → About This Mac; Linux `cat /etc/os-release | head -3`.

Then, if you are comfortable with git:

```sh
git add spike-results/S-027-4/
git commit -m "docs(spikes): add the S-027-4 real-login runs"
```

Otherwise send them to the person who gave you this guide; they update `spike-results/S-027-4.md`.

## What this guide does not cover

The packaged-channel questions of the register (the entry surviving `scoop update`, an `nsis` upgrade, an AppImage
move and a macOS app move; antivirus or SmartScreen on the unsigned build; removal by every uninstall) need the real
packaged app writing its own entry, which ISSUE-060 builds. They are re-checked on the packaged builds by ISSUE-328.
