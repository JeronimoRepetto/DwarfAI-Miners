// Linux start-time and boot-id reader (ADR-014 item 1, ADR-015 items 1 and 4). Reads procfs as
// files; no process is spawned. Kept from the legacy `parseLinuxProcessStart` rule (candidate
// adapted, ISSUE-018), which read the same two files through `cat`.
import { readFile } from 'node:fs/promises'
import type { OsProcessReader } from './types'

const USER_HZ_MS = 10 // USER_HZ is fixed at 100 by the kernel ABI whatever CONFIG_HZ is

/**
 * Epoch ms from `/proc/<pid>/stat` and `/proc/stat`: `btime` (boot, epoch seconds) plus field 22
 * `starttime` (ticks since boot). `comm` may hold spaces and ')', so the numeric fields resume after
 * the LAST ')'; `starttime` is the 20th field after it.
 */
export function parseLinuxStartTime(stat: string, procStat: string): number | null {
  const close = stat.lastIndexOf(')')
  if (close < 0 || !stat.includes('(')) return null
  const btime = /^btime (\d+)\s*$/m.exec(procStat)
  if (btime === null) return null
  const startTicks = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/)[19]
  if (startTicks === undefined || !/^\d+$/.test(startTicks)) return null
  return Number(btime[1]) * 1_000 + Number(startTicks) * USER_HZ_MS
}

export interface LinuxReaderDeps {
  /** Reads a whole text file; injected by tests. */
  readText?: (path: string) => Promise<string>
}

export function createLinuxReader(deps: LinuxReaderDeps = {}): OsProcessReader {
  const readText = deps.readText ?? ((path: string) => readFile(path, 'utf8'))
  const read = (path: string): Promise<string | null> => readText(path).catch(() => null)
  return {
    async startTimeMs(pid) {
      const [stat, procStat] = await Promise.all([read(`/proc/${pid}/stat`), read('/proc/stat')])
      return stat === null || procStat === null ? null : parseLinuxStartTime(stat, procStat)
    },
    async bootId() {
      const id = (await read('/proc/sys/kernel/random/boot_id'))?.trim() ?? ''
      return id === '' ? null : id
    }
  }
}
