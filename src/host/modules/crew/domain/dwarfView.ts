// The `DwarfView` read model (06 §5.1; 05 §3.2 `CrewQueries.get`): the aggregate plus what is
// derived from it at one instant. It can fill every `14` §3.6 `DwarfWire` field crew owns; the
// outcome line is conversation's (INV-67) and the workplace joins with mines' stamp (ADR-030 D3).
// Pure: no I/O, no clock read (R1); the instant and the session links are passed in.
import type { Instant, ProviderId } from '../../../kernel/domain/values'
import type { Dwarf } from './dwarf'
import { isGone } from './presence'
import { classifyDwarfStatus, type DwarfStatus } from './status'

/**
 * What the dwarf's sessions say about it outside crew, read at the same instant: `owned` iff the
 * dwarf has a `LaunchRecord` with no `endedAt` (launching's, never a `Dwarf` field, INV-30), and
 * whether a delivery route exists (a driver session or an observed relay, INV-33).
 */
export interface SessionLinksOf {
  owned: boolean
  hasDeliveryRoute: boolean
}

/** 14 §3.6 `StopUnavailableReason`: an open turn no longer disables Stop (OQ-54). */
export type StopUnavailableReason = 'already-stopping'

export interface DwarfView extends Dwarf {
  /** `identity.providerId`, as the wire carries it. */
  providerId: ProviderId
  /** `customName ?? baseName` (INV-29). */
  displayName: string
  /** Derived, never stored (INV-23). */
  status: DwarfStatus
  needsYou: boolean
  /** The front ask's instant, only while asking (needs-you queue order, US-VALLE-012). */
  askedAt?: Instant
  canReceiveMessages: boolean
  stopUnavailableReason: StopUnavailableReason | null
  owned: boolean
  /** The dwarf left its mine (`departedAt` set); only listed when departed dwarfs are asked for. */
  departed: boolean
}

/** ADR-032 item 6: the one rule for "needs you" — the derived status is `asking`. */
export function needsYou(status: DwarfStatus): boolean {
  return status === 'asking'
}

/** INV-29: the custom name replaces the base name wherever the app names the dwarf. */
export function displayNameOf(d: Dwarf): string {
  return d.customName ?? d.baseName
}

/** The view of `d` at `now`. */
export function viewOf(d: Dwarf, now: Instant, links: SessionLinksOf): DwarfView {
  const status = classifyDwarfStatus(d.facts, now)
  const askedAt = status === 'asking' ? d.facts.openAsk?.askedAt : undefined
  const view: DwarfView = {
    ...d,
    providerId: d.identity.providerId,
    displayName: displayNameOf(d),
    status,
    needsYou: needsYou(status),
    canReceiveMessages: d.processState === 'running' && links.hasDeliveryRoute,
    stopUnavailableReason: d.stopInFlight ? 'already-stopping' : null,
    owned: links.owned,
    departed: isGone(d)
  }
  return askedAt === undefined ? view : { ...view, askedAt }
}
