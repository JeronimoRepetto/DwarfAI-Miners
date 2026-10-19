#!/usr/bin/env node
// A tiny stub process for the ProcessControl tests (ISSUE-018; 17 §1.8: processes under test are
// stubs, never provider CLIs). Started as `node sleeper.mjs <mode> ...` with no shell.
//
//   echo [args...]   prints {"args": [...], "env": {...}} on stdout (exactly the argv after the mode
//                    and the environment it received) and exits 0
//   sleep [maxMs]    stays alive until its stdin ends or maxMs pass (default 30000), then exits 0;
//                    the cap keeps a forgotten stub from outliving its test run
const [mode, ...rest] = process.argv.slice(2)

if (mode === 'echo') {
  process.stdout.write(JSON.stringify({ args: rest, env: { ...process.env } }))
} else if (mode === 'sleep') {
  const maxMs = Number(rest[0] ?? 30_000)
  const cap = setTimeout(() => process.exit(0), Number.isFinite(maxMs) ? maxMs : 30_000)
  process.stdin.on('end', () => {
    clearTimeout(cap)
    process.exit(0)
  })
  process.stdin.resume()
} else {
  process.stderr.write(`sleeper: unknown mode ${JSON.stringify(mode)}\n`)
  process.exit(2)
}
