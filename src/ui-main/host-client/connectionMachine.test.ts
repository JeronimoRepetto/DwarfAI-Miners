// layer: L1
import { describe, expect, it } from 'vitest'
import {
  initialMachine,
  step,
  wireState,
  type ConnectionAction,
  type ConnectionEvent,
  type ConnectionMachine,
  type TransitionId
} from './connectionMachine'

// L1 (17 §1.1): the pure 12B transitions of the UI host connection (07 §12B S12.B01…S12.B15; 07 §12A S12.19, S12.20;
// ADR-002 D9; ADR-003 item 9; 16 §4.14.1), fed by a fake clock reading. TC-052-01, TC-052-03, TC-052-04.

const MINUTE = 60_000
/** HOST_UNRESPONSIVE_MS (ADR-003 item 9; 16 §4.14.1). */
const HOST_UNRESPONSIVE = 60_000

/** A fake clock: the machine reads time only from what the test passes. */
class FakeClock {
  at = 0
  advance(ms: number): number {
    this.at += ms
    return this.at
  }
}

/** Drives one machine and records every transition it took and every action it asked for. */
function drive(start: ConnectionMachine = initialMachine(0), clock = new FakeClock()) {
  let machine = start
  const transitions: TransitionId[] = []
  const actions: ConnectionAction[][] = []
  return {
    clock,
    get machine() {
      return machine
    },
    get wire() {
      return wireState(machine)
    },
    transitions,
    actions,
    send(event: ConnectionEvent): ConnectionAction[] {
      const next = step(machine, event, clock.at)
      machine = next.machine
      if (next.transition !== null) transitions.push(next.transition)
      actions.push(next.actions)
      return next.actions
    }
  }
}

const kinds = (actions: ConnectionAction[]): string[] => actions.map((a) => a.kind)

/** A machine that is connected, last heard at the clock's current reading. */
function connected(clock = new FakeClock()) {
  const d = drive(initialMachine(clock.at), clock)
  d.send({ kind: 'hello-ok', hostVersion: '1.0.0', compat: false })
  d.transitions.length = 0
  d.actions.length = 0
  return d
}

/** A connected machine that lost its connection and whose reconnects find the endpoint bound but silent. */
function hung(clock = new FakeClock()) {
  const d = connected(clock)
  d.send({ kind: 'lost' })
  d.send({ kind: 'endpoint', bound: true })
  clock.advance(HOST_UNRESPONSIVE)
  d.send({ kind: 'tick' })
  d.transitions.length = 0
  d.actions.length = 0
  return d
}
describe('the 12B connection machine (07 §12B)', () => {
  it('[S12.B04] a lost connection moves to reconnecting and keeps the last snapshot read-only', () => {
    const clock = new FakeClock()
    clock.advance(1_000)
    const d = connected(clock)
    clock.advance(500)

    const actions = d.send({ kind: 'lost' })

    expect(d.wire).toEqual({ state: 'reconnecting', since: 1_500 })
    expect(d.transitions).toEqual(['S12.B04'])
    // Reconnect only: no snapshot is asked for, so the board the handlers hold stays as it is (read-only).
    expect(kinds(actions)).toEqual(['reconnect'])
  })

  it('[S12.B06, FM-007] the third Host crash within 5 minutes moves to unavailable crash-loop and stops respawning', () => {
    const clock = new FakeClock()
    const d = connected(clock)
    d.send({ kind: 'lost' })

    // Crashes at 0, 2 min and 5 min + 1 ms: the first is older than 5 minutes when the third happens.
    expect(kinds(d.send({ kind: 'endpoint', bound: false }))).toEqual(['respawn'])
    clock.advance(2 * MINUTE)
    expect(kinds(d.send({ kind: 'endpoint', bound: false }))).toEqual(['respawn'])
    clock.advance(3 * MINUTE + 1)
    expect(kinds(d.send({ kind: 'endpoint', bound: false }))).toEqual(['respawn'])
    expect(d.wire.state).toBe('reconnecting')

    // The fourth, 1 ms later: three crashes (2 min, 5 min + 1 ms, 5 min + 2 ms) fall within 5 minutes.
    clock.advance(1)
    const actions = d.send({ kind: 'endpoint', bound: false })

    expect(d.wire).toEqual({ state: 'unavailable', reason: 'crash-loop' })
    expect(d.transitions).toEqual(['S12.B04', 'S12.19', 'S12.19', 'S12.19', 'S12.B06'])
    expect(actions).toEqual([])
    // Nothing respawns until the person's retry.
    expect(kinds(d.send({ kind: 'endpoint', bound: false }))).toEqual([])
    expect(d.wire).toEqual({ state: 'unavailable', reason: 'crash-loop' })
  })

  it('[S12.B09, FM-014] 60 s with no frame while the endpoint stays bound moves to unavailable unresponsive, never earlier', () => {
    const clock = new FakeClock()
    const d = connected(clock)
    d.send({ kind: 'frame' }) // last frame at 0
    clock.advance(15_000)
    d.send({ kind: 'lost' }) // the 15 s silence of S12.B04 is part of the 60 s
    d.send({ kind: 'endpoint', bound: true })

    clock.advance(44_999)
    d.send({ kind: 'tick' })
    expect(d.wire.state).toBe('reconnecting')

    clock.advance(1)
    const actions = d.send({ kind: 'tick' })
    expect(d.wire).toEqual({ state: 'unavailable', reason: 'unresponsive' })
    expect(d.transitions).toEqual(['S12.B04', 'S12.B09'])
    // Nothing is ended and nothing respawns: the person's Retry decides.
    expect(actions).toEqual([])

    // An endpoint that is gone is a crash, never unresponsive, however long the silence.
    const gone = connected(new FakeClock())
    gone.send({ kind: 'lost' })
    gone.clock.advance(HOST_UNRESPONSIVE)
    gone.send({ kind: 'tick' })
    expect(gone.wire.state).toBe('reconnecting')
  })

  it('[S12.B10] 60 s with no hello.ok after the connect while the endpoint is bound moves to unavailable unresponsive', () => {
    const clock = new FakeClock()
    const d = drive(initialMachine(0), clock)
    d.send({ kind: 'endpoint', bound: true })
    clock.advance(59_999)
    d.send({ kind: 'tick' })
    expect(d.wire.state).toBe('connecting')

    clock.advance(1)
    d.send({ kind: 'tick' })
    expect(d.wire).toEqual({ state: 'unavailable', reason: 'unresponsive' })
    expect(d.transitions).toEqual(['S12.B10'])
  })

  it('[FM-109, CH-08, S12.B04, S12.B05] after a FakeClock jump past 15 s (sleep and wake) the connection moves to reconnecting and back once a frame arrives, and a powerMonitor resume sends an immediate ping', () => {
    const clock = new FakeClock()
    const d = connected(clock)
    d.send({ kind: 'frame' })

    // Awake: a resume while frames still flow pings at once and stays connected.
    clock.advance(4_000)
    expect(kinds(d.send({ kind: 'power-resume' }))).toEqual(['ping'])
    expect(d.wire.state).toBe('connected')
    clock.advance(10_999)
    d.send({ kind: 'tick' })
    expect(d.wire.state).toBe('connected')

    // The lid closes; the clock jumps past the 15 s silence while nothing ran.
    clock.advance(3 * MINUTE)
    expect(kinds(d.send({ kind: 'tick' }))).toEqual(['reconnect'])
    expect(d.wire).toEqual({ state: 'reconnecting', since: clock.at })

    // The Host answers again: connected, and a whole snapshot replaces the board (no walk-out from a difference).
    expect(kinds(d.send({ kind: 'hello-ok', hostVersion: '1.0.0', compat: false }))).toEqual([
      'snapshot'
    ])
    expect(d.wire).toEqual({ state: 'connected', hostVersion: '1.0.0', compat: false })
    expect(d.transitions).toEqual(['S12.B04', 'S12.B05'])
  })

  it('[S12.B13] Retry with a matching identity ends that one Host process and reconnects', () => {
    const clock = new FakeClock()
    const d = hung(clock)

    // Step 1: Retry tries one hello first; nothing is ended yet and the window keeps the hung-Host message.
    expect(kinds(d.send({ kind: 'retry' }))).toEqual(['hello-attempt'])
    expect(d.machine.state).toEqual({ state: 'retrying' })
    expect(d.wire).toEqual({ state: 'unavailable', reason: 'unresponsive' })

    // Steps 2–3: no hello within 5 s, the identity matched and that one process was ended → respawn through D4.
    clock.advance(5_000)
    const actions = d.send({ kind: 'retry-unanswered', hungEnd: 'ended' })
    expect(d.wire).toEqual({ state: 'connecting' })
    expect(kinds(actions)).toEqual(['respawn'])
    expect(d.transitions).toEqual(['S12.B11', 'S12.B13'])
    // The ended Host counts as one Host crash.
    expect(d.machine.crashes).toEqual([clock.at])
  })

  it('[S12.B14] Retry with a missing or mismatching identity signals nothing and stays unavailable', () => {
    for (const hungEnd of ['identity-missing', 'identity-mismatch', 'end-failed'] as const) {
      const d = hung()
      d.send({ kind: 'retry' })
      d.clock.advance(5_000)

      const actions = d.send({ kind: 'retry-unanswered', hungEnd })

      expect(d.wire, hungEnd).toEqual({ state: 'unavailable', reason: 'unresponsive' })
      expect(actions, hungEnd).toEqual([])
      expect(d.transitions, hungEnd).toEqual(['S12.B11', 'S12.B14'])
      expect(d.machine.crashes, hungEnd).toEqual([])
      // Retry may be pressed again.
      expect(kinds(d.send({ kind: 'retry' })), hungEnd).toEqual(['hello-attempt'])
    }
  })

  it('[ADR-002, S12.B01, S12.B02, S12.B03, S12.B05, S12.B07, S12.B08, S12.B11, S12.B12, S12.B15] the 12B table walks every remaining S12.B id with its guard and action', () => {
    // S12.B01: hello ok, same protocolVersion → connected; subscribe first, then snapshot.
    const b01 = drive()
    expect(kinds(b01.send({ kind: 'hello-ok', hostVersion: '1.0.0', compat: false }))).toEqual([
      'snapshot'
    ])
    expect(b01.wire).toEqual({ state: 'connected', hostVersion: '1.0.0', compat: false })

    // S12.B02: a different protocolVersion → connected{compat}.
    const b02 = drive()
    b02.send({ kind: 'hello-ok', hostVersion: '1.1.0', compat: true })
    expect(b02.wire).toEqual({ state: 'connected', hostVersion: '1.1.0', compat: true })

    // S12.B03: the launcher's reason, while not a bound but silent endpoint.
    const b03 = drive()
    expect(b03.send({ kind: 'launch-unavailable', reason: 'elevated-refused' })).toEqual([])
    expect(b03.wire).toEqual({ state: 'unavailable', reason: 'elevated-refused' })

    // S12.B05: the Host answers again after a loss → connected, re-snapshot.
    const b05 = connected()
    b05.send({ kind: 'lost' })
    expect(kinds(b05.send({ kind: 'hello-ok', hostVersion: '1.0.0', compat: false }))).toEqual([
      'snapshot'
    ])

    // S12.B07: retry from any reason but unresponsive and generation-restart → connecting, respawn through D4.
    const b07 = drive()
    b07.send({ kind: 'launch-unavailable', reason: 'spawn-failed' })
    expect(kinds(b07.send({ kind: 'retry' }))).toEqual(['respawn'])
    expect(b07.wire).toEqual({ state: 'connecting' })
    const restart = drive({
      ...initialMachine(0),
      state: { state: 'unavailable', reason: 'generation-restart' }
    })
    expect(restart.send({ kind: 'retry' })).toEqual([]) // no retry: S12.B16 (dormant in v1)
    expect(restart.wire).toEqual({ state: 'unavailable', reason: 'generation-restart' })

    // S12.B08: events lost while connected → stays connected, re-snapshot.
    const b08 = connected()
    expect(kinds(b08.send({ kind: 'events-lost' }))).toEqual(['snapshot'])
    expect(b08.wire.state).toBe('connected')

    // S12.B11 → S12.B12: Retry's hello answered within 5 s → connected; nothing is ended.
    const b12 = hung()
    b12.send({ kind: 'retry' })
    expect(kinds(b12.send({ kind: 'hello-ok', hostVersion: '1.0.0', compat: false }))).toEqual([
      'snapshot'
    ])
    expect(b12.machine.crashes).toEqual([])

    // S12.B15: the ended hung Host is the third Host crash within 5 minutes → crash-loop, no respawn.
    const clock = new FakeClock()
    const b15 = connected(clock)
    b15.send({ kind: 'lost' })
    b15.send({ kind: 'endpoint', bound: false })
    b15.send({ kind: 'endpoint', bound: false })
    b15.send({ kind: 'hello-ok', hostVersion: '1.0.0', compat: false })
    b15.send({ kind: 'lost' })
    b15.send({ kind: 'endpoint', bound: true })
    clock.advance(HOST_UNRESPONSIVE)
    b15.send({ kind: 'tick' })
    b15.send({ kind: 'retry' })
    expect(b15.send({ kind: 'retry-unanswered', hungEnd: 'ended' })).toEqual([])
    expect(b15.wire).toEqual({ state: 'unavailable', reason: 'crash-loop' })

    const walked = [b01, b02, b03, b05, b07, b08, b12, b15].flatMap((d) => d.transitions)
    expect(new Set(walked)).toEqual(
      new Set([
        'S12.B01',
        'S12.B02',
        'S12.B03',
        'S12.B04',
        'S12.B05',
        'S12.B07',
        'S12.B08',
        'S12.B09',
        'S12.B11',
        'S12.B12',
        'S12.B15',
        'S12.19'
      ])
    )
  })
})
