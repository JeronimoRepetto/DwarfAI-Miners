// This machine's boot id as the Host derives it (ADR-015 item 4; ADR-014 item 1), for the identity rule of the hung-Host
// end (hungHost.ts; ADR-002 D9 step 2). The per-OS rules are the Host's (src/host/platform/process/probe/{win32,
// linux,darwin}.ts, ISSUE-018/019), restated because the UI tree may not import the Host (R10); both sides must give
// the same string in one boot, which hungHost.os.test.ts checks against the identity file a real Host wrote:
// - Windows: the registry `BootId` boot counter (`reg.exe query … /v BootId`, a REG_DWORD) as a decimal string.
// - Linux: /proc/sys/kernel/random/boot_id, trimmed; no process spawned.
// - macOS: `sysctl -n kern.bootsessionuuid`, trimmed.
// Any read that fails or answers something else is null: the identity then does not match (`'unknown'` is a mismatch).
import { readFile } from 'node:fs/promises'
import type { QueryRunner } from './processStart'

/** The Host's BOOT_ID_QUERY_TIMEOUT_MS (16 §2.6). */
export const BOOT_ID_QUERY_TIMEOUT_MS = 2_000

/** The key whose `BootId` value Windows increments at every boot (the Host's WIN32_BOOT_ID_KEY). */
export const WIN32_BOOT_ID_KEY =
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters'

const BOOT_ID_VALUE = /^\s*BootId\s+REG_DWORD\s+0x([0-9a-fA-F]{1,8})\s*$/m

/** The `BootId` counter of a `reg query … /v BootId` answer, as a decimal string, or null. */
export function parseRegBootId(text: string): string | null {
  const match = BOOT_ID_VALUE.exec(text)
  return match === null ? null : String(Number.parseInt(match[1] as string, 16))
}

export interface BootIdReaderOptions {
  platform: 'win32' | 'darwin' | 'linux'
  /** Required on Windows and macOS. */
  runQuery?: QueryRunner
  /** Reads a whole text file (Linux); default `fs.readFile`. */
  readText?: (path: string) => Promise<string>
  /** SystemRoot on Windows; default `process.env`. */
  env?: Readonly<Record<string, string | undefined>>
}

export function createBootIdReader(options: BootIdReaderOptions): () => Promise<string | null> {
  const { platform, runQuery } = options
  if (platform === 'linux') {
    const readText = options.readText ?? ((path: string) => readFile(path, 'utf8'))
    return async () => {
      const text = await readText('/proc/sys/kernel/random/boot_id').catch(() => '')
      const id = text.trim()
      return id === '' ? null : id
    }
  }
  if (runQuery === undefined) return () => Promise.resolve(null)
  if (platform === 'darwin') {
    return async () => {
      const out = await runQuery('sysctl', ['-n', 'kern.bootsessionuuid'], {
        timeoutMs: BOOT_ID_QUERY_TIMEOUT_MS
      })
      if (!out.ok) return null
      const id = out.stdout.trim()
      return /^[0-9A-Fa-f-]{8,}$/.test(id) ? id : null
    }
  }
  const env = options.env ?? process.env
  const root = env['SystemRoot'] ?? env['SYSTEMROOT'] ?? 'C:\\Windows'
  const reg = `${root.replace(/[\\/]+$/, '')}\\System32\\reg.exe`
  return async () => {
    const out = await runQuery(reg, ['query', WIN32_BOOT_ID_KEY, '/v', 'BootId'], {
      timeoutMs: BOOT_ID_QUERY_TIMEOUT_MS
    })
    return out.ok ? parseRegBootId(out.stdout) : null
  }
}
