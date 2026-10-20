// ModeTiming: driven port of the window module, main half (ISSUE-284; ADR-025 item 3; 07 machine 27): the UI-main
// clock the `ModeCoordinator` reads for a run's shared `t0` (clock + 16 ms, S27.02) and the one-shot timer it arms for
// the M + 40 ms watchdog (S27.04, NFR-TIM-16). Injected so the coordinator's tests use `FakeModeTiming` and no real
// timers (17 §5.3). Adapter `SystemModeTiming`, double `FakeModeTiming`; both run `runModeTimingContract`.

export interface ModeTiming {
  /** The UI-main clock, in milliseconds; never goes back. */
  now(): number
  /** Runs `fire` once, `ms` milliseconds from now; answers a cancel that keeps it from running. */
  after(ms: number, fire: () => void): () => void
}
