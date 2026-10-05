// The tray notifier supervisor (07 §12C; 16 §4.11 `NotifierLauncher`; ADR-018 item 5): while the
// Host runs there is always a UI process with the tray icon to draw notifications.
//
// - It is fed by the transport connection registry with each client that attaches or detaches
//   (wired by ISSUE-119). Only `ui` and `notifier` clients count; a `viewer` or `mcp` client never
//   does.
// - When the last of them detaches without a Host exit, machine 12C (domain/notifierPresence.ts)
//   waits TRAY_RESPAWN_DELAY_MS on the kernel Scheduler and then starts the app `--background`
//   through `NotifierLauncher.ensureNotifier`, at most 3 times per 5 minutes; the clock's instant
//   of each start is counted.
// - A start that fails waits again; giving up logs one `notifier.respawn` warning and starts
//   nothing until a UI attaches. The supervisor holds no way to end a process or the Host: it never
//   exits because of a failure (ADR-002 D7, OQ-63), and every session keeps running (FM-041,
//   FM-042).
// - A `notifier` attaching draws the pending notifications (S12.C03): `drawPending` is the policy's
//   `notifierAttached`, which sends every standing notification again (14 §2.3).
import type { Clock } from '../../../kernel/ports/clock'
import type { DiagnosticsLog } from '../../../kernel/ports/diagnosticsLog'
import type { Scheduler } from '../../../kernel/ports/scheduler'
import {
  initialNotifierPresence,
  nextNotifierPresence,
  type NotifierLauncherState,
  type NotifierPresence,
  type NotifierPresenceEffect,
  type NotifierPresenceEvent
} from '../domain/notifierPresence'
import type { NotifierLauncher } from '../ports/notifierLauncher'

export interface NotifierSupervisorDeps {
  launcher: NotifierLauncher
  scheduler: Scheduler
  clock: Clock
  log: DiagnosticsLog
  /** S12.C03: the policy sends every standing notification to the attached notifier. */
  drawPending: () => void
}

/** What the supervisor reads of an attached connection (the registry's `AttachedConnection`). */
export interface UiClientConnection {
  readonly clientId: string
  readonly role: string
}

const EVENT = 'notifier.respawn'
const SUBSYSTEM = 'attention'

export class NotifierSupervisor {
  private presence: NotifierPresence = initialNotifierPresence()
  private readonly attached = new Set<string>()
  private wait: { cancel(): void } | null = null

  constructor(private readonly deps: NotifierSupervisorDeps) {}

  /** 12C's current state (07 §0.2 `NotifierLauncherState`). */
  state(): NotifierLauncherState {
    return this.presence.state
  }

  clientAttached(client: UiClientConnection): void {
    const role = uiRole(client.role)
    if (role === null) return
    this.attached.add(client.clientId)
    this.apply({ type: 'client-attached', role })
  }

  clientDetached(client: UiClientConnection): void {
    if (uiRole(client.role) === null || !this.attached.delete(client.clientId)) return
    if (this.attached.size === 0) this.apply({ type: 'last-client-detached' })
  }

  private apply(event: NotifierPresenceEvent): void {
    const step = nextNotifierPresence(this.presence, event)
    this.presence = step.presence
    for (const effect of step.effects) this.run(effect)
  }

  private run(effect: NotifierPresenceEffect): void {
    switch (effect.effect) {
      case 'schedule-start':
        this.cancelWait()
        this.wait = this.deps.scheduler.after(effect.delayMs, () => {
          this.wait = null
          this.apply({ type: 'respawn-due', at: this.deps.clock.now() })
        })
        return
      case 'cancel-start':
        this.cancelWait()
        return
      case 'start':
        this.start()
        return
      case 'give-up':
        this.deps.log.record({
          level: 'warn',
          event: EVENT,
          subsystem: SUBSYSTEM,
          outcome: 'failed',
          causeClass: 'gave-up',
          count: effect.attempts
        })
        return
      case 'draw-pending':
        this.deps.drawPending()
        return
    }
  }

  private start(): void {
    this.deps.log.record({
      level: 'info',
      event: EVENT,
      subsystem: SUBSYSTEM,
      count: this.presence.attempts.length
    })
    this.deps.launcher.ensureNotifier().then(
      (outcome) => this.settled(outcome),
      () => this.settled('spawn-failed')
    )
  }

  /** `'attached'` changes nothing here: the notifier's own attach moved 12C already. */
  private settled(outcome: 'attached' | 'spawn-failed' | 'gave-up'): void {
    if (outcome === 'spawn-failed') {
      this.apply({ type: 'start-failed', at: this.deps.clock.now() })
    } else if (outcome === 'gave-up') {
      this.apply({ type: 'launcher-gave-up' })
    }
  }

  private cancelWait(): void {
    this.wait?.cancel()
    this.wait = null
  }
}

function uiRole(role: string): 'ui' | 'notifier' | null {
  return role === 'ui' || role === 'notifier' ? role : null
}
