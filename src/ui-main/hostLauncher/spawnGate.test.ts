import { describe, expect, it } from 'vitest'
import { FakeCopyPreparer } from './fakes/FakeCopyPreparer'
import { FakeHostSpawner } from './fakes/FakeHostSpawner'
import { FakeIdentityProbe } from './fakes/FakeIdentityProbe'
import { FakeLauncherClock } from './fakes/FakeLauncherClock'
import { InMemoryGateFiles } from './fakes/InMemoryGateFiles'
import { RecordingUiLog } from './fakes/RecordingUiLog'
import { FakeHelloProber, UNREACHABLE, helloOk } from './fakes/FakeHelloProber'
import { createHostLauncher } from './index'
import { READINESS_BUDGET_MS } from './readiness'
import { HOST_SPAWN_GATE_STALE_MS, SpawnGate, shouldTakeOver, type GateRecord } from './spawnGate'

const OWNER = { pid: 4242, processStartTimeMs: 1_000 }
const SELF = { pid: 7, processStartTimeMs: 2_000 }
const TAKEN_AT = 10_000
const HOST = {
  execPath: '/opt/DwarfAI-Miners/dwarfai-miners',
  hostEntry: '/opt/DwarfAI-Miners/resources/app.asar/out/host/main.js',
  hostDataDir: '/home/j/.config/DwarfAI-Miners/host',
  uiEnv: { PATH: '/usr/bin' }
}

function heldGate(): { files: InMemoryGateFiles; record: string } {
  const files = new InMemoryGateFiles()
  const record = JSON.stringify({ ...OWNER, at: TAKEN_AT } satisfies GateRecord)
  files.content = record
  return { files, record }
}

function gateFor(files: InMemoryGateFiles, probe: FakeIdentityProbe, clock: FakeLauncherClock) {
  return new SpawnGate({ files, probe: probe.probe, clock, self: () => Promise.resolve(SELF) })
}

describe('spawn gate (ADR-002 D3)', () => {
  it('[ADR-002, FM-010] a gate whose owner is alive and younger than 60 s is not taken over; a dead owner or a gate older than 60 s is', async () => {
    const table: Array<[ownerAlive: boolean, ageMs: number, takeOver: boolean]> = [
      [true, 0, false],
      [true, HOST_SPAWN_GATE_STALE_MS - 1, false],
      [true, HOST_SPAWN_GATE_STALE_MS, false],
      [true, HOST_SPAWN_GATE_STALE_MS + 1, true],
      [false, 0, true],
      [false, HOST_SPAWN_GATE_STALE_MS + 1, true],
      // A gate stamped in the future (the clock moved back) is young, not stale.
      [true, -5_000, false]
    ]
    for (const [ownerAlive, ageMs, takeOver] of table) {
      expect(shouldTakeOver({ ownerAlive, ageMs }), `alive=${ownerAlive} age=${ageMs}`).toBe(
        takeOver
      )
    }

    // The same rule through the gate itself: a live, young owner keeps it untouched.
    const live = heldGate()
    const liveClock = new FakeLauncherClock(TAKEN_AT + HOST_SPAWN_GATE_STALE_MS)
    const liveProbe = new FakeIdentityProbe().alive(OWNER)
    expect(await gateFor(live.files, liveProbe, liveClock).take()).toBe('held')
    expect(live.files.content).toBe(live.record)
    expect(liveProbe.asked).toEqual([OWNER])

    // A dead owner's gate is taken over at once, and the gate is now this UI's.
    const dead = heldGate()
    const deadClock = new FakeLauncherClock(TAKEN_AT + 1)
    expect(await gateFor(dead.files, new FakeIdentityProbe(), deadClock).take()).toBe('taken')
    expect(JSON.parse(dead.files.content ?? '')).toEqual({ ...SELF, at: TAKEN_AT + 1 })

    // A live owner's gate older than 60 s is taken over too.
    const old = heldGate()
    const oldClock = new FakeLauncherClock(TAKEN_AT + HOST_SPAWN_GATE_STALE_MS + 1)
    const oldProbe = new FakeIdentityProbe().alive(OWNER)
    expect(await gateFor(old.files, oldProbe, oldClock).take()).toBe('taken')
    expect(JSON.parse(old.files.content ?? '')).toMatchObject(SELF)
  })

  it('[ADR-002] a free gate is taken with this UI identity and the time, and release removes only that gate', async () => {
    const files = new InMemoryGateFiles()
    const clock = new FakeLauncherClock(TAKEN_AT)
    const gate = gateFor(files, new FakeIdentityProbe(), clock)
    expect(await gate.take()).toBe('taken')
    expect(JSON.parse(files.content ?? '')).toEqual({ ...SELF, at: TAKEN_AT })

    await gate.release()
    expect(files.content).toBeNull()

    // A gate someone else took after ours was taken over is not removed by our release.
    expect(await gate.take()).toBe('taken')
    const theirs = JSON.stringify({ ...OWNER, at: TAKEN_AT + 1 })
    files.content = theirs
    await gate.release()
    expect(files.content).toBe(theirs)
  })

  it('[ADR-002, FM-009] the loser of the gate polls the endpoint every 250 ms and attaches when hello succeeds', async () => {
    const { files } = heldGate()
    const clock = new FakeLauncherClock(TAKEN_AT + 1_000)
    const probe = new FakeIdentityProbe().alive(OWNER)
    const prober = new FakeHelloProber(clock)
    const start = clock.now()
    // The other UI's Host binds after 600 ms and is ready after 900 ms.
    prober.answer = (now) => {
      if (now - start >= 900) return helloOk('ready')
      return now - start >= 600 ? helloOk('starting') : UNREACHABLE
    }
    const spawner = new FakeHostSpawner()
    const log = new RecordingUiLog()
    const launcher = createHostLauncher({
      probe: prober.probe,
      gate: gateFor(files, probe, clock),
      spawner: spawner.spawn,
      // AMENDED for ISSUE-031: the versioned copy (AMENDED for the cut-0 conformance fixes, was: the
      // source folder itself; the double now answers a versioned folder, ADR-002 D5).
      prepareCopy: new FakeCopyPreparer(
        '/opt/DwarfAI-Miners',
        '/home/j/.local/share/dwarfai/host/1.4.0'
      ).prepare,
      host: HOST,
      clock,
      sleep: clock.sleep,
      log
    })

    expect(await launcher.ensureHostRunning()).toBe('attached')
    expect(prober.attempts.map((at) => at - start)).toEqual([0, 250, 500, 750, 1_000])
    expect(spawner.requests).toEqual([])
    expect(log.byEvent('host.spawn')).toEqual([
      expect.objectContaining({ outcome: 'skipped', causeClass: 'gate-held' })
    ])
  })

  it('[ADR-002, FM-009] the loser takes the gate once it is released and spawns the Host itself', async () => {
    const { files, record } = heldGate()
    const clock = new FakeLauncherClock(TAKEN_AT + 1_000)
    const start = clock.now()
    const prober = new FakeHelloProber(clock)
    const spawner = new FakeHostSpawner()
    spawner.onLaunch = () => {
      prober.answer = () => helloOk('ready')
    }
    // The other UI gives up after 600 ms and releases its gate.
    const sleep = async (ms: number): Promise<void> => {
      await clock.sleep(ms)
      if (clock.now() - start >= 600) await files.removeIf(record)
    }
    const launcher = createHostLauncher({
      probe: prober.probe,
      gate: gateFor(files, new FakeIdentityProbe().alive(OWNER), clock),
      spawner: spawner.spawn,
      // AMENDED for ISSUE-031: the versioned copy (AMENDED for the cut-0 conformance fixes, was: the
      // source folder itself; the double now answers a versioned folder, ADR-002 D5).
      prepareCopy: new FakeCopyPreparer(
        '/opt/DwarfAI-Miners',
        '/home/j/.local/share/dwarfai/host/1.4.0'
      ).prepare,
      host: HOST,
      clock,
      sleep,
      log: new RecordingUiLog()
    })

    expect(await launcher.ensureHostRunning()).toBe('spawned')
    expect(spawner.requests).toHaveLength(1)
    expect(files.content).toBeNull()
  })

  it('[ADR-002, FM-008] a loser that finds the endpoint held but never ready gives up after the readiness budget', async () => {
    const { files } = heldGate()
    const clock = new FakeLauncherClock(TAKEN_AT + 1_000)
    const start = clock.now()
    const prober = new FakeHelloProber(clock)
    // Something answers on the endpoint from 500 ms on, but never with a ready hello.ok. (A guard turns a
    // never-ending wait into a visible wrong answer after 10 minutes of virtual time.)
    prober.answer = (now) => {
      if (now - start > 600_000) return helloOk('ready')
      return now - start >= 500 ? { kind: 'no-answer' } : UNREACHABLE
    }
    const launcher = createHostLauncher({
      probe: prober.probe,
      gate: gateFor(files, new FakeIdentityProbe().alive(OWNER), clock),
      spawner: new FakeHostSpawner().spawn,
      // AMENDED for ISSUE-031: the versioned copy (AMENDED for the cut-0 conformance fixes, was: the
      // source folder itself; the double now answers a versioned folder, ADR-002 D5).
      prepareCopy: new FakeCopyPreparer(
        '/opt/DwarfAI-Miners',
        '/home/j/.local/share/dwarfai/host/1.4.0'
      ).prepare,
      host: HOST,
      clock,
      sleep: clock.sleep,
      log: new RecordingUiLog()
    })

    expect(await launcher.ensureHostRunning()).toEqual({ unavailable: 'spawn-failed' })
    expect(clock.now() - start).toBe(500 + READINESS_BUDGET_MS)
  })

  it('[ADR-002, FM-009, FM-010] two UIs starting at once with no Host spawn exactly one Host and both attach to it', async () => {
    const files = new InMemoryGateFiles()
    const clock = new FakeLauncherClock(TAKEN_AT)
    const identities = new FakeIdentityProbe()
    const spawner = new FakeHostSpawner()
    let hostReadyAt = Number.POSITIVE_INFINITY
    spawner.onLaunch = () => {
      hostReadyAt = clock.now() + 300
    }
    const prober = new FakeHelloProber(clock, (now) =>
      now >= hostReadyAt ? helloOk('ready') : UNREACHABLE
    )
    const ui = (pid: number) => {
      const self = { pid, processStartTimeMs: pid * 10 }
      identities.alive(self)
      return createHostLauncher({
        probe: prober.probe,
        gate: new SpawnGate({
          files,
          probe: identities.probe,
          clock,
          self: () => Promise.resolve(self)
        }),
        spawner: spawner.spawn,
        // AMENDED for ISSUE-031: the versioned copy (AMENDED for the cut-0 conformance fixes, was: the
        // source folder itself; the double now answers a versioned folder, ADR-002 D5).
        prepareCopy: new FakeCopyPreparer(
          '/opt/DwarfAI-Miners',
          '/home/j/.local/share/dwarfai/host/1.4.0'
        ).prepare,
        host: HOST,
        clock,
        sleep: clock.sleep,
        log: new RecordingUiLog()
      })
    }

    const results = await Promise.all([ui(11).ensureHostRunning(), ui(12).ensureHostRunning()])
    expect(spawner.requests).toHaveLength(1)
    expect([...results].sort()).toEqual(['attached', 'spawned'])
    expect(files.content).toBeNull()
  })

  it('[ADR-002, FM-010] a gate whose content cannot be read as a record is stale and taken over', async () => {
    const files = new InMemoryGateFiles()
    files.content = 'not a gate record'
    const gate = gateFor(files, new FakeIdentityProbe(), new FakeLauncherClock(TAKEN_AT))
    expect(await gate.take()).toBe('taken')
    expect(files.content).toBe(JSON.stringify({ ...SELF, at: TAKEN_AT }))
  })
})
