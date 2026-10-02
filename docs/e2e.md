# E2E and perf lanes

The two release lanes of the rebuild: **E2E** (`pnpm test:e2e`, layer L9) and **perf** (`pnpm test:perf`, layer L11).
Both are required for a release and never for a merge: a flaky real-process lane must not block normal merges (testing
strategy `17` §1.13, §5.2, HO-38). CI runs them as their own jobs in `.github/workflows/ci.yml`; the required merge
check stays the `checks` job.

| Lane | Command          | CI trigger                                                                    | Runs on                      |
| ---- | ---------------- | ----------------------------------------------------------------------------- | ---------------------------- |
| E2E  | `pnpm test:e2e`  | push to `main`, nightly (03:00 UTC), `v*` tags, a pull request labelled `e2e` | Windows, macOS, Linux (Xvfb) |
| Perf | `pnpm test:perf` | nightly (03:00 UTC), `v*` tags                                                | Windows, macOS, Linux        |

## Running the E2E lane locally

```sh
pnpm exec install-electron              # once per checkout: the Electron binary (pnpm skips electron's install script)
DWARFAI_BUILD_PROFILE=e2e pnpm build    # the built app, with the E2E build profile
pnpm test:e2e
```

- The lane launches the **built** app (`out/`), never the dev server, with Playwright's `_electron`
  (`@playwright/test`, pinned). Rebuild after every source change.
- One worker, so one app at a time. Cases may retry once (`17` §5.4); a case that passed only on retry is reported as
  flaky. The harness self-test (`e2e/_harness/harness.e2e.ts`) never retries.
- A failed case keeps its folder under `test-results/e2e/` (git-ignored) with its Playwright trace; a passing case keeps
  nothing. Open a trace with `pnpm exec playwright show-trace <trace.zip>`.
- Beside the trace, `app-diagnostics/` keeps what the app itself did, which the trace (the page only) cannot show and the
  removed profile would lose: `main-lifecycle.log` (one JSON line per main-process event, written by the `-r` preload
  `e2e/_harness/mainLifecycleProbe.cjs`: each web contents' loads, navigations, failed loads, renderer exits and
  destruction; `ready`, `before-quit` and whether it was turned down, `will-quit`, `exit` with its code, `quit`; and
  every main-thread stall of 250 ms or more), `main-errors.log` when the main process threw, and the app's `logs/` (the
  UI log, 19 §9.1). CI uploads the folder with the trace (`e2e-traces-<os>`).
- On Linux without a display, run it as CI does: `xvfb-run --auto-servernum pnpm test:e2e`.

### The isolated profile

`e2e/_harness/launchApp.ts` starts every case under a fresh profile in a `mkdtemp` folder:

- a new `userData`, passed as `--user-data-dir`, so the app's single-instance lock and data never meet the developer's
  own app (and, once a Host exists, its `hostDataDir` and profile-keyed endpoint, ADR-002 D2);
- temp `CLAUDE_CONFIG_DIR` and `CODEX_HOME`, so the app never reads the developer's provider data;
- `stubs`: a directory of stub CLIs prepended to `PATH` (the stub kit lands with ISSUE-313);
- `launchApp` returns once the first window has loaded its page, as the page (its `load` event) and the main process
  (no window `isLoading()`, within 15 s) both see it, so no case quits a half-started app;
- `teardown()` quits the app, waits for its process to exit and removes the profile, within a quit budget
  (`quitTimeoutMs`, default 15 s). An app still running at the end of it is killed with its whole process tree
  (`taskkill /T` on Windows, the app's process group on macOS and Linux), and the teardown fails with "did not exit
  within … of app.quit()". A quit that never finishes is a visible failure in seconds, not a test timeout followed by a
  worker teardown timeout that leaves the app running.
- before that kill, the failure records the app's state: what the main process still answers (its windows and web
  contents, or no answer within 3 s) and, on macOS, a `sample` of every thread written as `quit-sample.txt` next to the
  case's trace. Windows still alive mean the quit was turned down; all destroyed mean it stalled after closing them; no
  answer means the main thread is blocked.
- the launched app's uncaught exceptions are recorded in the profile instead of opening Electron's modal "A JavaScript
  error occurred in the main process" box (which blocks the main thread until clicked), and the teardown fails with
  "uncaught exception in the main process: <stack>". The harness installs this through Playwright's main-process
  `evaluate`; production code is unchanged.

A case that needs two launches to share one profile (two builds meeting one person's data and Host, as in the rollback
rehearsal `e2e/cut-0/rollback-rehearsal.e2e.ts`) makes it with `createIsolatedProfile()` and passes it as
`launchApp({ profile })`. The teardown then keeps that profile and any Host it runs; the case removes both with
`disposeProfile(profile)` in its `finally`.

Assertions go through the UI, Playwright's main-process `evaluate`, or the profile's `dwarfai.db` opened read-only after
the Host exited (`e2e/_harness/readOnlyHost.ts`). There is no test backdoor in production code.

### The E2E build profile

The E2E build profile is build-time data (`17` §1.9): its built-modes list includes Veta and Valle before they ship, so
their L9 cases can run, while a release build lists a mode only from the issue that ships it. The lane selects it with
`DWARFAI_BUILD_PROFILE=e2e` at `pnpm build`. Nothing reads it yet: the built-modes list arrives with ISSUE-267, which
makes the build read this variable. The harness never changes what a build contains.

### Which entry a case launches

`launchApp({ entry })` (`e2e/_harness/resolveEntry.ts`):

| `entry`               | Main file                                           |
| --------------------- | --------------------------------------------------- |
| `'current'` (default) | `package.json` `main`, since cut 0 the ui-main file |
| `'ui-main'`           | `out/ui-main/index.js`                              |

`out/ui-main/index.js` is the output file of the UI-main composition root (`src/ui-main/index.ts`), which the app build
(`electron.vite.config.ts`, `main` target) writes. The cut-0 switch (ISSUE-056) made it `package.json` `main`, so both
values start the same entry; the legacy entry `src/main/index.ts` is no longer built. A build without the file is
refused with a clear message; the harness never falls back to another entry. The current entry starts from the app
folder, as the packaged app does, so Electron reads `package.json` and `app.getAppPath()` is the app folder.

## Running the perf lane locally

```sh
pnpm test:perf
```

`perf/_harness/runPerf.mjs` runs every `perf/**/*.perf.ts` case one after the other and appends one record per case to
`perf-results/<os>/<date>.json` (git-ignored locally; CI uploads it as the run's artifact). No threshold is applied yet
(`17` §1.11). `perf/README.md` explains how to add a case. Keep local runs short: a perf case measures this machine,
so nothing else heavy should run beside it.

## Measured answers to the UNVERIFIED items of `17` §1.9

For the lead to record in `17` §1.9. Measured with `@playwright/test` 1.63.0 and Electron 44.0.0 against today's built
app (legacy entry), on 2026-09-30.

| Item                                 | Windows 11                                                                                                                                                                                                                                                                                                                | macOS                                         | Linux (Xvfb)                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------- |
| Electron 44 support                  | Works: `_electron.launch`, `firstWindow()`, main-process `evaluate`, `app.context().tracing` and `close()`; `process.versions.electron` reads `44.0.0`. The harness self-test passes (3 of 3).                                                                                                                            | pending: first `e2e` CI run on `macos-latest` | pending: first `e2e` CI run on `ubuntu-latest` |
| Multi-window                         | Works: two more `BrowserWindow`s opened from the main process each arrive as a `window` event; `app.windows()` lists 3 pages, each with its own `title()`, `evaluate()` and locators.                                                                                                                                     | pending                                       | pending                                        |
| `emulateMedia` in an Electron window | Reaches the page: after `page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' })`, the renderer's `matchMedia('(prefers-reduced-motion: reduce)')` and `matchMedia('(prefers-color-scheme: dark)')` match. Not measured: whether main-process `nativeTheme` or the OS setting sees it (it is page emulation). | pending                                       | pending                                        |
| `sandbox: true` renderers            | Works: a window created with `webPreferences: { sandbox: true, contextIsolation: true }` is reached like any other (`title()`, `evaluate()`, locators). Today's Panel window runs with `sandbox: false`.                                                                                                                  | pending                                       | pending                                        |

Also observed: today's app starts to the tray with its first window loaded (`out/renderer/index.html`) but hidden until
the tray, the global shortcut or a second launch shows it; the harness smoke therefore asserts the loaded built page, not
visibility.
