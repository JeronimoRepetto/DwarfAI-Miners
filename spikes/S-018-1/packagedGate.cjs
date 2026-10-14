'use strict'
// Spike S-018-1, packaged kit: the arming gate of the packaged spike app (`packagedMain.cjs`).
//
// The packaged spike app is its own bundle (`packagedTrayApp.mjs build`), never part of the product build. Even so,
// a person can double-click it in Finder, and macOS may pass its own arguments (`-psn_…`). So the app does nothing
// unless its command line carries the exact arming flag, which only `packagedTrayApp.mjs run` passes. The settings
// travel as `--s0181-*` arguments, not as environment variables, because `open --args` (LaunchServices) carries
// arguments and an inherited shell environment must never arm it.

const ARM_FLAG = '--dwarfai-spike-s0181'
const MODES = ['none', 'record', 'click']

/** `--s0181-<name>=<value>` → the `S0181_*` variable `trayApp.cjs` reads, with its check. */
const SETTINGS = {
  mode: ['S0181_MODE', (value) => (MODES.includes(value) ? null : `mode must be one of ${MODES}`)],
  'idle-ms': ['S0181_IDLE_MS', (value) => wholeMs(value, 'idle')],
  'wait-ms': ['S0181_WAIT_MS', (value) => wholeMs(value, 'wait')],
  events: ['S0181_EVENTS', (value) => (value ? null : 'events needs a file path')],
  'user-data': ['S0181_USER_DATA', (value) => (value ? null : 'user-data needs a folder path')]
}

function wholeMs(value, name) {
  return /^\d+$/.test(value) ? null : `${name} must be a whole number of milliseconds`
}

/**
 * The `S0181_*` settings for an armed start, or `null` when the command line does not carry the exact arming flag
 * (the app must then do nothing). Throws on an armed start with an unknown or invalid `--s0181-*` argument.
 */
function spikeEnvFromArgv(argv) {
  if (!argv.includes(ARM_FLAG)) return null
  const env = {}
  for (const arg of argv) {
    if (!arg.startsWith('--s0181-')) continue
    const separator = arg.indexOf('=')
    const name = arg.slice('--s0181-'.length, separator < 0 ? undefined : separator)
    const value = separator < 0 ? '' : arg.slice(separator + 1)
    const setting = SETTINGS[name]
    if (!setting)
      throw new Error(
        `unknown spike argument ${arg.slice(0, separator < 0 ? undefined : separator)}`
      )
    const problem = setting[1](value)
    if (problem) throw new Error(problem)
    env[setting[0]] = value
  }
  return env
}

/** The command line `packagedTrayApp.mjs run` passes to the packaged app: the arming flag first, then the settings. */
function spikeArgs({ mode, idleMs, waitMs, eventsFile, userData }) {
  return [
    ARM_FLAG,
    `--s0181-mode=${mode}`,
    `--s0181-idle-ms=${String(idleMs)}`,
    `--s0181-wait-ms=${String(waitMs)}`,
    `--s0181-events=${eventsFile}`,
    `--s0181-user-data=${userData}`
  ]
}

module.exports = { ARM_FLAG, spikeEnvFromArgv, spikeArgs }
