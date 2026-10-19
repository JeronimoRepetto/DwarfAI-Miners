// macOS boot-identity sources beside the boot id (ADR-015 item 4; UNVERIFIED until S-015-2). The
// boot id itself is the probe's (`probe/darwin.ts`, sysctl kern.bootsessionuuid).
import {
  BOOT_ID_QUERY_TIMEOUT_MS,
  DARWIN_SYSCTL,
  parsed,
  type BootSourceReader,
  type QueryRunner
} from '../probe/types'

const BOOTTIME = /sec\s*=\s*(\d+)\s*,\s*usec\s*=\s*(\d+)/

/** Epoch ms from `sysctl -n kern.boottime` ("{ sec = 1790000000, usec = 456789 } Sat Aug 29 …"). */
export function parseDarwinBoottime(text: string): number | null {
  const match = BOOTTIME.exec(text)
  if (match === null) return null
  return Number(match[1]) * 1_000 + Math.floor(Number(match[2]) / 1_000)
}

export function createDarwinBootSources(deps: { runQuery: QueryRunner }): BootSourceReader {
  return {
    sources: {
      bootId: 'sysctl -n kern.bootsessionuuid',
      bootTimeMs: 'sysctl -n kern.boottime',
      logonSessionId: 'none: the audit session id needs getaudit_addr, which Node cannot call'
    },
    async bootTimeMs() {
      const out = await deps.runQuery(DARWIN_SYSCTL, ['-n', 'kern.boottime'], {
        timeoutMs: BOOT_ID_QUERY_TIMEOUT_MS
      })
      return parsed(out, parseDarwinBoottime)
    },
    logonSessionId() {
      // ADR-015 item 4 reads it "when readable from Node": getaudit_addr is a C call with no Node
      // binding and no stock command prints it for the calling process, so the field is 'unknown'
      // and rules 1 and 3 decide (question recorded for S-015-2).
      return Promise.resolve({ ok: false, cause: 'is not readable from Node on macOS' })
    }
  }
}
