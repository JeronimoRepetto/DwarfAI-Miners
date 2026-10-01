import { computed, getCurrentScope, onScopeDispose, shallowRef, type ComputedRef } from 'vue'
import type { DwarfWire } from '@dwarfai/contracts'

/*
 * The renderer half of Stop everything and quit (ISSUE-317; 07 S10.18…S10.21; ADR-002 D7 steps 1–4; UC-023).
 *
 * UI main asks for the confirmation with A-N25 `onStopEverythingRequested { confirmationId }`; this composable holds
 * that id while the confirmation is shown. The count is read from the Host read model the caller hands in: the owned
 * dwarfs of the snapshot, kept current by live frames (14 §2.2 A-N25 Notes), so it follows them while the confirmation
 * is open (ADR-002 D7 step 2). It is the Host-owned count only: the sessions the legacy runtime launched are not in
 * it, an accepted difference of the hybrid builds (OQ-78), and nothing here looks them up.
 *
 * Cancel sends A-N27 and changes nothing (S10.19). Confirm sends A-N26 exactly once per confirmation, with one
 * `requestId` minted for that intent (14 §1.6); a second press or a later Cancel sends nothing (S10.20). When the
 * `StopAllOutcome` names dwarfs that could not be ended, the view becomes ONE danger message naming them, shown until
 * dismissed, and no toast is raised (S10.21; ADR-014 item 9). When every owned session ended, the app exits with the
 * Host (UI main, ISSUE-053), so the view only closes.
 *
 * Per call, like useResetMetrics: App owns the one instance, and with it the IPC (ADR-033 item 2).
 */

/** What the confirmation reads of a dwarf in the Host read model (14 §3.6 `DwarfWire`). */
export type StopEverythingDwarf = Pick<DwarfWire, 'id' | 'owned' | 'baseName' | 'customName'>

/** The Host read model's dwarfs: the snapshot's `dwarfs` section with live frames applied (ADR-033 item 3). */
export interface StopEverythingReadModel {
  dwarfs(): readonly StopEverythingDwarf[]
}

export interface StopEverythingDeps {
  readModel: StopEverythingReadModel
  /** A UUIDv7 per Confirm (14 §1.6); the default mints one from the clock and the platform's random source. */
  newRequestId?: () => string
}

export type StopEverythingView =
  | { kind: 'closed' }
  /** S10.18: the confirmation; `sending` once Confirm was chosen and A-N26 has not answered yet. */
  | { kind: 'confirming'; count: number; sending: boolean }
  /** S10.21: the one danger message, naming every dwarf that could not be ended. */
  | { kind: 'incomplete'; failed: string[] }

type State =
  | { kind: 'closed' }
  | { kind: 'confirming'; confirmationId: string; sending: boolean }
  | { kind: 'incomplete'; failed: readonly string[] }

/** A UUIDv7 (RFC 9562): 48 bits of epoch milliseconds, version 7, variant 10, the rest random. */
function mintRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let ms = Date.now()
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = ms % 256
    ms = Math.floor(ms / 256)
  }
  bytes[6] = 0x70 | (bytes[6]! & 0x0f)
  bytes[8] = 0x80 | (bytes[8]! & 0x3f)
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function useStopEverything(deps: StopEverythingDeps): {
  view: ComputedRef<StopEverythingView>
  confirm(): Promise<void>
  cancel(): void
  dismiss(): void
} {
  const { readModel, newRequestId = mintRequestId } = deps
  const state = shallowRef<State>({ kind: 'closed' })

  const ownedCount = (): number => readModel.dwarfs().filter((dwarf) => dwarf.owned).length

  /** A failed dwarf by its name in the read model (customName ?? baseName, PO #88); by its id if it is not there. */
  const nameOf = (id: string): string => {
    const dwarf = readModel.dwarfs().find((d) => d.id === id)
    return dwarf === undefined ? id : (dwarf.customName ?? dwarf.baseName)
  }

  const view = computed<StopEverythingView>(() => {
    const now = state.value
    if (now.kind === 'confirming') {
      return { kind: 'confirming', count: ownedCount(), sending: now.sending }
    }
    if (now.kind === 'incomplete') return { kind: 'incomplete', failed: [...now.failed] }
    return { kind: 'closed' }
  })

  // A new request replaces whatever is shown: UI main cancelled the older confirmation itself.
  const unsubscribe = window.api.onStopEverythingRequested(({ confirmationId }) => {
    state.value = { kind: 'confirming', confirmationId, sending: false }
  })
  if (getCurrentScope()) onScopeDispose(unsubscribe)

  async function confirm(): Promise<void> {
    const asked = state.value
    if (asked.kind !== 'confirming' || asked.sending) return
    state.value = { ...asked, sending: true }
    let failed: readonly string[] = []
    try {
      const result = await window.api.confirmStopEverything({
        confirmationId: asked.confirmationId,
        requestId: newRequestId()
      })
      if (result.ok) failed = result.value.failed
    } catch {
      // The panel lost contact with UI main: nothing is known to have ended, so nothing is claimed.
    }
    // A newer confirmation took the view meanwhile: this answer is not its.
    if (state.value.kind !== 'confirming' || state.value.confirmationId !== asked.confirmationId) {
      return
    }
    // An error answer ends this confirmation too (UI main closed it); the read model keeps showing what still runs.
    state.value =
      failed.length > 0 ? { kind: 'incomplete', failed: failed.map(nameOf) } : { kind: 'closed' }
  }

  function cancel(): void {
    const asked = state.value
    if (asked.kind !== 'confirming' || asked.sending) return
    state.value = { kind: 'closed' }
    window.api.cancelStopEverything({ confirmationId: asked.confirmationId })
  }

  function dismiss(): void {
    if (state.value.kind === 'incomplete') state.value = { kind: 'closed' }
  }

  return { view, confirm, cancel, dismiss }
}
