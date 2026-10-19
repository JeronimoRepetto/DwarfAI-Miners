// Machine 1, dwarf status (07 §1; ADR-032 item 2). The status is derived, never stored: the Host
// classifies persisted facts against an instant that is always passed in (R1: no clock reads here).

/** The one status vocabulary (PO #9; INV-23): `done` never exists, presence is a separate field. */
export type DwarfStatus = 'working' | 'asking' | 'idle' | 'asleep'

export interface StatusFacts {
  processState: 'running' | 'closed'
  /** From the ask broker (trusted only, ADR-032 item 4); an auto-denied ask never sets it (S1.16). */
  openAsk?: { kind: 'question' | 'permission'; askedAt: number }
  turn:
    | { state: 'active' }
    | { state: 'ended'; endedAt: number; reliability: 'reliable' | 'inferred' }
    /** Arrived with no message (PO #14). */
    | { state: 'none-yet'; arrivedAt: number }
  /** Message sent or received, tool step, turn start. */
  lastActivityAt: number
}

/** One shared constant for both idle paths (PO #7, #14; NFR-TIM-04). */
export const ASLEEP_AFTER_MS = 60_000

/** The ordered rule table of ADR-032 item 2: a trusted ask first, then an active turn, then the 60 s rule. */
export function classifyDwarfStatus(f: StatusFacts, now: number): DwarfStatus {
  if (f.openAsk) return 'asking'
  if (f.turn.state === 'active') return 'working'
  const idleSince =
    f.turn.state === 'ended'
      ? f.turn.endedAt
      : f.turn.state === 'none-yet'
        ? f.turn.arrivedAt
        : f.lastActivityAt
  return now - Math.max(idleSince, f.lastActivityAt) >= ASLEEP_AFTER_MS ? 'asleep' : 'idle'
}
