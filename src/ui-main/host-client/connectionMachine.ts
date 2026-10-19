// The UI host connection machine (07 §12B S12.B01…S12.B15; 07 §12A S12.19, S12.20; ADR-002 D9; ADR-003 item 9;
// 16 §4.14.1): pure transitions over ADR-002 D9's `HostConnection` plus `retrying`, the Electron-main-only state of a
// hung-Host Retry in progress. Time comes in as the clock reading of each event; nothing here reads a clock, starts a
// timer or touches a connection: `step` answers the next machine, the 12B row it took and the actions HostClient
// runs (HostClient.ts).
//
// - The wire state (`wireState`) is ADR-002 D9's: `retrying` is not a wire state, so the renderer keeps
//   `unavailable{unresponsive}` until the Retry settles (07 §12B intro; 14 §3.8 `HostConnectionView` unchanged).
// - Crash-loop (S12.19, S12.20, S12.B06, S12.B15): every Host crash is remembered with its time; the third within
//   CRASH_LOOP_WINDOW_MS stops respawning until the person's retry. A Host crash is a reconnect attempt that finds no
//   endpoint (`endpoint {bound: false}` while reconnecting) or a hung Host the Retry ended (`retry-unanswered
//   {ended}`). The person's retry respawns once more (13 FM-007) and forgets no crash: the window still slides.
// - Hung Host (S12.B09, S12.B10): HOST_UNRESPONSIVE_MS with no frame from the Host (no `hello.ok`, no pong, no event;
//   the 15 s of S12.B04 included) while the last attempt found the endpoint bound → `unavailable{unresponsive}`.
// - Liveness (ADR-003 item 9; 13 FM-109): a `tick` LIVENESS_SILENCE_MS after the last frame of a connected Host is a
//   lost connection (a clock that jumped over a sleep); a power resume asks for an immediate ping.
import type { HostConnection, HostUnavailableReason } from '../window/ports/hostClient'
import { LIVENESS_SILENCE_MS } from './channel'

/** ADR-003 item 9 (AMENDMENT-2, AR-13-02): no frame for this long while the endpoint stays bound → unresponsive. */
export const HOST_UNRESPONSIVE_MS = 60_000
/** ADR-002 D9: three Host crashes within five minutes → crash-loop. */
export const CRASH_LOOP_CRASHES = 3
export const CRASH_LOOP_WINDOW_MS = 5 * 60_000

/** ADR-002 D9's states plus `retrying` (07 §12B). */
export type ConnectionState = HostConnection | { state: 'retrying' }

/** What the Retry's identity-checked end found (ADR-002 D9 steps 2, 4; 19 §9.1 `host.hung-end`). */
export type HungEndOutcome = 'ended' | 'identity-missing' | 'identity-mismatch' | 'end-failed'

/** The 12B row a step took; `S12.19` is 12A's silent respawn, which a reconnect asks for. */
export type TransitionId = `S12.B${string}` | 'S12.19'

export interface ConnectionMachine {
  readonly state: ConnectionState
  /** The times of the Host crashes still within CRASH_LOOP_WINDOW_MS of the last one. */
  readonly crashes: readonly number[]
  /** The time of the last frame from the Host, or when this attach began if none arrived since. */
  readonly quietSince: number
  /** The last attempt without a `hello.ok` found the endpoint bound (a connection was accepted). */
  readonly endpointBound: boolean
}

export type ConnectionEvent =
  /** A connection's `hello.ok`; `compat` when the Host's protocolVersion differs (ADR-002 D8). */
  | { kind: 'hello-ok'; hostVersion: string; compat: boolean }
  /** The launcher could not attach or spawn (ADR-002 D4, D6). */
  | {
      kind: 'launch-unavailable'
      reason: Exclude<HostUnavailableReason, 'crash-loop' | 'unresponsive'>
    }
  /** Any frame from the Host. */
  | { kind: 'frame' }
  /** The connection closed without `host.closing`, or went silent (ADR-003 item 9). */
  | { kind: 'lost' }
  /** `events_lost` / `resync-required` (ADR-003 item 7). */
  | { kind: 'events-lost' }
  /** An attempt got no `hello.ok`: something accepted the connection (`bound`), or nothing listens. */
  | { kind: 'endpoint'; bound: boolean }
  /** A timer fired: the guards that depend on time alone are evaluated. */
  | { kind: 'tick' }
  /** The person's retry (`retryHostConnection`, 14 A-N05 → `HostClient.ensureHost()`). */
  | { kind: 'retry' }
  /** The Retry's hello got no answer within its 5 s; `hungEnd` is what the identity-checked end found. */
  | { kind: 'retry-unanswered'; hungEnd: HungEndOutcome }
  /** Electron `powerMonitor` `resume` (13 FM-109). */
  | { kind: 'power-resume' }
  /** `host.closing` before the close: DwarfAI's own stop, no reconnect (ADR-002 D7). */
  | { kind: 'closing' }

export type ConnectionAction =
  /** Subscribe first, then the paged snapshot (a fresh one replaces the board; no walk-out from a difference). */
  | { kind: 'snapshot' }
  /** Drop the connections and try again on the ADR-002 D9 schedule. */
  | { kind: 'reconnect' }
  /** Attach or spawn through the launcher (ADR-002 D4). */
  | { kind: 'respawn' }
  /** One normal connect + `hello` with the 5 s budget (ADR-002 D9 step 1). */
  | { kind: 'hello-attempt' }
  /** Ping the Host now. */
  | { kind: 'ping' }

export interface Step {
  machine: ConnectionMachine
  transition: TransitionId | null
  actions: ConnectionAction[]
}

export function initialMachine(now: number): ConnectionMachine {
  return { state: { state: 'connecting' }, crashes: [], quietSince: now, endpointBound: false }
}

/** ADR-002 D9's state of `machine`: `retrying` shows as the hung-Host state it started from. */
export function wireState(machine: ConnectionMachine): HostConnection {
  return machine.state.state === 'retrying'
    ? { state: 'unavailable', reason: 'unresponsive' }
    : machine.state
}

const stay = (machine: ConnectionMachine, actions: ConnectionAction[] = []): Step => ({
  machine,
  transition: null,
  actions
})

const to = (
  machine: ConnectionMachine,
  transition: TransitionId,
  actions: ConnectionAction[] = []
): Step => ({ machine, transition, actions })

const unavailable = (reason: HostUnavailableReason): ConnectionState => ({
  state: 'unavailable',
  reason
})

/** `machine` with one more crash at `now`, older ones that left the window dropped. */
function withCrash(machine: ConnectionMachine, now: number): ConnectionMachine {
  return {
    ...machine,
    crashes: [...machine.crashes.filter((at) => now - at < CRASH_LOOP_WINDOW_MS), now]
  }
}

const isCrashLoop = (machine: ConnectionMachine): boolean =>
  machine.crashes.length >= CRASH_LOOP_CRASHES

/** S12.B09 / S12.B10: the endpoint is bound and the Host has been silent for HOST_UNRESPONSIVE_MS. */
function unresponsive(machine: ConnectionMachine, now: number): Step | null {
  const { state } = machine.state
  if (state !== 'connecting' && state !== 'reconnecting') return null
  if (!machine.endpointBound || now - machine.quietSince < HOST_UNRESPONSIVE_MS) return null
  return to(
    { ...machine, state: unavailable('unresponsive') },
    state === 'reconnecting' ? 'S12.B09' : 'S12.B10'
  )
}

export function step(machine: ConnectionMachine, event: ConnectionEvent, now: number): Step {
  const { state } = machine.state
  switch (event.kind) {
    case 'hello-ok': {
      const transition = (
        {
          connecting: event.compat ? 'S12.B02' : 'S12.B01',
          reconnecting: 'S12.B05',
          retrying: 'S12.B12'
        } as const
      )[state as 'connecting' | 'reconnecting' | 'retrying']
      if (transition === undefined) return stay(machine)
      const next: ConnectionMachine = {
        ...machine,
        state: { state: 'connected', hostVersion: event.hostVersion, compat: event.compat },
        quietSince: now,
        endpointBound: false
      }
      return to(next, transition, [{ kind: 'snapshot' }])
    }
    case 'launch-unavailable': {
      if (state !== 'connecting' && state !== 'reconnecting') return stay(machine)
      const next = { ...machine, state: unavailable(event.reason) }
      return state === 'connecting' ? to(next, 'S12.B03') : stay(next)
    }
    case 'frame':
      return stay({ ...machine, quietSince: now })
    case 'lost':
      if (state !== 'connected') return stay(machine)
      return to(
        { ...machine, state: { state: 'reconnecting', since: now }, endpointBound: false },
        'S12.B04',
        [{ kind: 'reconnect' }]
      )
    case 'events-lost':
      return state === 'connected' ? to(machine, 'S12.B08', [{ kind: 'snapshot' }]) : stay(machine)
    case 'endpoint': {
      if (state !== 'connecting' && state !== 'reconnecting') return stay(machine)
      if (event.bound) {
        const bound = { ...machine, endpointBound: true }
        return unresponsive(bound, now) ?? stay(bound)
      }
      // Nothing listens: while connecting the launcher spawns; while reconnecting the Host crashed (S12.19/S12.20).
      if (state === 'connecting') return stay({ ...machine, endpointBound: false })
      const crashed = withCrash({ ...machine, endpointBound: false }, now)
      return isCrashLoop(crashed)
        ? to({ ...crashed, state: unavailable('crash-loop') }, 'S12.B06')
        : to(crashed, 'S12.19', [{ kind: 'respawn' }])
    }
    case 'tick': {
      if (state === 'connected' && now - machine.quietSince >= LIVENESS_SILENCE_MS) {
        return step(machine, { kind: 'lost' }, now)
      }
      return unresponsive(machine, now) ?? stay(machine)
    }
    case 'retry': {
      if (machine.state.state !== 'unavailable') return stay(machine)
      const { reason } = machine.state
      if (reason === 'generation-restart') return stay(machine) // no retry: S12.B16 (dormant in v1)
      if (reason === 'unresponsive') {
        return to({ ...machine, state: { state: 'retrying' } }, 'S12.B11', [
          { kind: 'hello-attempt' }
        ])
      }
      return to(
        { ...machine, state: { state: 'connecting' }, quietSince: now, endpointBound: false },
        'S12.B07',
        [{ kind: 'respawn' }]
      )
    }
    case 'retry-unanswered': {
      if (state !== 'retrying') return stay(machine)
      if (event.hungEnd !== 'ended') {
        return to({ ...machine, state: unavailable('unresponsive') }, 'S12.B14')
      }
      const crashed = withCrash(machine, now)
      if (isCrashLoop(crashed)) {
        return to({ ...crashed, state: unavailable('crash-loop') }, 'S12.B15')
      }
      return to(
        { ...crashed, state: { state: 'connecting' }, quietSince: now, endpointBound: false },
        'S12.B13',
        [{ kind: 'respawn' }]
      )
    }
    case 'power-resume':
      return state === 'connected' ? stay(machine, [{ kind: 'ping' }]) : stay(machine)
    case 'closing':
      return state === 'connected'
        ? stay({
            ...machine,
            state: { state: 'connecting' },
            quietSince: now,
            endpointBound: false
          })
        : stay(machine)
  }
}
