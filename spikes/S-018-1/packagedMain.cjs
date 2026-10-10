'use strict'
// Spike S-018-1, packaged kit: the `main` of the packaged spike app that `packagedTrayApp.mjs build` makes. It is
// never part of the product build.
//
// Started without the exact arming flag (a double click in Finder, the Dock, `open` without `--args`), it ends at
// once and does nothing: no tray icon, no notification, no file. Armed by `packagedTrayApp.mjs run`, it turns its
// `--s0181-*` arguments into the `S0181_*` settings and runs the same `trayApp.cjs` the npm-Electron harness runs.
// Like `trayApp.cjs`, an error is printed and ends the process; it never opens a modal.

const load = process.getBuiltinModule('node:module').createRequire(__filename)

let env
try {
  env = load('./packagedGate.cjs').spikeEnvFromArgv(process.argv)
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ event: 'error', where: 'arguments', message: String(error.message) })}\n`
  )
  process.exit(64)
}

if (env === null) {
  process.exit(0)
} else {
  Object.assign(process.env, env)
  load('./trayApp.cjs')
}
