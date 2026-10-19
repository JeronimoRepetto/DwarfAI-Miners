import type { UiLog, UiLogEntry } from '../../diagnostics/uiLogger'
import { isNewerAppVersion } from '../domain/appVersion'
import type { PanelWindowController } from '../ports/panelWindowController'
import type { SingleInstanceLock } from '../ports/singleInstanceLock'

/**
 * The second launch of the app (07 S10.02; UC-033; FM-138; PO #73): the running instance comes
 * forward, and a hidden window shows itself as it was left. Nothing else happens: no dialog, no
 * notice, no second window or process (the second process quits on its own when it cannot take
 * the lock, UC-033 step 4).
 *
 * A launch of a newer build (AMENDMENT-25, 16 §4.14 as amended): the running instance replaces itself with it — the
 * lock's `replaceWithIt()` releases the lock, starts the launch's own program and quits this UI process — once the
 * step is logged and the log written out. The Host is never touched (ADR-002 D7): no Host command is sent, and the
 * relaunched newer UI runs the D8 decision at its own start. An equal or older launch, or one without a version,
 * keeps the behaviour above (ADR-002 D3).
 */
export interface SecondLaunch {
  /**
   * Hands over the Panel window once it exists. A launch that arrived while the running instance
   * was still starting (lock taken, window not yet created) is answered here, once (UC-033
   * "The running instance is starting up").
   */
  attach(panel: PanelWindowController): void
}

/** The running instance as the newer-launch decision needs it: its own version, and the UI log. */
export interface RunningInstance {
  appVersion: string
  log?: UiLog & { flush?(): Promise<void> }
}

/** The record of a running instance that stepped aside for a newer launch (ADR-026: allowlisted fields only). */
export const STEPPED_ASIDE: UiLogEntry = {
  level: 'info',
  event: 'ui.single-instance',
  subsystem: 'window',
  outcome: 'ok',
  causeClass: 'replaced-by-newer-launch',
  msg: 'stepped aside for a newer launch'
}

/**
 * Subscribes to the lock's second-launch event; call it right after the lock was acquired. Without `running`, no
 * launch is taken as newer.
 */
export function wireSecondLaunch(
  lock: SingleInstanceLock,
  running?: RunningInstance
): SecondLaunch {
  let panel: PanelWindowController | null = null
  let pending = false
  let replacing = false

  lock.onSecondLaunch((launch) => {
    if (replacing) return
    if (running !== undefined && isNewerAppVersion(launch.appVersion, running.appVersion)) {
      replacing = true
      running.log?.record(STEPPED_ASIDE)
      void Promise.resolve(running.log?.flush?.())
        .catch(() => {})
        .then(() => launch.replaceWithIt())
      return
    }
    if (panel === null) {
      pending = true
      return
    }
    panel.show()
  })

  return {
    attach(attached) {
      panel = attached
      if (!pending || replacing) return
      pending = false
      attached.show()
    }
  }
}
