// Driven port (05 §3.11, 16 §4.11, frozen): starts the app `--background` (tray only, no window)
// so that a UI process draws notifications while the Host runs (ADR-018 item 5; OQ-40 A). The wait
// (`TRAY_RESPAWN_DELAY_MS`, 2 s) and the budget (3 starts per 5 minutes, for the Host's whole life)
// are machine 12C's (domain/notifierPresence.ts), carried out by application/notifierSupervisor.ts,
// which calls this port once per start. Adapter `AppBackgroundNotifierLauncher` (spawns through
// `ProcessControl.spawn`); double `FakeNotifierLauncher`.
//
// `'attached'`: a `notifier` client attached after the start. `'spawn-failed'`: the app could not
// start, or exited before a `notifier` attached. `'gave-up'`: the launcher refuses to start (the
// supervisor gives up as on a third failure).
export interface NotifierLauncher {
  ensureNotifier(): Promise<'attached' | 'spawn-failed' | 'gave-up'>
}
