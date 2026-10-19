// The session identity of a record of an observed session that can be resumed under its own id
// (owner amendment I, 2026-10-07; owner decision B, 2026-10-05, as 07 S4.41 / 13 FM-145): `codex
// resume <id>` and `opencode --session <id>` continue a session with its own id, but a session that
// closed is in the ended-agents ledger, which never lets its identity arrive again (INV-36). So the
// records after it are a new session, and a new dwarf: `<id>~resumed-<marker, epoch seconds>`, the
// shape Antigravity's resume has (ISSUE-074). The generation rides on `providerSessionId` (the frozen
// `ProviderIdentity`, ADR-015; 16): `providerAgentId` names a subagent, which a resume is not.
//
// Derived from the provider's store and the Host's ledger alone, never from what this Host run
// remembers, so a Host restart derives the same identity:
//
// - A marker is a record that follows the session's previous record by at least RESUME_GAP_MS. A
//   session closed by its process was quiet at least that long (owner amendment I), so every resume
//   of a closed session starts at a marker. Not every marker is a resume: an idle live session
//   leaves the same gap.
// - Walking the markers in order from the session's own id, a marker starts a new generation only
//   when the generation before it is in the ledger. A live session's idle gap therefore keeps its
//   id, and a resumed session's own idle gaps keep the resumed id.
//
// No resume-only record exists in either store (docs/codex-v2-format.md §12: a resume appends to
// the same rollout under the same thread id, no second `session_meta`; docs/opencode-format.md
// Row 11: `--session` adds messages to the same session row), so the marker is the time of the
// first record of the generation, as the store wrote it. UNVERIFIED until the ISSUE-319 recordings
// (SP-15: a TUI `codex resume` and a multi-turn rollout): that a resumed run writes its first record
// after it starts and never back-dates one.
//
// Keys never change with the generation: a record's source key and unit key are its session's, so
// records read again add no rows; only the dwarf they are read for is the generation's.
import { PROCESS_GONE_QUIET_MS } from './processGone'

/** The least gap before a record that can start a resumed generation: the close's quiet gate. */
export const RESUME_GAP_MS = PROCESS_GONE_QUIET_MS

/** `<sessionId>~resumed-<marker in epoch seconds>`. */
export function resumedSessionIdOf(sessionId: string, markerMs: number): string {
  return `${sessionId}~resumed-${Math.floor(markerMs / 1000)}`
}

/**
 * The session id a record at `at` belongs to: the session's own id, or the generation the markers
 * up to `at` lead to through the ledger (`ended`).
 */
export function generationAt(
  sessionId: string,
  markers: readonly number[],
  at: number,
  ended: (sessionId: string) => boolean
): string {
  let current = sessionId
  for (const marker of markers) {
    if (marker > at) break
    if (ended(current)) current = resumedSessionIdOf(sessionId, marker)
  }
  return current
}

/** The record times of one session, as the store wrote them; the markers among them. */
export class RecordTimeline {
  private readonly times: number[] = []
  private cached: number[] | null = null

  /** One record's time; repeats and any order are fine. */
  add(at: number): void {
    const times = this.times
    let index = times.length
    while (index > 0 && (times[index - 1] as number) > at) index--
    if (times[index - 1] === at) return
    times.splice(index, 0, at)
    this.cached = null
  }

  /** The records that follow the one before them by at least RESUME_GAP_MS, oldest first. */
  markers(): readonly number[] {
    if (this.cached === null) {
      this.cached = []
      for (let n = 1; n < this.times.length; n++) {
        const at = this.times[n] as number
        if (at - (this.times[n - 1] as number) >= RESUME_GAP_MS) this.cached.push(at)
      }
    }
    return this.cached
  }

  /** The newest record's time, or null when none was added. */
  newest(): number | null {
    return this.times.at(-1) ?? null
  }
}
