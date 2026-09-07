import { ref } from 'vue'
import type { MessagePanelState } from '../types'

/**
 * What the message panel's own window is showing (#162).
 *
 * BOTH windows use this, which is the whole reason the state lives in main:
 * the shell opens the panel on a selected dwarf or on the mine's Add action,
 * and the panel window closes itself and adopts the dwarf a launch produced.
 * Main is the single serialization point, so the last write wins and each
 * window hears what the other did.
 *
 * The same honesty rule `usePanelLayout` enforces, for a stronger reason
 * still: main creates, moves, shows and hides an actual second window off the
 * back of a request, and the other window may have changed the state between
 * the gesture and the answer. So `state` only ever becomes something main
 * REPORTED — the shell draws the selected dwarf's halo from it, and a halo
 * drawn from a wish points at a panel that is not open.
 *
 * No module-scope singleton: there is exactly one consumer per window, so
 * per-call refs keep tests independent without a clearAll() ritual.
 */
export function useMessagePanel() {
  // Matches main's own starting state, so the first paint is right before
  // sync() has answered: nothing is open when the app starts.
  const state = ref<MessagePanelState>({ surface: 'none', mineId: '', dwarfId: '' })

  /** Adopt the real state; on failure keep the last known one. */
  async function sync(): Promise<void> {
    try {
      state.value = await window.api.getMessagePanel()
    } catch {
      // The bridge is unreachable: the last known state is still the most
      // honest thing to render, and the next successful call corrects it.
    }
  }

  /**
   * Requests are SERIALIZED rather than dropped, for the reason
   * `usePanelLayout`'s are: two can land out of order and leave a window drawn
   * against a state main no longer has, and a dropped one leaves a window open
   * on something nothing will correct. Both are real here — a dwarf can be
   * clicked while a launch is handing its own over.
   */
  let queue: Promise<void> = Promise.resolve()

  async function send(request: MessagePanelState): Promise<void> {
    try {
      state.value = await window.api.setMessagePanel(request)
    } catch {
      // The failed request may or may not have reached main before breaking:
      // re-read the real state rather than assume either outcome.
      await sync()
    }
  }

  function apply(request: MessagePanelState): Promise<void> {
    queue = queue.then(() => send(request))
    return queue
  }

  /** Open the panel on one dwarf, in the mine it belongs to. */
  function openMessage(mineId: string, dwarfId: string): Promise<void> {
    return apply({ surface: 'message', mineId, dwarfId })
  }

  /** Open the Add Panel on a mine — the launch has produced no dwarf yet. */
  function openLaunch(mineId: string): Promise<void> {
    return apply({ surface: 'launch', mineId, dwarfId: '' })
  }

  /** Close the window's surface, naming neither a mine nor a dwarf. */
  function close(): Promise<void> {
    return apply({ surface: 'none', mineId: '', dwarfId: '' })
  }

  /**
   * Hear the state the OTHER window set. Returns the unsubscribe.
   *
   * Called BEFORE `sync` on mount, deliberately: a push that arrived between
   * the two would otherwise be the one change nobody heard, and the pull that
   * follows it carries the same or newer state anyway.
   */
  function listen(): () => void {
    return window.api.onMessagePanel((next) => {
      state.value = next
    })
  }

  return { state, sync, listen, openMessage, openLaunch, close }
}
