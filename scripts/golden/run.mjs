/*
 * `pnpm test:golden` (#634). Decides whether the golden UI tests may run before starting
 * anything: with the design repository found it runs `vitest.golden.config.ts`; without it, it
 * fails locally with the command that fixes it, and on CI it prints one line and exits cleanly,
 * because the references never leave the maintainer's machine (PO ruling G-02, 2026-09-26). A
 * configured location with the wrong shape fails everywhere. design.mjs holds the rules.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decide, locateDesign, nodeFs } from './design.mjs'

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const decision = decide(locateDesign({ checkout, env: process.env, fs: nodeFs }), process.env)

if (decision.action === 'skip') {
  console.log(decision.message)
} else if (decision.action === 'fail') {
  console.error(decision.message)
  process.exitCode = 1
} else {
  // vitest's package exports hide its bin, so it is found through its package.json.
  const manifest = createRequire(import.meta.url).resolve('vitest/package.json')
  const vitest = path.join(path.dirname(manifest), 'vitest.mjs')
  const result = spawnSync(
    process.execPath,
    [vitest, 'run', '--config', 'vitest.golden.config.ts', ...process.argv.slice(2)],
    { cwd: checkout, stdio: 'inherit' }
  )
  process.exitCode = result.status ?? 1
}
