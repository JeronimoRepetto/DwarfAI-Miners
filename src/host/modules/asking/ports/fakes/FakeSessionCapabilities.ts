// The SessionCapabilities double: the sessions a test declares, as data. A dwarf the test never
// declared reads the fail-closed answer (every answer path `none`, launched), as the real binding
// answers for a dwarf with no capability record. Never imported by production code (R14).
import type { DwarfId } from '../../../../kernel/domain/values'
import type { AskCapabilities, AskSession, SessionCapabilities } from '../sessionCapabilities'

/** Every answer path closed: ADR-009 D2's fail-closed values of the fields asks read. */
export const FAIL_CLOSED_ASK_CAPABILITIES: AskCapabilities = Object.freeze({
  permission: 'none',
  question: 'none',
  observedPermission: 'none',
  observedQuestion: 'none'
})

export class FakeSessionCapabilities implements SessionCapabilities {
  private readonly sessions = new Map<DwarfId, AskSession>()
  /** Every dwarf read, in order. */
  readonly reads: DwarfId[] = []

  /** Declares (or replaces) the dwarf's session. */
  set(dwarfId: DwarfId, session: AskSession): void {
    this.sessions.set(dwarfId, session)
  }

  sessionOf(dwarfId: DwarfId): AskSession {
    this.reads.push(dwarfId)
    return (
      this.sessions.get(dwarfId) ?? {
        providerId: 'unknown',
        origin: 'launched',
        capabilities: FAIL_CLOSED_ASK_CAPABILITIES
      }
    )
  }
}
