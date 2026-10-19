// The NotifierLauncher conformance suite (16 §4.11; 17 §1.3): run on `FakeNotifierLauncher` and on
// `AppBackgroundNotifierLauncher` over `FakeProcessControl`. One `ensureNotifier` is one start: it
// settles `'attached'` once a `notifier` attaches, `'spawn-failed'` when the start fails first, and
// it settles once (07 S12.C03, S12.C04). Never imported by production code (R14).
import { afterEach, describe, expect, it } from 'vitest'
import type { NotifierLauncher } from '../ports/notifierLauncher'

export interface NotifierLauncherSubject {
  launcher: NotifierLauncher
  /** A `notifier` client attaches to the Host (the started app's tray connection). */
  notifierAttaches(): void
  /** The start fails before a notifier attached (the process exits, or never starts). */
  startFails(): void
  dispose(): void | Promise<void>
}

/** Lets every queued microtask and promise reaction run. */
async function settled(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

export function runNotifierLauncherContract(
  makeSubject: () => NotifierLauncherSubject | Promise<NotifierLauncherSubject>
): void {
  describe('NotifierLauncher contract', () => {
    let subject: NotifierLauncherSubject | null = null

    afterEach(async () => {
      await subject?.dispose()
      subject = null
    })

    it('[ADR-018, S12.C03] a start settles attached once a notifier attaches', async () => {
      subject = await makeSubject()
      let outcome: string | null = null
      void subject.launcher.ensureNotifier().then((value) => (outcome = value))
      await settled()
      expect(outcome).toBeNull()

      subject.notifierAttaches()
      await settled()
      expect(outcome).toBe('attached')
    })

    it('[ADR-018, S12.C04] a start that fails before a notifier attached settles spawn-failed, once', async () => {
      subject = await makeSubject()
      const outcomes: string[] = []
      void subject.launcher.ensureNotifier().then((value) => outcomes.push(value))
      await settled()

      subject.startFails()
      await settled()
      subject.notifierAttaches()
      await settled()
      expect(outcomes).toStrictEqual(['spawn-failed'])
    })
  })
}
