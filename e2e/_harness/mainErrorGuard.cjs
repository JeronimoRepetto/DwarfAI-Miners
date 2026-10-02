'use strict'
// Preloaded into a test-launched app's main process with Electron's `-r` switch (`launchApp.ts`), before the app's own
// main file runs: an uncaught exception while the main file loads (before the harness's own capture is installed
// through Playwright) is written to the file `DWARFAI_E2E_MAIN_ERRORS` names and ends the process with code 1, so
// Electron's default handler never opens its modal "A JavaScript error occurred in the main process" box on the desktop.
// The harness replaces this listener with its own capture once the app is up. Test-only; no production code loads it.
const fs = process.getBuiltinModule('node:fs')

const errorsFile = process.env.DWARFAI_E2E_MAIN_ERRORS

process.on('uncaughtException', (error, origin) => {
  const stack = error instanceof Error ? (error.stack ?? String(error)) : String(error)
  try {
    if (errorsFile)
      fs.appendFileSync(errorsFile, `[${origin} before the harness capture] ${stack}\n`)
  } catch {
    // The file could not be written: the exit code still tells the harness.
  }
  process.exit(1)
})
