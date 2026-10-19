// Whether "Stop dwarf…" is available for a dwarf (16 §4.2 `CrewCommands.stop` precondition; 06
// INV-31 as amended by AMENDMENT-2, OQ-54; 07 S15.18; 14 §3.6 `StopUnavailableReason`). Pure: no
// I/O, no clock read (R1).
//
// Only a stop already in flight makes it unavailable (US-MSG-016.AC02). An open turn is not a
// refusal: "Stop dwarf…" ends the whole session, never only the turn (US-MSG-016.AC01, AC06; kick
// stays retired, OQ-49). An open ask, the dwarf's status and whether the session is owned or
// observed change nothing either (US-MSG-016.AC04).
import type { Dwarf } from './dwarf'
import type { StopUnavailableReason } from './dwarfView'

export type StopAvailability = 'available' | 'unavailable-stop-in-flight'

export function stopAvailability(d: Pick<Dwarf, 'stopInFlight'>): StopAvailability {
  return d.stopInFlight ? 'unavailable-stop-in-flight' : 'available'
}

/** The reason the wire carries (14 §3.6 `DwarfWire.stopUnavailableReason`), or null when available. */
export function stopUnavailableReason(a: StopAvailability): StopUnavailableReason | null {
  return a === 'available' ? null : 'already-stopping'
}
