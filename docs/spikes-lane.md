# Spike lanes on GitHub-hosted runners

Some spikes need real packaged artifacts or a clean OS user, which an agent machine does not have. Their harnesses
run in manual-dispatch workflows on GitHub-hosted runners, and each run uploads scrubbed evidence. A person then
writes the spike record (`spike-results/<ID>.md`, testing strategy `17` §4) from that evidence. A workflow run never
writes a record and never publishes anything.

## Existing harnesses (`spikes.yml`)

`.github/workflows/spikes.yml` runs the existing spike harnesses on GitHub's hosted runners when the owner dispatches
it. It exists so that the macOS and Linux rows of `spike-results/<ID>.md` (and the Windows rows still missing) come
from CI instead of the owner's machines. Spike rules (record form, verdict wording, raw outputs) are the testing
strategy's (`17` §4); this page only says how to run the lane and turn its output into records.

The lane is manual only, holds `contents: read`, reads no secret, signs and publishes nothing, and never uses a
provider CLI or a person's account. Spikes that need a provider login stay in the real-CLI lane on the maintainer's
machine (`17` §5.5).

### What it runs

| Spike   | Issue     | Job                 | Runners                                                        | Harness                                                                                      |
| ------- | --------- | ------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| SP-16   | ISSUE-322 | `keyring`           | Windows, macOS, Linux with a Secret Service, Linux without one | `spikes/SP-16` under `ELECTRON_RUN_AS_NODE`, plus the secret-store adapter's OS tests        |
| SP-04   | ISSUE-314 | `packaged`          | Windows, macOS (`macos-15`), Linux                             | `spikes/SP-04/packagedHost.mjs`: its throw-away app, then the real app (`--exe`)             |
| SP-03   | ISSUE-315 | `packaged`          | Windows, macOS (`macos-15`), Linux                             | `spikes/SP-03` over the Electron runtime, the unpacked app, the AppImage and the deb         |
| SP-05   | ISSUE-314 | `os-lane`           | macOS, Linux                                                   | `spikes/SP-05/posixAccess.os.test.ts`: the `nobody` account against the socket and run files |
| S-019-1 | ISSUE-315 | `sandboxed-preload` | Linux (Xvfb)                                                   | `spikes/S-019-1` (Playwright, over `pnpm build`)                                             |
| S-030-1 | ISSUE-318 | `os-lane`           | Windows, macOS, Linux                                          | `spikes/S-030-1`                                                                             |
| S-027-4 | ISSUE-318 | `os-lane`           | Windows, macOS, Linux                                          | `spikes/S-027-4` (write, read back, start and remove the login entry)                        |

What the lane cannot answer stays an owner step in each record: the macOS Keychain prompt (a hosted runner has no one
to answer it, so SP-16's cross-copy read records a timeout or an error instead), a signed and notarized `.app`
(SP-03), a real sign-out and sign-in (S-027-4), a real second Windows user or remote machine (SP-05 Windows), and a
drag from the OS file manager (S-019-1).

### Dispatch

```sh
gh workflow run spikes.yml --ref main -f spikes=all
gh workflow run spikes.yml --ref main -f spikes="SP-16,S-019-1"
gh run list --workflow spikes.yml --limit 1
gh run watch <run-id>
```

`spikes` is `all` or ids separated by commas or spaces. An unknown id fails the `plan` job before any runner starts.

### Turn the artifacts into records

Each job uploads `coverage/spike-reports/` as an artifact named `spike-<job>-<os>[-<leg>]`, kept seven days. Download
them into a scratch folder outside the repository:

```sh
gh run download <run-id> --dir <scratch>/spike-run-<run-id>
```

Each folder holds the harness outputs (`SP-16-<platform>-<leg>.json`, `SP-04-<OS>-throwaway.json` and
`SP-04-<OS>-app.json`, `SP-03-<OS>.json`, `SP-05-<platform>-posix.json`, `S-019-1-linux.json`,
`S-030-1-<platform>.json`, `S-027-4-<platform>.json`) and one `environment-<label>.json` with the runner image, OS
release, Node, Electron, electron-builder and `@napi-rs/keyring` versions, the commit, the run id and the date.

Then, per spike:

1. Read each JSON before it goes into a tracked file (`skills/privacy-guard`). The harnesses scrub the workspace,
   temp and home paths and the account name, but check anyway.
2. Copy it to `spike-results/<ID>/` with an OS-shaped name, as the existing files are named, for example
   `spike-results/SP-16/linux-ci-secret-service.json` or `spike-results/SP-03/macos-ci-versioned-copy.json`.
3. In `spike-results/<ID>.md`, add the OS and versions from `environment-<label>.json` to the front matter (`os`,
   `versions`, and the run id as `ci-run`), add the command (`gh workflow run spikes.yml -f spikes=<ID>`, run
   `<run-id>`) and the result rows under "Results", and say the run was on a hosted CI runner, not a person's machine.
4. Set the verdict only as `17` §4 and the record's own "Decision" allow: a CI row answers the scripted half; an owner
   step the lane cannot run stays listed as not run.
5. Commit the record with its raw outputs: `docs(spikes): record <ID> on <OS> from the spike lane`.

### Running a harness locally

Every harness also runs on a developer machine, on its own OS only:

```sh
SPIKE_REPORT_DIR=coverage/spike-reports pnpm vitest run --config vitest.os.config.ts spikes/SP-16
node spikes/SP-04/packagedHost.mjs --exe <packaged executable> --out <file>
```

`spikes/SP-05/posixAccess.os.test.ts` needs `sudo -n` (no password) and `python3`, and is skipped without them.

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
  builds. Flipping the fuses in the real release build is ISSUE-269's work.
- **S-027-3 and S-027-1** need an upgrade, so the Windows leg also packages the same commit at the next patch version
  (`release-next/`). S-027-1 also needs electron-builder's `portable` exe (`release-portable/`).

The Windows harnesses that start the app run as the standard user that `scripts/ci/run-unelevated.mjs` creates,
because the Host refuses to start elevated (ADR-002 D6). S-027-1 installs Scoop for that user with Scoop's official
one-line installer (`https://get.scoop.sh`) and serves the zips from `127.0.0.1` only. Every Scoop install and
uninstall hook logs the variables it can read (`$cmd`, `$app`, `$version`, `$global`, `$dir`) and its command line.
This shows whether `scoop update` runs `pre_uninstall` and how a hook can tell an update from an uninstall (OQ-59).

A harness that starts the app clears the current user's DwarfAI app data, Host copies and run files first, and again
when it ends. That is why it refuses to run outside GitHub Actions unless you pass `--allow-local`. Never pass that
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
- The S-019-3 harness is the automated half of that spike. The manual traffic-capture procedure is
  `spikes/S-019-3/spellcheck-traffic.md`. The Scoop procedure for a real desktop is `spikes/S-027-1/scoop.md`.
- What the lane does not cover: S-027-4 (login entry) and S-018-2 (click raise) are re-checked on the packaged builds
  by hand (`spikes/S-027-4/clean-vm.md`, `spikes/S-018-2/click-raise.md`). The L8 test
  `spikes/S-027-3/installerVsHost.os.test.ts` asserts the S-027-3 verdict once the record exists.
