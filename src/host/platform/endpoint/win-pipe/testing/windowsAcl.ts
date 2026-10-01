// Test support for the Windows OS lane (L8): the owner and the DACL of files and directories, every
// principal as its full SID (never an SDDL alias or a localized name, SP-05 finding 7).
//
// icacls cannot report the owner, so Windows PowerShell 5.1's Get-Acl is read by its System32 path,
// once for every path, with the paths in the environment (no shell, no quoting), through the Host's
// own query runner (execFile with an argv array, R17). Never imported by production (R14).
import { createQueryRunner } from '../../../process/NodeProcessControl'
import {
  POWERSHELL_DROPPED_ENV,
  windowsPowerShell,
  windowsSystemTool
} from '../../../process/probe/types'

/** NT AUTHORITY\SYSTEM. */
export const SYSTEM_SID = 'S-1-5-18'
/** BUILTIN\Administrators. */
export const ADMINISTRATORS_SID = 'S-1-5-32-544'
/** The integrity label of an elevated token (privilege.ts reads the same SID). */
const HIGH_INTEGRITY = 'S-1-16-12288'

const QUERY_TIMEOUT_MS = 30_000
const query = createQueryRunner()

export interface AclRule {
  sid: string
  type: 'Allow' | 'Deny'
  inherited: boolean
}

export interface AclView {
  owner: string
  /** The DACL is protected: it inherits nothing from the parent (SE_DACL_PROTECTED). */
  protected: boolean
  rules: AclRule[]
}

/** The owner, protection and DACL entries of each of `paths`, in the same order. */
export async function readWindowsAcls(paths: readonly string[]): Promise<AclView[]> {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$sid = [System.Security.Principal.SecurityIdentifier]',
    '$views = @($env:DWARFAI_ACL_PATHS -split "`n" | ForEach-Object {',
    '  $acl = Get-Acl -LiteralPath $_',
    '  $rules = @($acl.GetAccessRules($true, $true, $sid) | ForEach-Object {',
    '    [pscustomobject]@{ sid = $_.IdentityReference.Value; type = $_.AccessControlType.ToString(); inherited = $_.IsInherited }',
    '  })',
    '  [pscustomobject]@{ owner = $acl.GetOwner($sid).Value; protected = $acl.AreAccessRulesProtected; rules = $rules }',
    '})',
    'ConvertTo-Json -InputObject $views -Compress -Depth 4'
  ].join('\n')
  const out = await query(
    windowsPowerShell(),
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      timeoutMs: QUERY_TIMEOUT_MS,
      env: { DWARFAI_ACL_PATHS: paths.join('\n') },
      dropEnv: POWERSHELL_DROPPED_ENV
    }
  )
  if (!out.ok) throw new Error(`Get-Acl ${out.cause}`)
  return JSON.parse(out.stdout) as AclView[]
}

/** The current user's SID and whether this process runs elevated, from whoami of System32. */
export async function currentWindowsToken(): Promise<{ user: string; elevated: boolean }> {
  const whoami = windowsSystemTool('whoami.exe')
  const user = await query(whoami, ['/user', '/fo', 'csv', '/nh'], { timeoutMs: QUERY_TIMEOUT_MS })
  const groups = await query(whoami, ['/groups', '/fo', 'csv', '/nh'], {
    timeoutMs: QUERY_TIMEOUT_MS
  })
  if (!user.ok || !groups.ok) throw new Error('whoami could not be read')
  const sid = /"(S-1-[\d-]+)"/.exec(user.stdout)?.[1]
  if (sid === undefined) throw new Error('whoami /user printed no SID')
  return { user: sid, elevated: groups.stdout.includes(`"${HIGH_INTEGRITY}"`) }
}

/**
 * Grants `sid` an explicit read entry on `path` (inherited by children of a directory): a third
 * party the protection must remove. Through icacls of System32, by SID, never a localized name.
 */
export async function grantRead(
  path: string,
  sid: string,
  options: { inherit: boolean }
): Promise<void> {
  const grant = options.inherit ? `*${sid}:(OI)(CI)R` : `*${sid}:R`
  const out = await query(windowsSystemTool('icacls.exe'), [path, '/grant', grant], {
    timeoutMs: QUERY_TIMEOUT_MS
  })
  if (!out.ok) throw new Error(`icacls /grant ${out.cause}`)
}
