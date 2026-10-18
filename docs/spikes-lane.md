# The spike lane

`.github/workflows/spikes.yml` runs the existing spike harnesses on GitHub's hosted runners when the owner dispatches
it. It exists so that the macOS and Linux rows of `spike-results/<ID>.md` (and the Windows rows still missing) come
from CI instead of the owner's machines. Spike rules (record form, verdict wording, raw outputs) are the testing
strategy's (`17` §4); this page only says how to run the lane and turn its output into records.

The lane is manual only, holds `contents: read`, reads no secret, signs and publishes nothing, and never uses a
provider CLI or a person's account. Spikes that need a provider login stay in the real-CLI lane on the maintainer's
machine (`17` §5.5).

## What it runs

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

## Dispatch

```sh
gh workflow run spikes.yml --ref main -f spikes=all
gh workflow run spikes.yml --ref main -f spikes="SP-16,S-019-1"
gh run list --workflow spikes.yml --limit 1
gh run watch <run-id>
```

`spikes` is `all` or ids separated by commas or spaces. An unknown id fails the `plan` job before any runner starts.

## Turn the artifacts into records

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

## Running a harness locally

Every harness also runs on a developer machine, on its own OS only:

```sh
SPIKE_REPORT_DIR=coverage/spike-reports pnpm vitest run --config vitest.os.config.ts spikes/SP-16
node spikes/SP-04/packagedHost.mjs --exe <packaged executable> --out <file>
```

`spikes/SP-05/posixAccess.os.test.ts` needs `sudo -n` (no password) and `python3`, and is skipped without them.
