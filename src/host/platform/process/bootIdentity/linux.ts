// Linux boot-identity sources beside the boot id (ADR-015 item 4; UNVERIFIED until S-015-2). The
// boot id itself is the probe's (`probe/linux.ts`, /proc/sys/kernel/random/boot_id): one
// derivation for both. Files and os.uptime() only; no process is spawned.
import { readFile } from 'node:fs/promises'
import { uptime } from 'node:os'
import { UNPARSEABLE, type BootSourceReader, type ReadOutcome } from '../probe/types'

/** The kernel's "no audit session" value of /proc/self/sessionid ((u32)-1). */
const AUDIT_SESSION_UNSET = '4294967295'

export interface LinuxBootSourceDeps {
  readText?: (path: string) => Promise<string>
  now?: () => number
  uptimeSeconds?: () => number
  env?: Readonly<Record<string, string | undefined>>
}

export function createLinuxBootSources(deps: LinuxBootSourceDeps = {}): BootSourceReader {
  const readText = deps.readText ?? ((path: string) => readFile(path, 'utf8'))
  const now = deps.now ?? Date.now
  const uptimeSeconds = deps.uptimeSeconds ?? uptime
  const env = deps.env ?? process.env
  return {
    sources: {
      bootId: '/proc/sys/kernel/random/boot_id',
      bootTimeMs: 'now - os.uptime(), rounded to the second',
      logonSessionId: '/proc/self/sessionid, else XDG_SESSION_ID'
    },
    bootTimeMs() {
      // ADR-015 item 4: `now − os.uptime()`. Rounded to the second, as the Windows boot instant
      // is, so two reads a moment apart agree (rule 3 compares it with a 60 s margin).
      const seconds = uptimeSeconds()
      if (!Number.isFinite(seconds) || seconds <= 0) return Promise.resolve(UNPARSEABLE)
      return Promise.resolve({
        ok: true,
        value: Math.round((now() - seconds * 1_000) / 1_000) * 1_000
      })
    },
    async logonSessionId(): Promise<ReadOutcome<string>> {
      const audit = await readText('/proc/self/sessionid').then(
        (text) => text.trim(),
        () => ''
      )
      if (/^\d+$/.test(audit) && audit !== AUDIT_SESSION_UNSET) return { ok: true, value: audit }
      const logind = env['XDG_SESSION_ID']?.trim() ?? ''
      if (logind !== '') return { ok: true, value: logind }
      return { ok: false, cause: 'found no audit session and no XDG_SESSION_ID' }
    }
  }
}
