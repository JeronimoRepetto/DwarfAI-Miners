# Spike lanes on GitHub-hosted runners

Some spikes need real packaged artifacts or a clean OS user, which an agent machine does not have. Their harnesses
run in manual-dispatch workflows on GitHub-hosted runners, and each run uploads scrubbed evidence. A person then
writes the spike record (`spike-results/<ID>.md`, testing strategy `17` §4) from that evidence. A workflow run never
writes a record and never publishes anything.

## Packaging spikes (ISSUE-328)

Workflow: `.github/workflows/spikes-package.yml`. It runs only when dispatched by hand.

### What it runs

Each OS leg (`windows-latest`, `macos-15` unsigned, `ubuntu-latest`) first packages the way `ci.yml`'s `package` job
does: `pnpm build`, the notices, the provider scan, `pnpm package`, the Host manifest check and `pnpm test:packaged`.
The harnesses then run against what it wrote:

| Spike   | Harness                                                          | Legs    | Evidence file(s)                                                             |
| ------- | ---------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------- |
| S-019-2 | `spikes/S-019-2/fuses.packaged.mjs`                              | all     | `S-019-2/release.json`, `S-019-2/adr-019-set.json`                           |
| S-019-3 | `spikes/S-019-3/spellcheck.mjs` (`probe`, `packaged`)            | all     | `S-019-3/S-019-3-probe.json`, `S-019-3/S-019-3-packaged.json`                |
| SP-03   | `spikes/SP-03/packagedCopy.mjs`                                  | all     | `SP-03/SP-03-<layout>.json` (win-zip, mac-zip/dmg-arm64, linux-appimage/deb) |
| S-008-1 | `spikes/S-008-1/bundledPackages.mjs`                             | all     | `S-008-1/S-008-1-bundled.json`, `S-008-1/S-008-1-bundled.md`                 |
| S-027-3 | `spikes/S-027-3/installerVsHost.mjs`                             | Windows | `S-027-3/S-027-3.json` (also the nsis layout's first-start copy for SP-03)   |
| S-027-1 | `spikes/S-027-1/scoopLayout.mjs` (`layout`, `scoop`, `portable`) | Windows | `S-027-1/S-027-1-layout.json`, `S-027-1-scoop.json`, `S-027-1-portable.json` |

Some of these steps build extra packages that are not release targets:

- **S-019-2** builds the same targets a second time into `release-fused/`, with the ADR-019 item 5 fuse set requested
  through electron-builder's `electronFuses` (`spikes/S-019-2/electron-builder.fused.cjs`). It then reads the fuse wire
  and the asar integrity of every unpacked app and every extracted artifact (`spikes/_packaged/extract.mjs`) in both
  builds, then starts the fused build once with the SP-03 harness to see whether its Host still comes up
  (`S-019-2/start/`). Flipping the fuses in the real release build is ISSUE-269's work.
- **S-027-3 and S-027-1** need an upgrade, so the Windows leg also packages the same commit at the next patch version
  (`release-next/`). S-027-1 also needs electron-builder's `portable` exe (`release-portable/`).

On Linux the S-019-3 traffic capture starts the AppImage, not `linux-unpacked`: that folder's `chrome-sandbox` is not
root-owned with mode 4755, so Chromium aborts there, while the AppImage and the installed deb start on the same image.

The Windows harnesses that start the app run as the standard user that `scripts/ci/run-unelevated.mjs` creates,
because the Host refuses to start elevated (ADR-002 D6). S-027-1 installs Scoop for that user with Scoop's official
one-line installer (`https://get.scoop.sh`) and serves the zips from `127.0.0.1` only. Every Scoop install and
uninstall hook logs the variables it can read (`$cmd`, `$app`, `$version`, `$global`, `$dir`) and its command line.
This shows whether `scoop update` runs `pre_uninstall` and how a hook can tell an update from an uninstall (OQ-59).
S-027-1 updates and uninstalls twice: first with the UI still running from the Scoop folder (Scoop then refuses), then
with the UI ended and only the Host running from its copy. S-027-3 ends the installed UI before the upgrade and before
the uninstall, for the same reason.

A harness that starts the app clears the current user's DwarfAI app data, Host copies and run files first, and again
when it ends. Before that last clear it copies the tail of the product's own log files (ADR-026, allowlisted fields)
into `<spike>/product-logs/`, so a run whose Host never starts still shows why. That is why it refuses to run outside GitHub Actions unless you pass `--allow-local`. Never pass that
flag on a machine whose DwarfAI data matters.

### Dispatch

```sh
gh workflow run spikes-package.yml --ref <branch or main>
gh run list --workflow spikes-package.yml --limit 1
gh run watch <run-id>
gh run download <run-id> --dir spike-evidence-<run-id>
```

You can also start it from the Actions tab: **Packaging spikes**, then **Run workflow**.

The optional input `relax_linux_userns` (default off) sets `kernel.apparmor_restrict_unprivileged_userns=0` on the
Linux leg before any app starts. Leave it off for the first run, so the record shows what a stock Ubuntu 24.04 does
with the AppImage and Chromium's sandbox. Turn it on only for a second run that needs the Host started on that layout.

### Reading the evidence

- There is one artifact per OS, `spike-evidence-<os>`, kept seven days. The installers themselves are not uploaded.
- Paths in the evidence are scrubbed (`<home>`, `<appdata>`, `<localappdata>`, `<user>`, `<host>`). Still run the
  `privacy-guard` skill before you copy any of it into `spike-results/<ID>/`.
- Each JSON file holds `environment` (date, OS, arch, Node, runner image) for the record's NFR-OBS-04 front matter.
- A harness step that fails turns the job red, but the steps after it still run. Read the evidence of every spike,
  not only the failed one.
- Zips on Windows are read with the system bsdtar (`%SystemRoot%\System32\tar.exe`). The `tar` first on the bash
  step's PATH is Git's GNU tar, which cannot read a zip and reads `D:\...` as a remote host (run 39130693732).
- The S-019-3 harness is the automated half of that spike. The manual traffic-capture procedure is
  `spikes/S-019-3/spellcheck-traffic.md`. The Scoop procedure for a real desktop is `spikes/S-027-1/scoop.md`.
- What the lane does not cover: S-027-4 (login entry) and S-018-2 (click raise) are re-checked on the packaged builds
  by hand (`spikes/S-027-4/clean-vm.md`, `spikes/S-018-2/click-raise.md`). The L8 test
  `spikes/S-027-3/installerVsHost.os.test.ts` asserts the S-027-3 verdict once the record exists.

### Runs

| Run         | Date       | Commit     | Outcome                                                                                                                                                                                                                                      | Records                                                                               |
| ----------- | ---------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 39130693732 | 2026-10-18 | `a222591f` | macOS green; Windows red (GNU `tar` on zips; nsis install folder not found; no Host from the Scoop install); Linux red (`linux-unpacked` sandbox abort in S-019-3). The harness and lane bugs are fixed in the branch that wrote the records | S-019-2, S-019-3, S-027-1, S-027-3 (new); SP-03, S-008-1, S-027-4, S-018-2 (appended) |
