# Perf cases

The perf lane, layer L11 of the testing strategy (`17` §1.11): measured budgets per OS, run nightly and on release tags
by `pnpm test:perf`, never on a pull request and never as a merge check. `docs/e2e.md` covers running it locally.

## Cases

| Case                     | What it records                                         | Since     |
| ------------------------ | ------------------------------------------------------- | --------- |
| `perf/idleScene.perf.ts` | The idle scene's renderer CPU (NFR-PERF-04, NFR-OBS-03) | ISSUE-283 |

### The idle scene (`perf/idleScene.perf.ts`)

- **Scene.** Until Veta is built, the idle Panel: the built app (`DWARFAI_BUILD_PROFILE=e2e pnpm build`) on an isolated
  profile through the E2E launch harness (`17` §1.9), the Claude stub on `PATH`, no session, the first-run step
  answered, the Map page shown. Nothing is on the sprite frame clock. Veta's own idle cases come with ISSUE-297.
- **Measure.** After a 10 s settle, one priming read and then 20 samples, one a second, of Electron's
  `app.getAppMetrics()`, read in the main process through Playwright's `evaluate` (no test hook in production code).
  Each sample is the Panel renderer's `cpu.percentCPUUsage` (its CPU since the previous read, as a percentage of one
  core); the renderer is the window's own process (`webContents.getOSProcessId()`). The same API serves every OS.
- **Record.** Each sample is `{ scene: 'panel-idle', process: 'renderer', api, cpu }`.
- **Budget.** The idle scene's motion budget is checked in `pnpm test` by `src/renderer/src/lib/sprite/idleBudget.ts`
  (one CSS loop, nothing on the frame clock). Its CPU has no number yet: per `17` §1.11 each OS is recorded without a
  gate until it has a baseline. The lead then records the baseline in `17` §1.11, and from the next release the release
  check fails on a regression beyond the margin stated there. A perf result never gates a pull request.

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
- A case file is TypeScript that Node runs directly (type stripping): use only erasable syntax (no `enum`, no parameter
  properties) and write relative imports with their `.ts` extension.
- No threshold is read or applied yet. A measured budget without a number is recorded without a gate until each OS has a
  baseline; the lead then records it in `17` §1.11 and the release gate applies from the next release. A slow sample
  never fails the run; a case that throws, or returns something other than an array, does.
