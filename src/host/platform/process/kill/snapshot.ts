// Descendant snapshots for the tree kill (ADR-014 item 3): one listing of every process with its
// parent, group and start time, read the same way the probe reads one start time (018's per-OS
// parsers), and the pure rules that pick the root's descendants and, later, the survivors.
//
// Windows: ADR-014 names a Toolhelp snapshot. Toolhelp is a native API that Node cannot call without
// native code, which the package defers (SP-13); the CIM `Win32_Process` class lists the same kernel
// process table (pid, parent pid, creation time) through PowerShell run as a program with an argv
// array, as the probe already does. Never `wmic` (ADR-014 item 4).
import { readdir, readFile } from 'node:fs/promises'
import {
  PROCESS_START_TOLERANCE_MS,
  sameProcess,
  type ProcessIdentity
} from '../../../kernel/domain/processIdentity'
import { parseDarwinLstart } from '../probe/darwin'
import { parseLinuxStartTime } from '../probe/linux'
import {
  DARWIN_PS,
  POWERSHELL_DROPPED_ENV,
  windowsPowerShell,
  type QueryRunner,
  type ReadOutcome
} from '../probe/types'
import { filetimeToEpochMs } from '../probe/win32'
import type { ProcessRow } from './types'

/**
 * The bound on one process listing. The package names none; it is the start-time query's bound
 * (5 000 ms), which is also what the legacy kill runner gave each kill command.
 */
export const SNAPSHOT_QUERY_TIMEOUT_MS = 5_000

/**
 * The root's descendants now, deepest first (leaves before their parents), each with the identity
 * read in this listing. A row is a child of a parent only when it did not start before that parent
 * (beyond the one tolerance): an older row names a pid that was reused after it started (a dangling
 * parent link, common on Windows), so it is not in the tree. A row without a start time cannot be
 * identity-checked and is never listed (06 INV-51).
 */
export function descendantsOf(
  rows: readonly ProcessRow[],
  root: ProcessIdentity
): ProcessIdentity[] {
  const byParent = new Map<number, ProcessRow[]>()
  for (const row of rows) {
    const siblings = byParent.get(row.ppid) ?? []
    siblings.push(row)
    byParent.set(row.ppid, siblings)
  }
  const found: Array<{ identity: ProcessIdentity; depth: number }> = []
  const seen = new Set<number>([root.pid])
  const queue: Array<{ pid: number; startTimeMs: number; depth: number }> = [
    { pid: root.pid, startTimeMs: root.processStartTimeMs, depth: 0 }
  ]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const row of byParent.get(next.pid) ?? []) {
      if (seen.has(row.pid) || row.startTimeMs === null) continue
      if (row.startTimeMs < next.startTimeMs - PROCESS_START_TOLERANCE_MS) continue
      seen.add(row.pid)
      const depth = next.depth + 1
      found.push({
        identity: { pid: row.pid, processStartTimeMs: row.startTimeMs, bootId: root.bootId },
        depth
      })
      queue.push({ pid: row.pid, startTimeMs: row.startTimeMs, depth })
    }
  }
  return found.sort((a, b) => b.depth - a.depth).map((entry) => entry.identity)
}

/**
 * The recorded descendants still running in a later listing: same pid and a start time within the
 * one tolerance, wherever its parent link points now (a re-parented grandchild is still found).
 */
export function survivorsIn(
  rows: readonly ProcessRow[],
  recorded: readonly ProcessIdentity[]
): ProcessIdentity[] {
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  return recorded.filter((identity) => {
    const row = byPid.get(identity.pid)
    if (row === undefined || row.startTimeMs === null) return false
    return sameProcess(identity, { ...identity, processStartTimeMs: row.startTimeMs })
  })
}

/** One `/proc/<pid>/stat` as a row, or null for a zombie (already ended) or an unreadable line. */
export function parseLinuxProcessRow(
  pid: number,
  stat: string,
  procStat: string
): ProcessRow | null {
  const close = stat.lastIndexOf(')')
  if (close < 0) return null
  const [state, ppid, pgid] = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/)
  if (state === undefined || state === 'Z' || state === 'X') return null
  if (!/^\d+$/.test(ppid ?? '') || !/^\d+$/.test(pgid ?? '')) return null
  return {
    pid,
    ppid: Number(ppid),
    pgid: Number(pgid),
    startTimeMs: parseLinuxStartTime(stat, procStat)
  }
}

const DARWIN_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/

/** `ps -A -o pid=,ppid=,pgid=,stat=,lstart=` as rows (zombies left out), or null when unparseable. */
export function parseDarwinProcessTable(text: string): ProcessRow[] | null {
  const rows: ProcessRow[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const match = DARWIN_ROW.exec(line)
    if (match === null) return null
    const [, pid, ppid, pgid, state, lstart] = match as unknown as string[]
    if ((state as string).startsWith('Z')) continue
    rows.push({
      pid: Number(pid),
      ppid: Number(ppid),
      pgid: Number(pgid),
      startTimeMs: parseDarwinLstart(lstart as string)
    })
  }
  return rows.length === 0 ? null : rows
}

const WIN32_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+|-)\s*$/

/** "<pid> <ppid> <creation FILETIME or ->" lines as rows, or null when unparseable or empty. */
export function parseWin32ProcessTable(text: string): ProcessRow[] | null {
  const rows: ProcessRow[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const match = WIN32_ROW.exec(line)
    if (match === null) return null
    const [, pid, ppid, filetime] = match as unknown as string[]
    rows.push({
      pid: Number(pid),
      ppid: Number(ppid),
      pgid: null,
      startTimeMs: filetime === '-' ? null : filetimeToEpochMs(filetime as string)
    })
  }
  return rows.length === 0 ? null : rows
}

/** Only numbers leave PowerShell; the CreationDate is converted as the probe converts StartTime. */
const WIN32_SNAPSHOT_SCRIPT =
  'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ' +
  'ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) ' +
  "$(if ($_.CreationDate) { $_.CreationDate.ToFileTime() } else { '-' })\" }"

export interface SnapshotDeps {
  /** Runs one bounded OS query (macOS `ps`, Windows PowerShell). */
  runQuery?: QueryRunner
  /** Reads a whole text file (Linux procfs); injected by tests. */
  readText?: (path: string) => Promise<string>
  /** Lists a folder's entry names (Linux `/proc`); injected by tests. */
  listDir?: (path: string) => Promise<readonly string[]>
  /** The environment System32 tools are found from (`SystemRoot`); default `process.env`. */
  env?: Readonly<Record<string, string | undefined>>
}

/** The process listing of one OS: every process now, or why it could not be read. */
export function createSnapshotReader(
  platform: 'win32' | 'darwin' | 'linux',
  deps: SnapshotDeps = {}
): () => Promise<ReadOutcome<readonly ProcessRow[]>> {
  if (platform === 'linux') {
    const readText = deps.readText ?? ((path: string) => readFile(path, 'utf8'))
    const listDir = deps.listDir ?? ((path: string) => readdir(path))
    return () => linuxSnapshot(readText, listDir)
  }
  const runQuery = deps.runQuery
  if (runQuery === undefined) {
    return () => Promise.resolve({ ok: false, cause: 'has no query runner' })
  }
  if (platform === 'darwin') {
    return async () => {
      const out = await runQuery(DARWIN_PS, ['-A', '-o', 'pid=,ppid=,pgid=,stat=,lstart='], {
        timeoutMs: SNAPSHOT_QUERY_TIMEOUT_MS,
        env: { LC_ALL: 'C' }
      })
      return tableOf(out, parseDarwinProcessTable)
    }
  }
  return async () => {
    const out = await runQuery(
      windowsPowerShell(deps.env),
      ['-NoProfile', '-NonInteractive', '-Command', WIN32_SNAPSHOT_SCRIPT],
      { timeoutMs: SNAPSHOT_QUERY_TIMEOUT_MS, dropEnv: POWERSHELL_DROPPED_ENV }
    )
    return tableOf(out, parseWin32ProcessTable)
  }
}

function tableOf(
  out: { ok: true; stdout: string } | { ok: false; cause: string },
  parse: (text: string) => ProcessRow[] | null
): ReadOutcome<readonly ProcessRow[]> {
  if (!out.ok) return out
  const rows = parse(out.stdout)
  return rows === null
    ? { ok: false, cause: 'gave an unparseable answer' }
    : { ok: true, value: rows }
}

async function linuxSnapshot(
  readText: (path: string) => Promise<string>,
  listDir: (path: string) => Promise<readonly string[]>
): Promise<ReadOutcome<readonly ProcessRow[]>> {
  let entries: readonly string[]
  let procStat: string
  try {
    ;[entries, procStat] = await Promise.all([listDir('/proc'), readText('/proc/stat')])
  } catch (error) {
    return {
      ok: false,
      cause: `could not read /proc (${(error as NodeJS.ErrnoException).code ?? 'error'})`
    }
  }
  const pids = entries.filter((name) => /^\d+$/.test(name)).map(Number)
  const rows = await Promise.all(
    pids.map((pid) =>
      readText(`/proc/${pid}/stat`).then(
        (stat) => parseLinuxProcessRow(pid, stat, procStat),
        // A process that ended between the listing and its read is simply not in the table.
        () => null
      )
    )
  )
  return { ok: true, value: rows.filter((row): row is ProcessRow => row !== null) }
}
