/**
 * The demo's command line (`pnpm demo`, `pnpm demo:shots`, docs/demo.md): pure, so its rules are unit-tested without
 * starting anything. Answers `{ ok: true, options }` or `{ ok: false, error }` with the reason in words.
 *
 * - `--scenario <name>`: the scripted scenario (`scenario.mjs` SCENARIOS), `showcase` by default.
 * - `--speed <n>`: every scripted delay divided by `n`, from 0.25 to 10. The Host's own clocks (a dwarf falls asleep
 *   after 60 s, a missing folder is noticed within 30 s) do not change with it.
 * - `--duration <seconds>`: ends the demo by itself after that long (at least 10 s), as Ctrl+C would.
 * - `--keep`: the isolated profile stays on disk after the demo ends (the Host still stops).
 * - `--shots` and `--out <folder>`: capture the PNGs instead of holding the scenario open (`pnpm demo:shots`).
 * - `--sound`: let the app play its sound (muted by default). `--notifications`: let the OS notifications show
 *   (recorded instead by default, so a run never pops a toast or plays a chime on the machine).
 */

/** The fastest and slowest scripted pace the demo accepts. */
export const SPEED_RANGE = Object.freeze({ min: 0.25, max: 10 })

const FLAGS = Object.freeze({
  '--keep': 'keep',
  '--shots': 'shots',
  '--sound': 'sound',
  '--notifications': 'notifications',
  '--help': 'help',
  '-h': 'help'
})

const VALUED = new Set(['--scenario', '--speed', '--out', '--duration'])

/** Parses `argv` (without node and the script); `known` lists the scenario names. */
export function parseDemoArgs(argv, known = ['showcase']) {
  const options = {
    scenario: 'showcase',
    keep: false,
    speed: 1,
    shots: false,
    out: null,
    sound: false,
    notifications: false,
    help: false,
    duration: null
  }
  for (let at = 0; at < argv.length; at++) {
    const arg = argv[at]
    if (Object.hasOwn(FLAGS, arg)) {
      options[FLAGS[arg]] = true
      continue
    }
    const eq = arg.indexOf('=')
    const name = eq > 0 ? arg.slice(0, eq) : arg
    if (!VALUED.has(name)) return { ok: false, error: `unknown option "${arg}"` }
    let value
    if (eq > 0) value = arg.slice(eq + 1)
    else {
      value = argv[at + 1]
      if (value === undefined || value.startsWith('--')) {
        return { ok: false, error: `${name} needs a value` }
      }
      at++
    }
    if (name === '--scenario') {
      if (!known.includes(value)) {
        return { ok: false, error: `unknown scenario "${value}" (known: ${known.join(', ')})` }
      }
      options.scenario = value
    } else if (name === '--speed') {
      const speed = /^\d+(\.\d+)?$/.test(value) ? Number(value) : Number.NaN
      if (!(speed >= SPEED_RANGE.min && speed <= SPEED_RANGE.max)) {
        return {
          ok: false,
          error: `--speed takes a number from ${SPEED_RANGE.min} to ${SPEED_RANGE.max}, not "${value}"`
        }
      }
      options.speed = speed
    } else if (name === '--duration') {
      const seconds = /^\d+$/.test(value) ? Number(value) : Number.NaN
      if (!(seconds >= 10)) {
        return { ok: false, error: `--duration takes whole seconds, at least 10, not "${value}"` }
      }
      options.duration = seconds
    } else {
      options.out = value
    }
  }
  if (options.out !== null && !options.shots)
    return { ok: false, error: '--out is only for --shots' }
  return { ok: true, options }
}

/** The usage text `--help` prints. */
export const USAGE = [
  'Usage: pnpm demo [--scenario showcase] [--speed <0.25-10>] [--duration <seconds>] [--keep] [--sound]',
  '                 [--notifications]',
  '       pnpm demo:shots [--out <folder>] [--speed <0.25-10>] [--keep]',
  '',
  'Runs the built app (run `pnpm build` first) on an isolated profile with stub provider CLIs and a',
  'scripted scenario. Ctrl+C, or Stop everything and quit in the app, ends it. See docs/demo.md.'
].join('\n')
