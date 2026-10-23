#!/usr/bin/env node
/**
 * The demo's command line: `pnpm demo` (a visible, scripted showcase to record) and `pnpm demo:shots` (`--shots`, the
 * PNGs of each mode). See docs/demo.md and `args.mjs` for the options. It builds nothing: run `pnpm build` first.
 *
 * The runner reuses the E2E harness (`e2e/_harness/`, `e2e/support/`), TypeScript that Node runs with its type
 * stripping; a relative specifier without an extension that Node cannot find is tried again with `.ts`, as the perf
 * runner does (`perf/_harness/runPerf.mjs`). Nothing in the product imports this folder.
 */
import { registerHooks } from 'node:module'
import { parseDemoArgs, USAGE } from './args.mjs'
import { SCENARIOS } from './scenario.mjs'

const EXTENSIONLESS_RELATIVE = /^\.{1,2}\/(?:[^/]+\/)*[^/.]+$/

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !EXTENSIONLESS_RELATIVE.test(specifier))
        throw error
      return nextResolve(`${specifier}.ts`, context)
    }
  }
})

const parsed = parseDemoArgs(process.argv.slice(2), Object.keys(SCENARIOS))
if (!parsed.ok) {
  process.stderr.write(`${parsed.error}\n\n${USAGE}\n`)
  process.exitCode = 2
} else if (parsed.options.help) {
  process.stdout.write(`${USAGE}\n`)
} else {
  const { runDemo } = await import('./run.mjs')
  process.exitCode = await runDemo(parsed.options)
}
