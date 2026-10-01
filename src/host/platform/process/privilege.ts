// The Host's privilege facts at boot (ADR-002 D6; 07 S12.03, S12.04; 13 FM-011, FM-012). R18: the OS
// branching lives here, under host/platform; the boot (host/wiring/boot.ts) decides from the facts.
//
// - Elevated. Windows: the integrity label of the Host's token is high or above (S-1-16-12288 and
//   up). It is read from `whoami /groups` of System32 by path, as the label's SID, because group
//   names are localized. A child gets its parent's token, so whoami reports the Host's own level.
//   POSIX: the effective uid is root while the launching user is not root (ADR-002 D6 "root when
//   the UI user is not root"): the real uid is not root (a set-uid binary), or `sudo` / `pkexec`
//   named a non-root caller (SUDO_UID, PKEXEC_UID). A root login runs the UI as root too, so a root
//   Host there is not refused. Read in-process, no command.
// - In a job (Windows only): `IsProcessInJob` of the Host's own process, through Windows
//   PowerShell 5.1 by path. The script is passed with -EncodedCommand, and the Host's pid is the
//   only value put into it. Elsewhere there are no job objects: 'not-applicable'.
//
// Each Windows read is bounded and answers why it failed instead of rejecting; this module never
// guesses a value. What a failed read means is the boot's decision.
import {
  POWERSHELL_DROPPED_ENV,
  UNPARSEABLE,
  parsed,
  windowsPowerShell,
  windowsSystemTool,
  type QueryRunner,
  type ReadOutcome
} from './probe/types'

export interface PrivilegeReport {
  /** Whether the Host runs elevated (ADR-002 D6), or why it could not be read. */
  elevated: ReadOutcome<boolean>
  /** Windows `IsProcessInJob` for the Host's own process, or why it could not be read. */
  inJob: ReadOutcome<boolean> | 'not-applicable'
}

export type PrivilegeCheck = () => Promise<PrivilegeReport>

/**
 * The bound on each Windows read. The package names none; 5 000 ms is the bound the legacy probe
 * gave one OS query in production (`START_TIME_QUERY_TIMEOUT_MS`). Measured on Windows 11: whoami
 * answers in about 50 ms, the PowerShell job read in about 300 ms.
 */
export const PRIVILEGE_QUERY_TIMEOUT_MS = 5_000

/** The integrity RID from which a token counts as elevated: SECURITY_MANDATORY_HIGH_RID. */
const HIGH_INTEGRITY_RID = 0x3000

const INTEGRITY_LABEL = /"S-1-16-(\d+)"/

/** PROCESS_QUERY_LIMITED_INFORMATION: enough for IsProcessInJob on a process of the same user. */
const IN_JOB_SCRIPT = (pid: number): string =>
  [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -Namespace DwarfAI -Name JobProbe -MemberDefinition @'",
    '[DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);',
    '[DllImport("kernel32.dll", SetLastError = true)] public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);',
    '[DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr handle);',
    "'@",
    `$handle = [DwarfAI.JobProbe]::OpenProcess(0x1000, $false, ${Math.trunc(pid)})`,
    'if ($handle -eq [IntPtr]::Zero) { exit 3 }',
    '$inJob = $false',
    '$read = [DwarfAI.JobProbe]::IsProcessInJob($handle, [IntPtr]::Zero, [ref]$inJob)',
    '[void][DwarfAI.JobProbe]::CloseHandle($handle)',
    'if (-not $read) { exit 4 }',
    "if ($inJob) { 'True' } else { 'False' }"
  ].join('\n')

export interface PrivilegeCheckOptions {
  /** Which OS's rule to apply; default this process's OS. */
  platform?: 'win32' | 'darwin' | 'linux'
  /** Runs the Windows reads; required on Windows (the composition root passes the bounded runner). */
  runQuery?: QueryRunner
  /** SUDO_UID / PKEXEC_UID on POSIX, SystemRoot on Windows; default `process.env`. */
  env?: Readonly<Record<string, string | undefined>>
  /** The Host's pid; default `process.pid`. */
  pid?: number
  /** The POSIX real and effective uid; default `process.getuid()` / `process.geteuid()`. */
  ids?: () => { uid: number; euid: number }
}

export function createPrivilegeCheck(options: PrivilegeCheckOptions = {}): PrivilegeCheck {
  const platform = options.platform ?? thisPlatform()
  const env = options.env ?? process.env
  if (platform !== 'win32') {
    const ids = options.ids ?? processIds
    return () =>
      Promise.resolve({
        elevated: { ok: true, value: posixElevated(ids(), env) },
        inJob: 'not-applicable'
      })
  }
  const runQuery = options.runQuery
  if (runQuery === undefined) {
    throw new TypeError('createPrivilegeCheck: a QueryRunner is required on Windows')
  }
  const pid = options.pid ?? process.pid
  return async () => {
    const [elevated, inJob] = await Promise.all([
      readElevated(runQuery, env),
      readInJob(runQuery, env, pid)
    ])
    return { elevated, inJob }
  }
}

async function readElevated(
  runQuery: QueryRunner,
  env: Readonly<Record<string, string | undefined>>
): Promise<ReadOutcome<boolean>> {
  const out = await runQuery(
    windowsSystemTool('whoami.exe', env),
    ['/groups', '/fo', 'csv', '/nh'],
    { timeoutMs: PRIVILEGE_QUERY_TIMEOUT_MS }
  )
  return parsed(out, (stdout) => {
    const label = INTEGRITY_LABEL.exec(stdout)
    return label === null ? null : Number(label[1]) >= HIGH_INTEGRITY_RID
  })
}

async function readInJob(
  runQuery: QueryRunner,
  env: Readonly<Record<string, string | undefined>>,
  pid: number
): Promise<ReadOutcome<boolean>> {
  const encoded = Buffer.from(IN_JOB_SCRIPT(pid), 'utf16le').toString('base64')
  const out = await runQuery(
    windowsPowerShell(env),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { timeoutMs: PRIVILEGE_QUERY_TIMEOUT_MS, dropEnv: POWERSHELL_DROPPED_ENV }
  )
  if (!out.ok) return out
  const answer = out.stdout.trim()
  if (answer === 'True') return { ok: true, value: true }
  if (answer === 'False') return { ok: true, value: false }
  return UNPARSEABLE
}

/** ADR-002 D6 on POSIX: root, launched by a user who is not root. */
function posixElevated(
  ids: { uid: number; euid: number },
  env: Readonly<Record<string, string | undefined>>
): boolean {
  if (ids.euid !== 0) return false
  if (ids.uid !== 0) return true
  return [env['SUDO_UID'], env['PKEXEC_UID']].some(
    (value) => value !== undefined && /^\d+$/.test(value) && Number(value) !== 0
  )
}

function processIds(): { uid: number; euid: number } {
  // Defined on every POSIX platform (Node `process.getuid`); never called on Windows.
  return { uid: process.getuid?.() ?? -1, euid: process.geteuid?.() ?? -1 }
}

function thisPlatform(): 'win32' | 'darwin' | 'linux' {
  return process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux'
}
