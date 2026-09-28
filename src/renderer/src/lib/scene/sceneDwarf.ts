/*
 * The redesigned dwarf in the scene (#635), `molecules/dwarf` in the design: what state a dwarf is
 * drawn in, what its button is called, and which delivery mark it wears. The component draws; this
 * decides.
 *
 * The four states are the design's own (working, asking, asleep, idle), read off the wire's
 * status and nothing weaker: asking is a proven ask (`dwarfNeedsYou`), the "?" being attention
 * level 1, and asleep is a waiting session that asked nobody anything.
 */
import { dwarfNeedsYou } from '../shell/panelNav'
import { kickMarker, sendMarker, type DeliveryMarker } from '../delivery/deliveryVerdict'
import { portraitStatusText } from '../dwarf/portrait'
import type { Dwarf, DwarfKickState, DwarfSendState } from '../../types'

export type SceneDwarfStatus = 'working' | 'asking' | 'asleep' | 'idle'

type StatusFacts = Pick<Dwarf, 'status' | 'pendingQuestion' | 'waitingReason'>

export function sceneDwarfStatus(dwarf: StatusFacts): SceneDwarfStatus {
  if (dwarfNeedsYou(dwarf)) return 'asking'
  if (dwarf.status === 'working') return 'working'
  if (dwarf.status === 'waiting') return 'asleep'
  // Leaving: neither at the rock nor asleep on the way out.
  return 'idle'
}

/*
 * Whether the dwarf plays its rest sequence. Not `isResting(status)`: an asking dwarf stops and
 * raises a hand on its idle sheet (screens/mine.md, W3·2) rather than lying down, so only asleep
 * rests.
 */
export function sceneDwarfResting(dwarf: StatusFacts): boolean {
  return sceneDwarfStatus(dwarf) === 'asleep'
}

/** "<name>, <state>" (copy.md, Dwarf in the scene), the portrait's own state words. */
export function sceneDwarfLabel(name: string, status: SceneDwarfStatus): string {
  return name + ', ' + portraitStatusText(status)
}

export type DwarfMarkName = 'pending' | 'delivered' | 'reacted' | 'failed'

export interface SceneDwarfMark {
  mark: DwarfMarkName
  glyph: string
  /** The verdict's own sentence (deliveryVerdict.ts), the only place the full story fits. */
  title: string
}

const MARK_OF: Record<string, DwarfMarkName> = {
  'is-sending': 'pending',
  'is-delivered': 'delivered',
  'is-reacted': 'reacted',
  'is-failed': 'failed'
}

function markOf(marker: DeliveryMarker): SceneDwarfMark {
  return { mark: MARK_OF[marker.cls] ?? 'pending', glyph: marker.glyph, title: marker.title }
}

/*
 * The one mark the design draws on a dwarf (`el.setMark`). The wording and the delivered/reacted
 * line are deliveryVerdict's and are not restated here: this only picks which verdict shows. The
 * message outranks the kick, which today's sprite drew on the opposite corner; a kick alone still
 * shows, so neither verdict goes unseen.
 */
export function sceneDwarfMark(
  send: DwarfSendState | undefined,
  kick: DwarfKickState | undefined
): SceneDwarfMark | null {
  const marker = sendMarker(send) ?? kickMarker(kick)
  return marker === null ? null : markOf(marker)
}
