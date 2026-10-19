// The Host side of liveness (ADR-003 item 9 with AMENDMENT-10, frozen; 16 §2.6): silence detection
// only. The UI pings every 5 s while idle (B-M02) and the Host answers; the Host sends no ping and
// no other unlisted frame. A connection that sent no whole frame for 15 s, or that closed, is a
// detached client: connection.ts ends it and logs `channel.detach` (reason `silent` for the
// first), and no session, ask or dwarf changes (ADR-002 D1: sessions outlive clients).
//
// The 15 s run on the injected Scheduler, never a real timer (16 §2.6).
import type { Scheduler } from '../kernel/ports/scheduler'

/** 15 s without a frame → the connection is a detached client (ADR-003 item 9; 16 §2.6). */
export const SILENCE_MS = 15_000

/** One connection's silence watch. */
export interface SilenceWatch {
  /** A whole frame arrived: the 15 s start again from now. */
  heard(): void
  /** The connection closed: the watch ends and never fires. */
  stop(): void
}

/** Starts watching from now; `onSilent` runs once, after `SILENCE_MS` without `heard()`. */
export function watchSilence(scheduler: Scheduler, onSilent: () => void): SilenceWatch {
  let stopped = false
  const arm = () =>
    scheduler.after(SILENCE_MS, () => {
      if (stopped) return
      stopped = true
      onSilent()
    })
  let timer = arm()
  return {
    heard() {
      if (stopped) return
      timer.cancel()
      timer = arm()
    },
    stop() {
      stopped = true
      timer.cancel()
    }
  }
}
