import { computed, readonly, shallowRef } from 'vue'
import { hostConnectionViewSchema, type HostConnectionView } from '@dwarfai/contracts'
import {
  heldHostStateMessage,
  hostReadOnly,
  hostStateMessage,
  hostStateToast,
  type HostStateMessage
} from '../lib/hostConnection/hostStateMessage'
import { useToasts } from './useToasts'

/*
 * The renderer's read model of the Host connection (14 §6.4 new `useHostConnection`; ADR-002 D9; 07 §12B): a
 * singleton (ADR-033 item 1) that subscribes to A-N04 `onHostConnection` first, then reads A-N03 `getHostConnection`
 * once, and offers A-N05 `retryHostConnection`.
 *
 * - `readOnly` is the one source every read model that sends a Host-owned mutation gates on (13 FM-146): true in every
 *   state but `connected`. The last snapshot stays on screen; nothing here clears a store or drops a dwarf (ADR-033
 *   item 3).
 * - A notice without an action (reconnecting, elevated-refused, in-job) is one polite toast raised when its state is
 *   entered, never a banner (owner's ruling 2026-10-02, over ADR-002 D9's "no toast"). A notice with an action is the
 *   dialog HostStateMessage.vue draws.
 * - Hidden until built (21 §1 item 8): until the cut-0 switch routes A-N03…A-N05 the router answers them with a typed
 *   refusal, which is not a `HostConnectionView`. Anything that is not one is ignored, so an unrouted row leaves the
 *   view unknown (null), the Panel usable and no message shown.
 * - A-N33 `confirmHostRestart` is never called: its notice is dormant in v1 (AMENDMENT-11).
 */
const view = shallowRef<HostConnectionView | null>(null)
const message = shallowRef<HostStateMessage>(hostStateMessage(null))
const retrying = shallowRef(false)
const readOnly = computed(() => hostReadOnly(view.value))

let unsubscribe: (() => void) | null = null
/** Bumped by every applied push and by `stop`, so a late first answer never overwrites a newer state. */
let generation = 0

function viewOf(value: unknown): HostConnectionView | null {
  const parsed = hostConnectionViewSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function apply(next: HostConnectionView): void {
  view.value = next
  const previous = message.value
  message.value = heldHostStateMessage(previous, next)
  const toast = hostStateToast(previous, message.value)
  if (toast !== null) useToasts().showToast(toast)
}

async function start(): Promise<void> {
  if (unsubscribe !== null) return
  // Subscribe first, then read (ADR-033 item 3): a change between the two is never missed.
  unsubscribe = window.api.onHostConnection((pushed) => {
    const next = viewOf(pushed)
    if (next === null) return
    generation += 1
    apply(next)
  })
  const asked = generation
  let answered: unknown
  try {
    answered = await window.api.getHostConnection()
  } catch {
    return
  }
  const next = viewOf(answered)
  if (next !== null && asked === generation) apply(next)
}

function stop(): void {
  unsubscribe?.()
  unsubscribe = null
  generation += 1
  view.value = null
  message.value = hostStateMessage(null)
  retrying.value = false
}

/**
 * The message's Retry (A-N05 → `HostClient.ensureHost()`, ADR-002 D9; S12.B07, S12.B11): one call per press, none
 * while one is in flight. Its answer is not applied: what the retry leads to arrives on A-N04, and the message stays
 * until that push replaces it.
 */
async function retry(): Promise<void> {
  if (retrying.value) return
  retrying.value = true
  try {
    await window.api.retryHostConnection()
  } catch {
    // The state is unchanged; the message stays and Retry may be pressed again (S12.B14).
  } finally {
    retrying.value = false
  }
}

/**
 * The incompatible message's one action (ADR-002 D8 item 5): A-N34 `requestStopEverything` (amendment owner-approved
 * 2026-10-01) asks UI main for the tray item's Stop everything and quit, whose confirmation follows on A-N25. Sent
 * only while the message offers it; never an upgrade request.
 */
function stopEverything(): void {
  if (message.value.action !== 'stop-everything') return
  window.api.requestStopEverything()
}

export function useHostConnection() {
  return {
    view: readonly(view),
    message: readonly(message),
    retrying: readonly(retrying),
    readOnly,
    start,
    stop,
    retry,
    stopEverything
  }
}
