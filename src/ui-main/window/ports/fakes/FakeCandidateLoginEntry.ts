import type { CandidateDefaultMarker, CandidateLoginEntry } from '../candidateLoginEntry'

/**
 * Hand-written double of `CandidateLoginEntry` (16 §2.8 naming), scriptable for the candidate autostart: `entry` is the
 * entry under the current name, `legacyEntry` a pre-rename `AgentName` value (Windows), `refuse` makes every write throw
 * and leaves the entries as they were. `calls` records every member call.
 */
export class FakeCandidateLoginEntry implements CandidateLoginEntry {
  entry = false
  legacyEntry = false
  refuse = false
  /** How many times the entry was written. */
  writes = 0
  readonly calls: string[] = []

  async enable(): Promise<void> {
    this.calls.push('enable')
    this.write()
  }

  async migrateLegacy(): Promise<void> {
    this.calls.push('migrateLegacy')
    if (!this.legacyEntry) return
    if (this.refuse) throw refused()
    this.legacyEntry = false
    this.write()
  }

  private write(): void {
    if (this.refuse) throw refused()
    this.entry = true
    this.writes += 1
  }
}

/** Hand-written double of the default marker file. */
export class FakeCandidateDefaultMarker implements CandidateDefaultMarker {
  present = false
  refuse = false

  async exists(): Promise<boolean> {
    return this.present
  }

  async write(): Promise<void> {
    if (this.refuse || this.present) throw Object.assign(new Error('marker'), { code: 'EEXIST' })
    this.present = true
  }
}

function refused(): Error {
  return Object.assign(new Error('the login entry could not be written'), { code: 'EACCES' })
}
