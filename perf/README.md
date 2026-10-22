# Perf cases

The perf lane, layer L11 of the testing strategy (`17` §1.11): measured budgets per OS, run nightly and on release tags
by `pnpm test:perf`, never on a pull request and never as a merge check. `docs/e2e.md` covers running it locally.

## Cases

| Case                        | What it records                                                                                                           | Since     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------- |
| `perf/idleScene.perf.ts`    | The idle scene's renderer CPU (NFR-PERF-04, NFR-OBS-03)                                                                   | ISSUE-283 |
| `perf/vetaIdle.perf.ts`     | Veta's idle CPU, renderer and whole app, in its two idle scenes (NFR-PERF-04, NFR-OBS-03)                                 | ISSUE-297 |
| `perf/valleScaling.perf.ts` | The Control room's frame time and CPU at 4, 8, 12 and 16 live mine columns, degradation on and off (S-034-1, NFR-PERF-10) | ISSUE-298 |

### The idle scene (`perf/idleScene.perf.ts`)

- **Scene.** Until Veta is built, the idle Panel: the built app (`DWARFAI_BUILD_PROFILE=e2e pnpm build`) on an isolated
  profile through the E2E launch harness (`17` §1.9), the Claude stub on `PATH`, no session, the first-run step
  answered, the Map page shown. Nothing is on the sprite frame clock. Veta's own idle cases are `perf/vetaIdle.perf.ts`.
- **Measure.** After a 10 s settle, one priming read and then 20 samples, one a second, of Electron's
  `app.getAppMetrics()`, read in the main process through Playwright's `evaluate` (no test hook in production code).
  Each sample is the Panel renderer's `cpu.percentCPUUsage` (its CPU since the previous read, as a percentage of one
  core); the renderer is the window's own process (`webContents.getOSProcessId()`). The same API serves every OS.
- **Record.** Each sample is `{ scene: 'panel-idle', process: 'renderer', api, cpu }`.
- **Budget.** The idle scene's motion budget is checked in `pnpm test` by `src/renderer/src/lib/sprite/idleBudget.ts`
  (one CSS loop, nothing on the frame clock). Its CPU has no number yet: per `17` §1.11 each OS is recorded without a
  gate until it has a baseline. The lead then records the baseline in `17` §1.11, and from the next release the release
  check fails on a regression beyond the margin stated there. A perf result never gates a pull request.

### Veta idle (`perf/vetaIdle.perf.ts`)

- **Scenes.** The built app in the E2E build profile, whose built-modes list contains Veta
  (`DWARFAI_BUILD_PROFILE=e2e pnpm build`, `17` §1.9), on an isolated profile, with the interactive Claude stub alone
  on `PATH`. One mine is declared and one stub dwarf launched; once its first turn ends it sleeps on its open mine
  column. The Panel then moves to Veta (A-N13 `moveToMode`, as ISSUE-294's lever will) and Veta shows `all-idle`:
  scene `veta-all-asleep`. The session is then ended (A-N29) and Veta contracts to the closed entrance, `no-sessions`:
  scene `veta-no-sessions`. One launch serves both.
- **Measure.** The same fixed window as the idle scene (10 s settle, one priming read, 20 samples one a second) of
  `app.getAppMetrics()`. Each read gives two samples: the Veta renderer's `cpu.percentCPUUsage` (`process: 'renderer'`)
  and the sum over every process the metrics list (`process: 'app'`, `_harness/appMetrics.mjs`). The detached Host is
  its own process outside Electron's metrics, so it is not in the app sum.
- **Record.** Each sample is `{ scene, process, api, cpu }`; with the runner's `{ os, date, commit, case }` each row is
  `{ os, date, scene, cpu }` evidence.
- **The hidden Panel.** While the dwarf sleeps in the shown Panel, a watch installed from the main process counts its
  sprite frame changes; it must see some, or the check would prove nothing. Over the asleep scene's window, with the
  Panel window hidden by the move, it must count none (ADR-025 item 7). The case measures both scenes before it fails
  this check, so the CPU is still recorded (see "A check that fails after measuring" below).
- **Run it alone.** `DWARFAI_BUILD_PROFILE=e2e pnpm build`, then `pnpm test:perf --case perf/vetaIdle.perf.ts`. About two
  minutes, one launch.

### Valle scaling (`perf/valleScaling.perf.ts`)

Spike S-034-1 (ADR-034 item 5): how many live mine columns the Control room can carry, measured before any Valle UI is
built. Its record is the spike's evidence; the lead sets the supported column count and the degradation rule in `17`
§1.11, and the case stays as the perf-lane regression for Valle scaling.

- **The page.** `perf/fixtures/controlRoom/`, a perf-only renderer entry. The case builds it with Vite into
  `out/perf/controlRoom/` (`buildPage.ts`; no electron-vite entry names it and no product source imports it, R13,
  held by `_harness/controlRoomIsolation.test.mjs`) and opens it in a bare Electron window (`electronMain.cjs`:
  sandboxed, no preload, no Host, no provider), with the E2E harness's `mainErrorGuard.cjs` preloaded so an error
  never opens a dialog. `?columns=<N>&degradation=on|off` lays out N columns side by side in one sideways scroller, each
  the Panel's own mine column (`MineColumn.vue`, unchanged) fed a fixture crew of three (working, idle, asleep), each on
  a sprite frame clock of its own (`createFrameClock` on the window's tick source). The window's content area is sized
  to four columns across and 720 px high; past four, the mosaic scrolls sideways.
- **The default degradation.** With `degradation=on`, one `IntersectionObserver` on the scroller pauses the clock of
  every column with no pixel inside the viewport (`pause()`, ISSUE-282) and resumes it when one scrolls in; a paused
  column paints the last frame it showed. `degradation=off` lets every clock run. Nothing is virtualized: every column
  stays in the DOM, so the Valle FLIP dive and climb and the saved scroll keep working.
- **Scenes.** For N in 4, 8, 12, 16 and the switch on and off: `idle` (the first four columns in view), `scrolled`
  (scrolled to the last four) and `sustained-scroll` (scrolled sideways 8 CSS px every animation frame, back and
  forth). Scene names are `control-room-<N>-degradation-<on|off>-<motion>`.
- **Measure.** One Electron app for the whole case and one page load per N and switch. After a 2 s settle, 5 CPU
  samples one a second of `app.getAppMetrics()` (the page's renderer and the whole app, `_harness/appMetrics.mjs`), and
  the frame time: the interval between consecutive animation frames, summarized as nearest-rank p50, p95, p99 and the
  maximum (`_harness/frameStats.mjs`). `idle` and `scrolled` sample CPU with no frame loop running and then measure
  frames over 3 s; `sustained-scroll` scrolls on every frame, so its CPU and frames share one window.
- **Record.** CPU samples are `{ scene, columns, degradation, motion, process, api, cpu }`, read by the release reader
  as NFR-PERF-10 rows; each scene adds one `{ scene, columns, degradation, motion, process: 'renderer', metric:
'frame-time', frameMs: { count, p50, p95, p99, max }, window }`, which the release reader skips (it has no CPU).
- **Checks.** At every N and switch, every column is in the DOM with its crew drawn (no virtualization). With the
  degradation on and N past four: over 2 s the columns outside the viewport ask their clock for no tick and paint no
  sprite frame while their strips still show a frame, and the columns in view do paint (so the check can fail); then
  the last column is scrolled into view and must resume within one animation frame, on the frames it held, and move
  again. A check that fails after a scene was measured carries the samples (see below).
- **Run it alone.** `pnpm test:perf --case perf/valleScaling.perf.ts`. About five minutes, one window on screen; it
  needs no `pnpm build` of the app, only the installed dependencies. Leave the machine otherwise idle.

## Release evidence

`perf/_harness/releaseEvidence.mjs` is the release-check reader of the perf lane (ADR-034 item 4; ADR-025
Verification). It reads every results file under a folder at any depth, for example the three `perf-results-<os>`
artifacts of a release-tag run downloaded side by side, and prints one row per OS, scene and process: samples, mean and
maximum CPU, date, commit and the requirements it is evidence for (`NFR-PERF-04`, `NFR-OBS-03`, and `NFR-PLAT` for the
Veta rows; `NFR-PERF-10` alone for the Control-room scaling rows).

```sh
node perf/_harness/releaseEvidence.mjs --from <folder> [--commit <released sha>]
```

- It fails (exit 1) when either Veta idle scene, for the Veta renderer or the app, is missing on Windows, macOS or Linux,
  and names each missing row. Every other scene is listed beside them.
- In CI the `perf-evidence` job runs it on every release tag once the three perf legs are done, over their
  downloaded `perf-results-<os>` artifacts and the tagged commit (`--from artifacts --commit "$GITHUB_SHA"`).
- It applies no CPU threshold: each OS is recorded without a gate until the lead records its baseline and margin in `17`
  §1.11. It reads only, and never runs on a pull request.

## Adding a case

1. Create `perf/<area>/<name>.perf.ts`. Anything under `perf/_harness/` is the runner, not a case.
2. Default-export a function, sync or async, that measures and returns its samples as an array of JSON values:

   ```ts
   export default async function run(): Promise<number[]> {
     const samples: number[] = []
     // measure here, for example with the E2E harness (e2e/_harness/launchApp.ts)
     return samples
   }
   ```

3. Run `pnpm test:perf`. The runner appends one record per case to `perf-results/<os>/<date>.json`:

   ```json
   {
     "os": "windows",
     "date": "2026-09-30",
     "commit": "<sha>",
     "case": "perf/<area>/<name>.perf.ts",
     "samples": []
   }
   ```

- Cases run one after the other in one process, so keep each short and leave the machine otherwise idle.
  `pnpm test:perf --case perf/<area>/<name>.perf.ts` runs one case alone.
- A case may import the E2E harness (`e2e/_harness/`, `e2e/support/`, the fixture worlds). The runner resolves a
  relative import written without its extension to its `.ts` file, as Playwright's loader does.
- **A check that fails after measuring.** A case that measured and then failed a check throws an `Error` carrying its
  samples (`Object.assign(error, { samples })`): the record keeps them and names the check in `failure`, the other
  cases still run, and the run fails.
- A case file is TypeScript that Node runs directly (type stripping): use only erasable syntax (no `enum`, no parameter
  properties) and write relative imports with their `.ts` extension.
- No threshold is read or applied yet. A measured budget without a number is recorded without a gate until each OS has a
  baseline; the lead then records it in `17` §1.11 and the release gate applies from the next release. A slow sample
  never fails the run; a case that throws, or returns something other than an array, does.
