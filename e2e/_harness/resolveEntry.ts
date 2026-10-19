import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * Which Electron main file an E2E case launches (testing strategy `17` §1.9; ISSUE-312 review
 * R8B-02, lead decision 2026-09-30).
 *
 * - `'current'` (the default) is the build's Electron main entry: `package.json` `main`, since the
 *   cut-0 switch (ISSUE-056) the UI-main composition root's output `out/ui-main/index.js`.
 * - `'ui-main'` is that output by its path (`src/ui-main/index.ts`, built by the app build;
 *   `docs/e2e.md`).
 *
 * Since the switch `main` names that same output, so both values start the same entry. A missing
 * output is refused with a clear message; there is never a silent fallback to another entry.
 */
export type AppEntry = 'current' | 'ui-main'

/** The UI-main target's output, relative to the app folder (the one holding `package.json`). */
export const UI_MAIN_OUTPUT = path.join('out', 'ui-main', 'index.js')

/**
 * The absolute main file for `entry` in the app folder `appDir`, whose `package.json` `main` is
 * `build.main`. Throws when the build has no such output.
 */
export function resolveEntry(
  entry: AppEntry | undefined,
  appDir: string,
  build: { readonly main: string; readonly exists?: (file: string) => boolean }
): string {
  const exists = build.exists ?? existsSync
  if (entry === 'ui-main') {
    const file = path.join(appDir, UI_MAIN_OUTPUT)
    if (!exists(file)) {
      throw new Error(
        `The build has no ui-main output (${file}). Build the UI-main composition root's target ` +
          `(later: ISSUE-042) with pnpm build; the harness never falls back to the current entry.`
      )
    }
    return file
  }
  const file = path.resolve(appDir, build.main)
  if (!exists(file)) {
    throw new Error(`The build has no Electron main entry (${file}). Run pnpm build first.`)
  }
  return file
}
