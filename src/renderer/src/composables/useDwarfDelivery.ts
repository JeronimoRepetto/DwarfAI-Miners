import { ref } from 'vue'
import type { DwarfDeliveryReport } from '../types'

/**
 * The send and kick verdicts the message-panel window holds, as the SHELL
 * reads them (#162).
 *
 * Read-only on this side, and that is the point. The composer and the kick
 * control live in the panel window, so that window owns both stores —
 * including the reaction watch that folds each poll's snapshot in and decides
 * when a ✓ may become a ✓✓ (see `useDwarfMessaging`). The marker each verdict
 * drives is drawn on the dwarf's own sprite, inside the mine, which is here.
 * So the state is published rather than duplicated: a second store here could
 * only ever disagree with the one that is actually watching.
 *
 * Whole reports rather than deltas, because those stores expire their own
 * entries on timers: a marker missing from a report is a marker whose four
 * seconds are up, and merging would leave every verdict on the mine forever.
 */
export function useDwarfDelivery() {
  // Nothing has been sent or kicked when the app starts, so an empty report is
  // the truth rather than a placeholder.
  const report = ref<DwarfDeliveryReport>({ send: {}, kick: {} })

  /** Hear what the panel window published. Returns the unsubscribe. */
  function listen(): () => void {
    return window.api.onDwarfDeliveryReport((next) => {
      report.value = next
    })
  }

  return { report, listen }
}
