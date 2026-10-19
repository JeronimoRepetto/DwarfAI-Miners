// Windows boot-identity sources beside the boot id (ADR-015 item 4; S-015-2). The boot id itself
// is the probe's (`probe/win32.ts`: the registry BootId counter), one derivation for both. The boot
// instant is CIM `Win32_OperatingSystem.LastBootUpTime`, read only here and never on the probe
// path: it can take longer than its 2 000 ms bound on a cold machine, and then only bootTimeMs is
// 'unknown'. The logon session is the logon SID of the Host's token as `whoami /logonid` prints it
// (S-015-2 measured it stable and fast; the package gap of ADR-015 item 4's token LUID).
import {
  BOOT_ID_QUERY_TIMEOUT_MS,
  POWERSHELL_DROPPED_ENV,
  parsed,
  windowsPowerShell,
  windowsSystemTool,
  type BootSourceReader,
  type QueryRunner
} from '../probe/types'
import { filetimeToEpochMs } from '../probe/win32'

const LOGON_SID = /^S-1-5-5-\d+-\d+$/

export function createWin32BootSources(deps: {
  runQuery: QueryRunner
  env?: Readonly<Record<string, string | undefined>>
}): BootSourceReader {
  return {
    sources: {
      bootId: 'registry PrefetchParameters BootId (reg.exe query)',
      bootTimeMs: 'Win32_OperatingSystem.LastBootUpTime (CIM), rounded to the second',
      logonSessionId: 'whoami /logonid (logon SID of the process token)'
    },
    async bootTimeMs() {
      const out = await deps.runQuery(
        windowsPowerShell(deps.env),
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToFileTime()'
        ],
        { timeoutMs: BOOT_ID_QUERY_TIMEOUT_MS, dropEnv: POWERSHELL_DROPPED_ENV }
      )
      // Rounded to the second, as ISSUE-018 did: two reads in one boot give the same instant.
      return parsed(out, (stdout) => {
        const epochMs = filetimeToEpochMs(stdout)
        return epochMs === null ? null : Math.round(epochMs / 1_000) * 1_000
      })
    },
    async logonSessionId() {
      const out = await deps.runQuery(windowsSystemTool('whoami.exe', deps.env), ['/logonid'], {
        timeoutMs: BOOT_ID_QUERY_TIMEOUT_MS
      })
      return parsed(out, (stdout) => {
        const sid = stdout.trim()
        return LOGON_SID.test(sid) ? sid : null
      })
    }
  }
}
