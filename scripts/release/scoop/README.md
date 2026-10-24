# Scoop bucket manifest

DwarfAI reaches Windows people through Scoop, from a bucket repository the owner controls (`20` §6, OQ-56). This folder
holds the release-side tools. Nothing here writes to the bucket repository: the owner adds each release's manifest to
it by hand, through a reviewed pull request.

## Files

| File                    | What it does                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `../scoop-manifest.mjs` | Writes `dwarfai.json` for a release: every field of the `20` §6 outline, with the zip's hash read from `SHA256SUMS`     |
| `scoop-check.ps1`       | P-SCOOP, the Windows `package` leg's check: install, update and uninstall from a local bucket                           |
| `serve-release.mjs`     | The loopback server `scoop-check.ps1` downloads the zip from, so the check fetches nothing of the app from the internet |
| `revert-log.mjs`        | Reads the `host.revert-integrations` records of the UI log, so the check can tell which step ran the revert             |

## Adding a release to the bucket

Do this only after the release is published and its release checklist (`20` §8, R-13 included) is signed off.

1. Download the release's `SHA256SUMS` from the GitHub Release page.
2. In a checkout of this repository at the release tag, write the manifest:

   ```sh
   node scripts/release/scoop-manifest.mjs --version X.Y.Z --sums path/to/SHA256SUMS --out dwarfai.json
   ```

   The command refuses a `SHA256SUMS` that does not list `DwarfAI-Miners-X.Y.Z-win-x64.zip`. Never pass `--url` for a
   release: it exists only for the CI check.

3. Check the hash in `dwarfai.json` against the `SHA256SUMS` line of the zip, and check that the url opens the zip of
   that Release.
4. In the bucket repository, on a new branch, replace `bucket/dwarfai.json` with the new file, commit and open a pull
   request.
5. Review the diff: only `version`, `url` and `hash` should change. Merge it with an account that uses two-factor
   authentication (`18` C-31).

People then get the release with `scoop update dwarfai`. A first install is
`scoop bucket add dwarfai <bucket repo URL>`, then `scoop install dwarfai`.

## Uninstall and update

`pre_uninstall` runs `DwarfAI-Miners.exe --revert-integrations` only when Scoop's hook context `$cmd` is `uninstall`
(ADR-016 item 7, OQ-59):

- `scoop uninstall dwarfai` ends DwarfAI's launched sessions and reverts its integrations, with or without `--purge`.
- `scoop update dwarfai` never does either. Scoop runs `pre_uninstall` for the old version during an update too, and
  the guard skips it.

The command is piped to `Out-Null`, so Scoop waits for it before it deletes the app folder. PowerShell does not wait
for a GUI program such as DwarfAI unless its output is piped. That pipe is the one change from the `20` §6 outline.

## The CI check

P-SCOOP replaces the manual Windows VM check (owner decision, 2026-10-24). It runs in the Windows leg of the `package`
job, which runs on `v*` tags and manual dispatch. On the elevated hosted runner, the Host refuses to start (ADR-002 D6).
So the uninstall's revert record answers `HOST_EXIT_65`, which proves that the hook ran the command. The revert's own
effects are covered by ISSUE-225's tests.
