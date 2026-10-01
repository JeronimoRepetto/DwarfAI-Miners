// The pure half of run-unelevated.mjs (ISSUE-051): how a Windows CI leg runs a command as a standard local user.
//
// GitHub's hosted Windows runner runs every step elevated (an administrator with UAC off), while the package assumes a
// test user who is not elevated (ISSUE-021 L8: "the privilege check reports not elevated for the test user"), and the
// DwarfAI Host refuses to start elevated (ADR-002 D6). The steps that run the real Host therefore run as a standard
// local user created in the job. Nothing here changes the Host: the gap is closed in CI only.

/** The variable that carries the user's password from the wrapper to its PowerShell launcher, never in argv. */
export const PASSWORD_ENV = 'DWARFAI_CI_USER_PASSWORD'

/**
 * The variables the standard user takes from its own profile, not from the elevated job: its profile folders and
 * temporary folder, its name, and the password.
 */
const PROFILE_VARIABLES = new Set(
  [
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'TEMP',
    'TMP',
    'HOME',
    'HOMEDRIVE',
    'HOMEPATH',
    'USERNAME',
    'USERDOMAIN',
    'USERDOMAIN_ROAMINGPROFILE',
    PASSWORD_ENV
  ].map((name) => name.toUpperCase())
)

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const LOWER = 'abcdefghijkmnopqrstuvwxyz'
const DIGITS = '23456789'
const SYMBOLS = '-_.!'
const ALPHABET = UPPER + LOWER + DIGITS + SYMBOLS

/**
 * A 24-character password from `random(n)` bytes. It holds an upper-case letter, a lower-case letter, a digit and a
 * symbol (the Windows complexity rule), and none of the characters a command line or `net user` reads specially.
 */
export function generatePassword(random) {
  const bytes = random(24)
  const pick = (set, byte) => set[byte % set.length]
  const chars = [
    pick(UPPER, bytes[0]),
    pick(LOWER, bytes[1]),
    pick(DIGITS, bytes[2]),
    pick(SYMBOLS, bytes[3])
  ]
  for (let index = 4; index < 24; index += 1) chars.push(pick(ALPHABET, bytes[index]))
  return chars.join('')
}

/**
 * The environment the command runs with: the job's (PATH, TZ, LANG, CI, …) without the elevated user's profile
 * variables and the password, plus git's trust of the checkout, which the elevated user owns (git refuses another
 * owner's repository otherwise).
 */
export function childEnvironment(env) {
  const child = {}
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !PROFILE_VARIABLES.has(name.toUpperCase())) child[name] = value
  }
  return {
    ...child,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'safe.directory',
    GIT_CONFIG_VALUE_0: '*'
  }
}

/** The integrity level's RID from `whoami /groups /fo csv /nh` (the `S-1-16-<rid>` label), or null without one. */
export function integrityRid(whoamiCsv) {
  const match = /"S-1-16-(\d+)"/.exec(whoamiCsv)
  return match === null ? null : Number(match[1])
}

/** High integrity (SECURITY_MANDATORY_HIGH_RID) or above, or an unreadable level, counts as elevated. */
export function isElevatedRid(rid) {
  return rid === null || rid >= 0x3000
}

/** `--probe`, or the command after `--`. */
export function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === '--probe') return { kind: 'probe' }
  if (argv[0] === '--' && argv.length > 1) return { kind: 'run', command: argv.slice(1).join(' ') }
  return { kind: 'usage' }
}
