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

/**
 * The environment of a Windows PowerShell 5.1 the wrapper starts: the job's without `PSModulePath`. A pwsh (7) step
 * sets it to its own module folders, and 5.1 then cannot load its own modules (`CouldNotAutoloadMatchingModule`, the
 * same rule as the Host's POWERSHELL_DROPPED_ENV).
 */
export function windowsPowerShellEnvironment(env) {
  const child = {}
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && name.toUpperCase() !== 'PSMODULEPATH') child[name] = value
  }
  return child
}

/**
 * The Windows PowerShell 5.1 script that creates the standard local user `user`, or resets its password, from the
 * password in the variable `passwordEnv` (never in argv), and adds it to Users (well-known SID S-1-5-32-545, which
 * holds the right to log on interactively; the SID, because group names are localized). Never Administrators.
 */
export function ensureUserScript(user, passwordEnv) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$password = ConvertTo-SecureString $env:${passwordEnv} -AsPlainText -Force`,
    `$user = Get-LocalUser -Name '${user}' -ErrorAction SilentlyContinue`,
    `if ($null -eq $user) { New-LocalUser -Name '${user}' -Password $password -PasswordNeverExpires -AccountNeverExpires -Description 'DwarfAI CI non-elevated test user' | Out-Null } else { Set-LocalUser -Name '${user}' -Password $password }`,
    `try { Add-LocalGroupMember -SID 'S-1-5-32-545' -Member '${user}' } catch [Microsoft.PowerShell.Commands.MemberExistsException] { }`,
    `Write-Output 'run-unelevated: user ${user} ready (member of Users)'`
  ].join('\n')
}

/**
 * How the probe waits, after the first logon of the freshly created user, for the runner to be quiet again: one CPU
 * sample a second; settled once `quiet` samples in a row are below `threshold` (a quarter of the runner, less than one
 * of its four cores busy), and never longer than `capMs`. That logon starts background work which outlives it (main
 * run 36910936637: the probe's logon took 152 s instead of 17 to 34 s, and a plain `node` start in the OS lane that
 * followed went past 10 s).
 */
export const SETTLE = Object.freeze({
  threshold: 0.25,
  quiet: 5,
  intervalMs: 1_000,
  capMs: 300_000
})

const total = (times) => times.user + times.nice + times.sys + times.idle + times.irq

/** The non-idle share, from 0 to 1, of all CPU time elapsed between two `os.cpus()` readings. */
export function cpuBusyFraction(before, after) {
  let elapsed = 0
  let idle = 0
  after.forEach((cpu, index) => {
    elapsed += total(cpu.times) - total(before[index].times)
    idle += cpu.times.idle - before[index].times.idle
  })
  return elapsed <= 0 ? 0 : (elapsed - idle) / elapsed
}

/** True once the last `quiet` busy fractions in `samples` are all below `threshold`. */
export function isSettled(samples, { threshold, quiet }) {
  if (samples.length < quiet) return false
  return samples.slice(-quiet).every((busy) => busy < threshold)
}

/**
 * The `count` processes that used the most CPU seconds between two `Get-Process | Select-Object Id, ProcessName, CPU`
 * snapshots (ConvertTo-Json answers a lone process as an object). A process absent from the first snapshot counts from
 * zero; one whose CPU time is unreadable (null) is left out.
 */
export function topCpuConsumers(before, after, count) {
  const list = (snapshot) => (Array.isArray(snapshot) ? snapshot : [snapshot])
  const earlier = new Map(list(before).map((process) => [process.Id, process.CPU ?? 0]))
  return list(after)
    .filter((process) => typeof process.CPU === 'number')
    .map((process) => ({
      id: process.Id,
      name: process.ProcessName,
      seconds: process.CPU - (earlier.get(process.Id) ?? 0)
    }))
    .filter((process) => process.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, count)
}
