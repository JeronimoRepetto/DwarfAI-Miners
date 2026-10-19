// `ObservationQueries` (05 §3.3; 16 §4.3): what observation knows of a dwarf, read from the
// observed-session index. A dwarf DwarfAI launched and observation never linked to a stream has no
// observed session (null). Read only.
import type { DwarfId } from '../../../kernel/domain/values'
import type { ObservedSessionRef, ObservedSessionStore } from '../ports/observedSessionStore'

export interface ObservationQueries {
  observedSessionOf(dwarfId: DwarfId): ObservedSessionRef | null
}

export interface ObservationQueriesDeps {
  sessions: Pick<ObservedSessionStore, 'streams'>
}

export function createObservationQueries(deps: ObservationQueriesDeps): ObservationQueries {
  return {
    observedSessionOf(dwarfId) {
      const streams = deps.sessions.streams(dwarfId)
      if (streams.length === 0) return null
      return { dwarfId, streamIds: streams.map((s) => s.streamId) }
    }
  }
}
