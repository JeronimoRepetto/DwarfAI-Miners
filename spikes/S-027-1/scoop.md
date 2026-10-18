# S-027-1 — Scoop zip layout and `scoop update` (procedure)

Spike register S-027-1 (ADR-027 D1; ADR-016 item 7; OQ-59) has three questions:

- Does the Windows zip work as a Scoop app?
- Where does electron-builder's `portable` exe extract itself?
- Does `pre_uninstall` run on `scoop update`, and how can the hook tell an update from an uninstall? The record must
  show that `scoop update` with a running Host never runs `--revert-integrations`, and that `scoop uninstall` does.

## Automated (CI, Windows leg of the packaging spike lane)

`scoopLayout.mjs` has three parts. The `scoop` and `portable` parts run as the standard user from
`scripts/ci/run-unelevated.mjs`.

- `layout` lists the zip's entries: where `DwarfAI-Miners.exe` and `resources/app.asar` sit, and whether the zip has
  one top folder (if so, the manifest needs `extract_dir`).
- `scoop` installs Scoop for that user with the official one-line installer. It then installs the zip from a local
  manifest. The manifest is built by `scoopManifest` in `scripts/ci/packagingSpikes.mjs`, and the zips are served on
  `127.0.0.1` only. Every install and uninstall hook appends one JSON line with `$cmd`, `$app`, `$version`, `$global`,
  `$dir` and its command line. The harness starts the app with `--background` until the Host runs, rewrites the
  manifest to the next version, runs `scoop update` with the Host running, and then runs `scoop uninstall`. It records
  each command's output, the hook lines, whether the Host survived, and what was left behind.
- `portable` starts the `portable` exe with `--background` and records the folders its processes run from and whether
  they remain after exit.

## Manual (a real Windows desktop, for the record)

1. On a Windows 11 machine or VM with no DwarfAI data that matters, install Scoop as a standard user:
   `irm get.scoop.sh | iex`.
2. The lane uploads evidence only, not installers. Package the base and next zips locally with `pnpm package` and
   `pnpm package -c.extraMetadata.version=<next> -c.directories.output=release-next`.
3. Run `node spikes/S-027-1/scoopLayout.mjs scoop --zip <base zip> --next-zip <next zip> --out <dir> --allow-local`.
   The harness deletes this user's DwarfAI data.
4. In `spike-results/S-027-1.md`, record the Scoop version, Windows version, the date, the zip layout, the hook lines
   of `update` and `uninstall`, whether the Host survived each, the rule a hook can use to tell an update from an
   uninstall, and the portable extraction behaviour (if it runs in place, OQ-33 B may be restored).
