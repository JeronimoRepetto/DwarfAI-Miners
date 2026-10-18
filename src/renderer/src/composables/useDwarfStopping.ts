import { reactive } from 'vue'
import type { DwarfId, StopUnavailableReason } from '@dwarfai/contracts'
import { mintRequestId } from './requestIds'
import { useMines } from './useMines'

/*
 * "Stop dwarf…" (ISSUE-179 read side, ISSUE-001 part C; AMENDMENT-2, OQ-54; ADR-014; PO #62, #79; ADR-033 items 2, 3).
 *
 * The composable is the only IPC layer of the stop (ADR-033 item 2): it calls A-N29 `stopDwarf`, which relays B-M21
 * `crew.stop` unchanged (14 §2.2) and ends the dwarf's whole session, never only its turn. It replaces
 * `useDwarfKicking` (A-26's interrupt, retired at 3a); deleting that composable and its control belongs to ISSUE-183.
 *
 * - Availability is the Host's fact, never derived here (INV-31): "Stop dwarf…" is disabled, never hidden, only while
 *   the board read model's `DwarfWire.stopUnavailableReason` is `already-stopping` (14 §4.1 `dwarfs` consumer).
 * - A request is only "request sent" until the Host answers (14 §1.6: one `requestId` per intent, so a second press
 *   while it is on its way sends nothing). The answer claims nothing about the dwarf: the board keeps it until
 *   `dwarf.departed`, the only walk-out trigger (14 §4.3 rule 6).
 * - A refusal (`already-stopping`, `could-not-end`) is kept as the Host stated it until dismissed; an error answer, or
 *   no answer at all, is `unanswered`. The words for each belong to the view (EPIC-16), never to this file.
 *
 * Singleton store, like the other per-dwarf stores: the panel's control and any other reader see one request state.
 */

/** What the stop reads of the board read model (`useMines`): the Host's reason per dwarf. */
export interface DwarfStoppingReadModel {
  stopUnavailableReason(dwarfId: string): StopUnavailableReason | null
}

export interface DwarfStoppingDeps {
  /** The board read model; `useMines()` when omitted. */
  readModel?: DwarfStoppingReadModel
  /** A UUIDv7 per press (14 §1.6); the default mints one from the clock and the platform's random source. */
  newRequestId?: () => string
}

/** The state of the last stop request of one dwarf. */
export type DwarfStopView =
  | { kind: 'idle' }
  /** A-N29 sent and not answered yet. */
  | { kind: 'request-sent' }
  /** The Host refused it (B-M21 `Outcome` error, AMENDMENT-2). */
  | { kind: 'refused'; reason: 'already-stopping' | 'could-not-end' }
  /** A-N29 answered an error, or could not be reached: nothing is known to have happened. */
  | { kind: 'unanswered' }

const IDLE: DwarfStopView = { kind: 'idle' }

const requests = reactive(new Map<string, DwarfStopView>())

export function useDwarfStopping(deps: DwarfStoppingDeps = {}) {
  const { newRequestId = mintRequestId } = deps
  const readModel = deps.readModel ?? useMines()

  function viewOf(dwarfId: string): DwarfStopView {
    return requests.get(dwarfId) ?? IDLE
  }

  /** INV-31: unavailable only while the Host says a stop is already in flight. */
  function disabled(dwarfId: string): boolean {
    return readModel.stopUnavailableReason(dwarfId) === 'already-stopping'
  }

  async function stop(dwarfId: string): Promise<void> {
    if (viewOf(dwarfId).kind === 'request-sent') return
    requests.set(dwarfId, { kind: 'request-sent' })
    let next: DwarfStopView = { kind: 'unanswered' }
    try {
      const result = await window.api.stopDwarf({
        dwarfId: dwarfId as DwarfId,
        requestId: newRequestId()
      })
      if (result.ok) {
        next = result.value.ok ? IDLE : { kind: 'refused', reason: result.value.error }
      }
    } catch {
      // No answer: nothing is claimed, the request is unanswered.
    }
    if (next.kind === 'idle') requests.delete(dwarfId)
    else requests.set(dwarfId, next)
  }

  /** Clears a refusal or an unanswered request; a request on its way is left alone. */
  function dismiss(dwarfId: string): void {
    if (viewOf(dwarfId).kind !== 'request-sent') requests.delete(dwarfId)
  }

  /** Forgets every request (a reset, or a test). */
  function clearAll(): void {
    requests.clear()
  }

  return { viewOf, disabled, stop, dismiss, clearAll }
}
