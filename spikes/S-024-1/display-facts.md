# S-024-1 — display facts across reboot, driver update and dock/undock: procedure

Spike register S-024-1; ADR-024 D5; testing strategy `17` §4 (manual per OS, then the `displayKey` unit table). The
record is `spike-results/S-024-1.md`. This file is the procedure; the record holds the observations and the decision.

## What is measured

Veta remembers its dock per display (`VetaDock[displayKey]`, ADR-024). The key must name the same physical display
again after the computer restarts, after its display driver is updated and after a laptop is docked and undocked, and
it must not move to another display. The spike answers, per OS: which of the facts Electron reports for a display
(`id`, `label`, `bounds`, `workArea`, `size`, `scaleFactor`, `rotation`, `internal`, `displayFrequency`) stay the same
across each of those events?

The tool is `spikes/S-024-1/displayFacts.cjs`. It opens no window. It writes one JSON snapshot of every display, and it
compares two snapshots:

```sh
pnpm exec electron spikes/S-024-1/displayFacts.cjs --label <step> --out <file.json>
node spikes/S-024-1/displayFacts.cjs compare <before.json> <after.json>
```

`compare` pairs the displays by `id` (or by `label` when no `id` matches) and lists the facts that changed for each.
`"matchedBy": "label"` means the `id` changed; `"matchedBy": "none"` means the display was not found again; displays in
`newDisplays` appeared only in the second snapshot.

## Before you start (once per machine)

1. Open a terminal inside the desktop session (not over SSH).
2. In your DwarfAI-Miners checkout, on an up-to-date `main`:

   ```sh
   git switch main
   git pull --ff-only
   pnpm install --frozen-lockfile
   mkdir -p s0241
   ```

   The `s0241/` folder holds your snapshots; keep it until you send them back. Never commit it.

3. Note the OS name and version (Windows: `winver`; macOS: Apple menu › About This Mac; Linux: `cat /etc/os-release`
   and `echo $XDG_SESSION_TYPE`) and how many displays are connected, and how (built-in, HDMI, DisplayPort, USB-C dock).

## Steps (each OS)

Take every snapshot with the same displays connected as the "before" one, unless the step says otherwise.

| Step | Do this                                                                                                                                                                                                                                                                                                                                                                                                            | Then take the snapshot                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| 1    | Nothing.                                                                                                                                                                                                                                                                                                                                                                                                           | `--label base --out s0241/1-base.json`                                                                    |
| 2    | Restart the computer (Start › Power › Restart; Apple menu › Restart; or `systemctl reboot`). Sign in again.                                                                                                                                                                                                                                                                                                        | `--label after-restart --out s0241/2-after-restart.json`                                                  |
| 3    | Shut down fully and start again. On Windows 11 with Fast Startup on (the default), Shut down keeps the kernel session: do it once as is, take the snapshot, then once with Shift held while clicking Shut down.                                                                                                                                                                                                    | `--label after-shutdown --out s0241/3-after-shutdown.json` (and `3b-after-full-shutdown.json` on Windows) |
| 4    | Update or reinstall the display driver. Windows: Device Manager › Display adapters › your adapter › Update driver (or install the vendor's newer driver), then restart if asked. macOS: skip (drivers come with OS updates; record a macOS update instead if one is pending). Linux: install the distribution's newer graphics driver package if one is offered, then restart; otherwise skip and write "skipped". | `--label after-driver --out s0241/4-after-driver.json`                                                    |
| 5    | Unplug one external display (or undock the laptop).                                                                                                                                                                                                                                                                                                                                                                | `--label undocked --out s0241/5-undocked.json`                                                            |
| 6    | Plug it back in the same port (or dock again).                                                                                                                                                                                                                                                                                                                                                                     | `--label redocked --out s0241/6-redocked.json`                                                            |
| 7    | Plug that display into a different port (or the other dock port), if you have one.                                                                                                                                                                                                                                                                                                                                 | `--label other-port --out s0241/7-other-port.json`                                                        |
| 8    | Change the scale of one display (Windows: Settings › Display › Scale; macOS: Displays › resolution; Linux: the desktop's display settings), take the snapshot, then set it back.                                                                                                                                                                                                                                   | `--label scale-changed --out s0241/8-scale-changed.json`                                                  |
| 9    | Make another display the primary (Windows: Settings › Display › "Make this my main display"; macOS: drag the menu bar in Displays › Arrange; Linux: the desktop's display settings), take the snapshot, then set it back.                                                                                                                                                                                          | `--label primary-changed --out s0241/9-primary-changed.json`                                              |

Each snapshot command starts with `pnpm exec electron spikes/S-024-1/displayFacts.cjs`.

Then compare every snapshot with the base:

```sh
node spikes/S-024-1/displayFacts.cjs compare s0241/1-base.json s0241/2-after-restart.json
node spikes/S-024-1/displayFacts.cjs compare s0241/1-base.json s0241/3-after-shutdown.json
# … one line per snapshot
```

Linux: run the whole procedure on an X11 session and on a Wayland session with XWayland (ADR-025 D6 starts the app
with `--ozone-platform=x11` there: add `--ozone-platform=x11` after the `.cjs` path in every snapshot command).

## What to record

For each OS (and Linux session type), in `spike-results/S-024-1.md`:

- the OS name and version, the Electron version (in every snapshot), the displays and how they are connected;
- for each step: whether each display was matched by `id`, by `label` or not at all, and which facts changed;
- anything surprising (two displays with the same `label`, an `id` that moved to another display, an empty `label`).

Send back the `s0241/` folder. The snapshots hold display ids, monitor model names and geometry only, no paths and no
account names; check before sending.

## How the result is read

A fact is a candidate for `displayKey` on an OS when it stays the same through steps 2–4 and 6, never moves to another
display, and changes only when the physical display changes. Facts that change with steps 8 or 9 (`bounds`,
`workArea`, `scaleFactor`, `primary`) can only break ties. The record's Decision names the inputs per OS; ISSUE-286
builds the `displayKey` unit table from them.
