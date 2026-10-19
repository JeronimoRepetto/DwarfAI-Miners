// The time source of the UI logger and the renderer-diagnostics rate limit: milliseconds since the epoch. The
// composition root binds `Date.now`; tests bind `FakeClock` (17 §2.2: no real timers below L4).
export interface UiClock {
  now(): number
}
