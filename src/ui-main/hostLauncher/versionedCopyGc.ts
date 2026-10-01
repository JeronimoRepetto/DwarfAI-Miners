// Garbage collection of the Host's versioned copies (ADR-027 item 2; ADR-002 D5): "copies not used
// by a running Host and older than the two newest are deleted at Host start". The launcher runs it
// right after ensureVersionedCopy, with the spawn gate held and no Host answering on the endpoint,
// so no Host runs from any copy: the copy about to be used is the only one in use.
//
// - "Newest" is version precedence (compareVersions, SemVer 2.0.0 §11), since each copy's folder is
//   named by its app version; a folder name that is not a version sorts below every version.
// - Each copy to delete is first renamed aside to `<name>.tmp-<pid>-gc` and then removed. The rename
//   is the busy test: a folder holding a running executable cannot be renamed on Windows, so a busy
//   copy is skipped whole and retried at the next start, never left half-deleted. A copy renamed
//   aside whose removal fails is a `.tmp-` leftover, which ensureVersionedCopy removes first at the
//   next start.
// - It never throws: nothing here can fail the Host's start.
//
// Each deletion or skip is logged as `versioned-copy` (19 §9.1, proc `ui`) with cause class `gc`,
// never a path or a version.
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import type { UiLog } from '../diagnostics/uiLogger'
import { errnoOf, TEMP_MARKER, type CopyOps } from './versionedCopy'

/** How many of the newest copies are kept besides the one in use (ADR-027 item 2). */
export const KEPT_NEWEST_COPIES = 2

export interface VersionedCopyGcRequest {
  /** The per-OS `host/` folder. */
  root: string
  /** The version whose copy the Host is about to run from: always kept. */
  inUse: string
  /** The UI process's pid: the suffix of a copy renamed aside. */
  pid: number
  ops: CopyOps
  log: UiLog
}

export interface VersionedCopyGcReport {
  /** The versions whose copies were removed. */
  deleted: string[]
  /** The versions whose copies could not be removed now (busy, denied); retried at the next start. */
  skipped: string[]
}

const EVENT = 'versioned-copy'
const SUBSYSTEM = 'host-launcher'

export async function collectVersionedCopies(
  request: VersionedCopyGcRequest
): Promise<VersionedCopyGcReport> {
  const report: VersionedCopyGcReport = { deleted: [], skipped: [] }
  let names: string[]
  try {
    const entries = await readdir(request.root, { withFileTypes: true })
    names = entries
      .filter((entry) => entry.isDirectory() && !entry.name.includes(TEMP_MARKER))
      .map((entry) => entry.name)
  } catch {
    return report
  }
  const newestFirst = names.slice().sort(compareVersions).reverse()
  const kept = new Set([request.inUse, ...newestFirst.slice(0, KEPT_NEWEST_COPIES)])
  for (const name of newestFirst.filter((candidate) => !kept.has(candidate)).reverse()) {
    const copy = path.join(request.root, name)
    const aside = path.join(request.root, `${name}${TEMP_MARKER}${request.pid}-gc`)
    try {
      await request.ops.rename(copy, aside)
    } catch (error) {
      skip(request.log, report, name, error)
      continue
    }
    try {
      await request.ops.removeTree(aside)
    } catch (error) {
      skip(request.log, report, name, error)
      continue
    }
    report.deleted.push(name)
    request.log.record({
      level: 'info',
      event: EVENT,
      subsystem: SUBSYSTEM,
      outcome: 'ok',
      causeClass: 'gc'
    })
  }
  return report
}

function skip(log: UiLog, report: VersionedCopyGcReport, name: string, error: unknown): void {
  report.skipped.push(name)
  log.record({
    level: 'warn',
    event: EVENT,
    subsystem: SUBSYSTEM,
    outcome: 'skipped',
    causeClass: 'gc',
    errCode: errnoOf(error)
  })
}

const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** SemVer precedence; a name that is not a version sorts below every version, by its characters. */
export function compareVersions(a: string, b: string): number {
  const left = VERSION.exec(a)
  const right = VERSION.exec(b)
  if (left === null || right === null) {
    if (left !== null) return 1
    if (right !== null) return -1
    return a < b ? -1 : a > b ? 1 : 0
  }
  for (let part = 1; part <= 3; part += 1) {
    const diff = Number(left[part]) - Number(right[part])
    if (diff !== 0) return Math.sign(diff)
  }
  return comparePrerelease(left[4], right[4])
}

function comparePrerelease(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0
  // A release is newer than any of its prereleases.
  if (a === undefined) return 1
  if (b === undefined) return -1
  const left = a.split('.')
  const right = b.split('.')
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const x = left[index]
    const y = right[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) return Math.sign(Number(x) - Number(y))
    if (xNumeric) return -1
    if (yNumeric) return 1
    return x < y ? -1 : 1
  }
  return 0
}
