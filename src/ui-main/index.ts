import { app, clipboard, dialog, globalShortcut, nativeImage, shell } from 'electron'
import {
  composeLegacyRuntime,
  createLegacyRuntimeRoute,
  type LegacyRuntimeRoute
} from '../legacy-bridge/LegacyRuntimeRoute'
import { ElectronSingleInstanceLock } from './window/adapters/ElectronSingleInstanceLock'
import { wireSecondLaunch } from './window/application/secondLaunch'
import type { SingleInstanceLock } from './window/ports/singleInstanceLock'

/** The Electron `app` events and exits the root needs, as plain calls (bound in the Electron wiring below). */
export interface UiMainLifecycle {
  quit(): void
  exit(code: number): void
  whenReady(): Promise<unknown>
  onBeforeQuit(h: () => void): void
  onWillQuit(h: () => void): void
  onWindowAllClosed(h: () => void): void
}

export interface UiMainDeps {
  lock: SingleInstanceLock
  lifecycle: UiMainLifecycle
  legacyRuntime: Pick<LegacyRuntimeRoute, 'compose' | 'beforeQuit' | 'willQuit'>
}

/**
 * The Electron composition root (05 §2.3; 16 §8.4; ADR-001 item 3). The single-instance lock is
 * taken first; a process that does not get it quits before composing anything (UC-033, PO #73).
 * The holder wires the second-launch use case (S10.02), then, once Electron is ready, composes
 * today's runtime through its one door `LegacyRuntimeRoute` (21 §3) and hands that runtime's Panel
 * window to the second-launch use case. The router (ISSUE-043), the Host client (ISSUE-051) and
 * the rebuilt window module (ISSUE-046, ISSUE-047) join here in their own issues.
 *
 * The answer settles when the start has finished: at once for a process that quit, after the
 * composition (or the exit it caused) for the lock holder.
 */
export async function startUiMain({ lock, lifecycle, legacyRuntime }: UiMainDeps): Promise<void> {
  if (!lock.acquire()) {
    lifecycle.quit()
    return
  }
  const secondLaunch = wireSecondLaunch(lock)
  lifecycle.onBeforeQuit(() => legacyRuntime.beforeQuit())
  lifecycle.onWillQuit(() => legacyRuntime.willQuit())
  // The app lives in the tray with every window hidden: closing the last window never quits it
  // (only the tray's Quit does), as today.
  lifecycle.onWindowAllClosed(() => {})
  try {
    await lifecycle.whenReady()
    secondLaunch.attach(await legacyRuntime.compose())
  } catch {
    // Today's composition reports its own failure before it rethrows (LegacyRuntimeRoute).
    lifecycle.exit(1)
  }
}

/** The Electron `app` behind `UiMainLifecycle`. */
function electronLifecycle(): UiMainLifecycle {
  return {
    quit: () => app.quit(),
    exit: (code) => app.exit(code),
    whenReady: () => app.whenReady(),
    onBeforeQuit: (h) => {
      app.on('before-quit', () => h())
    },
    onWillQuit: (h) => {
      app.on('will-quit', () => h())
    },
    onWindowAllClosed: (h) => {
      app.on('window-all-closed', () => h())
    }
  }
}

// The Electron wiring: the lock first, then the rest (16 §8.4). It runs only when Electron's main
// process loads this file as its entry (`process.type === 'browser'`), never when a test imports
// `startUiMain` from it.
if (process.type === 'browser') {
  void startUiMain({
    lock: new ElectronSingleInstanceLock(app),
    lifecycle: electronLifecycle(),
    legacyRuntime: createLegacyRuntimeRoute(
      composeLegacyRuntime({ app, dialog, nativeImage, shell, clipboard, globalShortcut })
    )
  })
}
