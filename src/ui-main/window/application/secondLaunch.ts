import type { PanelWindowController } from '../ports/panelWindowController'
import type { SingleInstanceLock } from '../ports/singleInstanceLock'

/**
 * The second launch of the app (07 S10.02; UC-033; FM-138; PO #73): the running instance comes
 * forward, and a hidden window shows itself as it was left. Nothing else happens: no dialog, no
 * notice, no second window or process (the second process quits on its own when it cannot take
 * the lock, UC-033 step 4).
 */
export interface SecondLaunch {
  /**
   * Hands over the Panel window once it exists. A launch that arrived while the running instance
   * was still starting (lock taken, window not yet created) is answered here, once (UC-033
   * "The running instance is starting up").
   */
  attach(panel: PanelWindowController): void
}

/** Subscribes to the lock's second-launch event; call it right after the lock was acquired. */
export function wireSecondLaunch(lock: SingleInstanceLock): SecondLaunch {
  let panel: PanelWindowController | null = null
  let pending = false

  lock.onSecondLaunch(() => {
    if (panel === null) {
      pending = true
      return
    }
    panel.show()
  })

  return {
    attach(attached) {
      panel = attached
      if (!pending) return
      pending = false
      attached.show()
    }
  }
}
