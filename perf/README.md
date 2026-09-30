# Perf cases

The perf lane, layer L11 of the testing strategy (`17` §1.11): measured budgets per OS, run nightly and on release tags
by `pnpm test:perf`, never on a pull request and never as a merge check. `docs/e2e.md` covers running it locally.

No case exists yet: the first measured scene comes with ISSUE-283 (the idle scene's CPU).

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
