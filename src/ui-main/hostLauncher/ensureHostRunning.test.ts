import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RecordingSpawnProcess } from './fakes/FakeChildProcess'
import { FakeCopyPreparer } from './fakes/FakeCopyPreparer'
import { FakeHostSpawner } from './fakes/FakeHostSpawner'
import { FakeLauncherClock } from './fakes/FakeLauncherClock'
import { FakeWinLaunch } from './fakes/FakeWinLaunch'
import { RecordingUiLog } from './fakes/RecordingUiLog'
import { FakeHelloProber, UNREACHABLE, helloOk } from './fakes/FakeHelloProber'
import { createHostLauncher, type HostLauncherDeps } from './index'
import { createPosixSpawner } from './posix'
import { READINESS_BUDGET_MS, MIGRATING_EXTENSION_MS, READINESS_POLL_MS } from './readiness'
import { buildHostSpawn } from './spawnHost'
import {
  CREATE_BREAKAWAY_FROM_JOB,
  CREATE_NEW_PROCESS_GROUP,
  CREATE_NO_WINDOW,
  createWindowsSpawner
} from './windows'

/** The creation flag ADR-002 D6 item 3 forbids (console flash for every console descendant, L-12). */
const DETACHED_PROCESS = 0x0000_0008

const HOST_DATA_DIR = '/home/j/.config/DwarfAI-Miners/host'
/** The versioned copy the double prepares (ADR-002 D5, Linux: `$XDG_DATA_HOME/dwarfai/host/<version>`). */
const COPY_DIR = '/home/j/.local/share/dwarfai/host/1.4.0'
const SECRET = 'f00dfeedf00dfeedf00dfeedf00dfeedf00dfeedf00dfeedf00dfeedf00dfeed'

/** A gate nobody else holds, recording what the launcher does with it. */
class FreeGate {
  taken = 0
  released = 0
  take(): Promise<'taken' | 'held'> {
    this.taken += 1
    return Promise.resolve('taken')
  }
  release(): Promise<void> {
    this.released += 1
    return Promise.resolve()
  }
}

function harness(uiEnv: Record<string, string | undefined> = { PATH: '/usr/bin' }) {
  const clock = new FakeLauncherClock(1_000)
  const prober = new FakeHelloProber(clock)
  const spawner = new FakeHostSpawner()
  const gate = new FreeGate()
  const log = new RecordingUiLog()
  // AMENDED for ISSUE-031: the launcher prepares the versioned copy before it spawns.
  // AMENDED for the cut-0 conformance fixes (was: the source folder itself): the double now meets
  // the HostCopyPreparer contract, so the copy is a versioned folder that is not the app directory
  // (ADR-002 D5), and the spawn paths below are the relocated ones.
  const copy = new FakeCopyPreparer('/opt/DwarfAI-Miners', COPY_DIR)
  const deps: HostLauncherDeps = {
    probe: prober.probe,
    gate,
    spawner: spawner.spawn,
    prepareCopy: copy.prepare,
    host: {
      execPath: '/opt/DwarfAI-Miners/dwarfai-miners',
      hostEntry: '/opt/DwarfAI-Miners/resources/app.asar/out/host/main.js',
      hostDataDir: HOST_DATA_DIR,
      uiEnv
    },
    clock,
    sleep: clock.sleep,
    log
  }
  return { clock, prober, spawner, gate, log, copy, launcher: createHostLauncher(deps) }
}

describe('ensureHostRunning (ADR-002 D4)', () => {
  it('[ADR-002] a Host that already answers hello is attached without spawning', async () => {
    const h = harness()
    h.prober.answer = () => helloOk('ready')

    expect(await h.launcher.ensureHostRunning()).toBe('attached')
    expect(h.spawner.requests).toEqual([])
    expect(h.gate.taken).toBe(0)
    expect(h.prober.attempts).toEqual([1_000])
  })

  it('[ADR-002, FM-008] readiness waits for hello, not for a timer or a pid, and gives up after 15 s as spawn-failed', async () => {
    const h = harness()
    // The Host is launched (the spawner reports it started) but never answers: the launch alone is not readiness.
    expect(await h.launcher.ensureHostRunning()).toEqual({ unavailable: 'spawn-failed' })
    expect(h.spawner.requests).toHaveLength(1)

    // Probed every 50 ms from the launch until exactly 15 s had passed, then given up.
    const launchedAt = h.prober.attempts[1] ?? Number.NaN
    const polls = h.prober.attempts.slice(1)
    expect(polls.at(-1)! - launchedAt).toBe(READINESS_BUDGET_MS)
    expect(polls).toHaveLength(READINESS_BUDGET_MS / READINESS_POLL_MS + 1)
    expect(polls.every((at, i) => i === 0 || at - polls[i - 1]! === READINESS_POLL_MS)).toBe(true)
    expect(h.gate.released).toBe(1)
    expect(h.spawner.released).toBe(1)
    expect(h.log.byEvent('host.spawn')).toEqual([
      expect.objectContaining({
        level: 'error',
        subsystem: 'host-launcher',
        outcome: 'failed',
        causeClass: 'spawn-failed',
        errCode: 'READINESS_TIMEOUT'
      })
    ])

    // A Host that answers `starting` the whole time keeps the UI waiting inside the same 15 s, then fails too.
    const starting = harness()
    starting.spawner.onLaunch = () => {
      starting.prober.answer = () => helloOk('starting')
    }
    expect(await starting.launcher.ensureHostRunning()).toEqual({ unavailable: 'spawn-failed' })
    expect(starting.clock.now() - (starting.prober.attempts[1] ?? Number.NaN)).toBe(
      READINESS_BUDGET_MS
    )

    // A Host that answers `ready` within the budget is spawned.
    const ready = harness()
    ready.spawner.onLaunch = () => {
      const at = ready.clock.now()
      ready.prober.answer = (now) => (now - at >= 400 ? helloOk('ready') : UNREACHABLE)
    }
    expect(await ready.launcher.ensureHostRunning()).toBe('spawned')
    expect(ready.log.byEvent('host.spawn')).toEqual([
      expect.objectContaining({ level: 'info', outcome: 'ok', causeClass: 'detached' })
    ])
  })

  it('[ADR-002, FM-012] a launched Host that reports itself in a job is logged degraded with how it was launched', async () => {
    const h = harness()
    h.spawner.onLaunch = () => {
      h.prober.answer = () => ({ kind: 'hello-ok', state: 'ready', jobStatus: 'in-job' })
    }
    expect(await h.launcher.ensureHostRunning()).toBe('spawned')
    expect(h.log.byEvent('host.spawn')).toEqual([
      expect.objectContaining({
        level: 'warn',
        outcome: 'degraded',
        causeClass: 'in-job',
        errCode: 'LAUNCHED_DETACHED'
      })
    ])
  })

  it('[ADR-002] a Host reporting migrating extends the wait by up to 30 s', async () => {
    // Migrating the whole time: the wait ends at 15 s + 30 s.
    const long = harness()
    long.spawner.onLaunch = () => {
      long.prober.answer = () => helloOk('migrating')
    }
    expect(await long.launcher.ensureHostRunning()).toEqual({ unavailable: 'spawn-failed' })
    expect(long.clock.now() - (long.prober.attempts[1] ?? Number.NaN)).toBe(
      READINESS_BUDGET_MS + MIGRATING_EXTENSION_MS
    )

    // Migrating past 15 s, ready at 40 s: spawned.
    const slow = harness()
    slow.spawner.onLaunch = () => {
      const at = slow.clock.now()
      slow.prober.answer = (now) => helloOk(now - at >= 40_000 ? 'ready' : 'migrating')
    }
    expect(await slow.launcher.ensureHostRunning()).toBe('spawned')

    // The extension holds only while the Host reports migrating: migrating at 5 s, starting after → 15 s.
    const brief = harness()
    brief.spawner.onLaunch = () => {
      const at = brief.clock.now()
      brief.prober.answer = (now) =>
        helloOk(now - at >= 5_000 && now - at < 6_000 ? 'migrating' : 'starting')
    }
    expect(await brief.launcher.ensureHostRunning()).toEqual({ unavailable: 'spawn-failed' })
    expect(brief.clock.now() - (brief.prober.attempts[1] ?? Number.NaN)).toBe(READINESS_BUDGET_MS)
  })

  it('[S12.03, FM-011] a Host exit ELEVATED_REFUSED maps to unavailable elevated-refused', async () => {
    const h = harness()
    h.spawner.onLaunch = () => {
      const at = h.clock.now()
      h.prober.answer = (now) => {
        if (now - at === 200) h.spawner.exit(65)
        return UNREACHABLE
      }
    }
    expect(await h.launcher.ensureHostRunning()).toEqual({ unavailable: 'elevated-refused' })
    // Mapped as soon as the exit is seen, not after the readiness budget.
    expect(h.clock.now() - (h.prober.attempts[1] ?? Number.NaN)).toBeLessThan(1_000)
    expect(h.log.byEvent('host.spawn')).toEqual([
      expect.objectContaining({
        level: 'error',
        outcome: 'failed',
        causeClass: 'elevated-refused',
        errCode: 'ELEVATED_REFUSED'
      })
    ])
  })

  it('[S12.02, FM-009] a spawned Host that exits ALREADY_RUNNING leaves the UI attached to the running Host', async () => {
    const h = harness()
    h.spawner.onLaunch = () => {
      const at = h.clock.now()
      h.prober.answer = (now) => {
        if (now - at === 100) h.spawner.exit(64)
        return now - at >= 300 ? helloOk('ready') : UNREACHABLE
      }
    }
    expect(await h.launcher.ensureHostRunning()).toBe('attached')
  })

  it('[ADR-002, FM-008] a Host that exits with any other code before it is ready is spawn-failed at once', async () => {
    const h = harness()
    h.spawner.onLaunch = () => {
      const at = h.clock.now()
      h.prober.answer = (now) => {
        if (now - at === 100) h.spawner.exit(66)
        return UNREACHABLE
      }
    }
    expect(await h.launcher.ensureHostRunning()).toEqual({ unavailable: 'spawn-failed' })
    expect(h.clock.now() - (h.prober.attempts[1] ?? Number.NaN)).toBeLessThan(1_000)
    expect(h.log.byEvent('host.spawn')).toEqual([
      expect.objectContaining({ causeClass: 'spawn-failed', errCode: 'HOST_EXIT_66' })
    ])
  })

  it('[ADR-002, FM-012] a Host that cannot be started outside the UI job is unavailable in-job, and a refused launch is spawn-failed', async () => {
    const inJob = harness()
    inJob.spawner.outcome = { kind: 'in-job', errCode: 'WMI_9' }
    expect(await inJob.launcher.ensureHostRunning()).toEqual({ unavailable: 'in-job' })
    expect(inJob.gate.released).toBe(1)

    const failed = harness()
    failed.spawner.outcome = { kind: 'failed', errCode: 'ENOENT' }
    expect(await failed.launcher.ensureHostRunning()).toEqual({ unavailable: 'spawn-failed' })
    expect(failed.log.byEvent('host.spawn')).toEqual([
      expect.objectContaining({ causeClass: 'spawn-failed', errCode: 'ENOENT' })
    ])
  })

  it('[ADR-002, FM-008] a spawn gate that cannot be read or written is spawn-failed, never a thrown error', async () => {
    const h = harness()
    h.gate.take = () =>
      Promise.reject(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
    await expect(h.launcher.ensureHostRunning()).resolves.toEqual({ unavailable: 'spawn-failed' })
    expect(h.spawner.requests).toEqual([])
    expect(h.log.byEvent('host.spawn')).toEqual([
      expect.objectContaining({ causeClass: 'spawn-failed', errCode: 'EACCES' })
    ])
  })

  it('[ADR-002] a Host that holds the endpoint but is still starting is waited for, not spawned again', async () => {
    const h = harness()
    h.prober.answer = (now) => helloOk(now >= 1_500 ? 'ready' : 'starting')
    expect(await h.launcher.ensureHostRunning()).toBe('attached')
    expect(h.spawner.requests).toEqual([])
    expect(h.gate.taken).toBe(0)
  })

  it('[ADR-002] the spawn env holds ELECTRON_RUN_AS_NODE and DWARFAI_HOST_DATA_DIR and no token or secret', async () => {
    const h = harness({
      PATH: '/usr/bin',
      HOME: '/home/j',
      ELECTRON_RUN_AS_NODE: '0',
      DWARFAI_LOG: 'debug',
      DWARFAI_DELEGATION_TOKEN: SECRET,
      DWARFAI_HOST_UI_TOKEN: SECRET,
      UNSET: undefined
    })
    h.spawner.onLaunch = () => {
      h.prober.answer = () => helloOk('ready')
    }
    expect(await h.launcher.ensureHostRunning()).toBe('spawned')

    const [request] = h.spawner.requests
    // AMENDED for the cut-0 conformance fixes (was: the install folder's paths): the Host is started
    // from its versioned copy, never the install folder (ADR-002 D5).
    expect(request?.file).toBe(`${COPY_DIR}/dwarfai-miners`)
    expect(request?.args).toEqual([`${COPY_DIR}/resources/app.asar/out/host/main.js`])
    expect(request?.env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/j',
      ELECTRON_RUN_AS_NODE: '1',
      DWARFAI_HOST_DATA_DIR: HOST_DATA_DIR,
      DWARFAI_LOG: 'debug'
    })
    const everything = JSON.stringify(request)
    expect(everything).not.toContain(SECRET)

    // DWARFAI_LOG is passed only when the UI has it.
    const quiet = harness({ PATH: '/usr/bin' })
    quiet.spawner.onLaunch = () => {
      quiet.prober.answer = () => helloOk('ready')
    }
    await quiet.launcher.ensureHostRunning()
    expect(quiet.spawner.requests[0]?.env).toEqual({
      PATH: '/usr/bin',
      ELECTRON_RUN_AS_NODE: '1',
      DWARFAI_HOST_DATA_DIR: HOST_DATA_DIR
    })
  })

  it('[FM-114] the spawn never uses a shell and never sets DETACHED_PROCESS', async () => {
    const request = buildHostSpawn({
      execPath: 'C:\\Program Files\\DwarfAI-Miners\\DwarfAI-Miners.exe',
      hostEntry: 'C:\\Program Files\\DwarfAI-Miners\\resources\\app.asar\\out\\host\\main.js',
      hostDataDir: 'C:\\Users\\j\\AppData\\Roaming\\DwarfAI-Miners\\host',
      uiEnv: { SystemRoot: 'C:\\Windows', Path: 'C:\\Windows\\System32' }
    })

    // AMENDED (fix: Windows launch timeout; was: one PowerShell launcher step whose script carried
    // the breakaway flags): breakaway runs in-process through the launch helper with the D6 flags,
    // never Node's detached spawn (libuv adds DETACHED_PROCESS for it), and starts no process of its
    // own. Only a refused breakaway starts the one step (Windows PowerShell by path, never a shell,
    // hidden), and its WMI create hides the window.
    // AMENDED (fix: FM-009 LAUNCHER_TIMEOUT): a refused breakaway no longer starts a step either:
    // the helper's WMI create runs in this process (its hidden window, ShowWindow = 0, is set in
    // win_launch.c and proven in the Windows OS lane, detach.os.test.ts FM-114).
    const breakaway = new FakeWinLaunch()
    const windows = await createWindowsSpawner({
      loadHelper: () => ({ ok: true, binding: breakaway.binding })
    })(request)
    expect(windows.kind).toBe('launched')
    expect(breakaway.wmiCreates).toEqual([])
    const flags = breakaway.breakaways[0]?.flags ?? 0
    const required = CREATE_BREAKAWAY_FROM_JOB | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
    expect(flags & required).toBe(required)
    expect(flags & DETACHED_PROCESS).toBe(0)

    const refused = new FakeWinLaunch()
    refused.answer = () => ({ status: 'refused', code: 'STILL_IN_JOB' })
    const viaWmi = await createWindowsSpawner({
      loadHelper: () => ({ ok: true, binding: refused.binding })
    })(request)
    expect(viaWmi.kind === 'launched' && viaWmi.host.how).toBe('wmi')
    expect(refused.wmiCreates).toHaveLength(1)
    expect(refused.breakaways).toHaveLength(1)

    // POSIX: a new session (Node's detached = setsid), never a shell, unref'd.
    // AMENDED (cut-0 conformance, 19 §7 and 09 §1; was: "stdio to a file", stdout and stderr in
    // run/host-stdio.log): the Host's stdio is not captured, as on Windows. Its own records go to
    // its log segments through the logger, uncaught errors included (19 §9.1), and raw runtime
    // output never lands in a file 09 §1 does not list.
    const root = mkdtempSync(join(tmpdir(), 'dwarfai-030-posix-'))
    try {
      const onPosix = new RecordingSpawnProcess()
      onPosix.onSpawn = (child) => child.emit('spawn')
      const posix = await createPosixSpawner({
        spawnProcess: onPosix.spawn
      })({ ...request, file: '/opt/DwarfAI-Miners/dwarfai-miners', cwd: root })
      expect(posix.kind).toBe('launched')
      const [call] = onPosix.calls
      expect(call?.options).toMatchObject({ shell: false, windowsHide: true, detached: true })
      expect(call?.options.stdio).toEqual(['ignore', 'ignore', 'ignore'])
      expect(existsSync(join(root, 'run', 'host-stdio.log'))).toBe(false)
      expect(call?.child.unrefs).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // AMENDED (fix: FM-009 LAUNCHER_TIMEOUT; was: "… reaches the launcher step on stdin, never in its
  // argv"): no launcher step process exists any more.
  it('[ADR-002] on Windows the Host request reaches the launch helper as call arguments, never a process argv', async () => {
    const request = buildHostSpawn({
      execPath: 'C:\\DwarfAI\\DwarfAI-Miners.exe',
      hostEntry: 'C:\\DwarfAI\\resources\\app.asar\\out\\host\\main.js',
      hostDataDir: 'C:\\Users\\j\\AppData\\Roaming\\DwarfAI-Miners\\host',
      uiEnv: { PROVIDER_API_KEY: SECRET }
    })
    // AMENDED (fix: Windows launch timeout): the request reaches the in-process breakaway as
    // arguments of a function call, and, when breakaway is refused, the WMI step on its stdin.
    // AMENDED (fix: FM-009 LAUNCHER_TIMEOUT): the WMI create is in-process too, so no step process
    // exists whose argv or stdin could carry the request: it reaches the WMI create as arguments,
    // and the command line it gets holds no environment value.
    const helper = new FakeWinLaunch()
    helper.answer = () => ({ status: 'refused', code: 'CREATE_5' })
    await createWindowsSpawner({
      loadHelper: () => ({ ok: true, binding: helper.binding })
    })(request)
    expect(helper.breakaways[0]?.environment).toContain(`PROVIDER_API_KEY=${SECRET}`)
    const [sent] = helper.wmiCreates

    expect(sent?.commandLine).not.toContain(SECRET)
    expect(sent?.commandLine).not.toContain('DWARFAI_HOST_DATA_DIR')
    expect(sent?.environment).toContain(`PROVIDER_API_KEY=${SECRET}`)
    expect(sent?.environment).toContain('ELECTRON_RUN_AS_NODE=1')
    expect(sent?.commandLine).toBe(
      '"C:\\DwarfAI\\DwarfAI-Miners.exe" "C:\\DwarfAI\\resources\\app.asar\\out\\host\\main.js"'
    )
  })
})

// ADDED for ISSUE-031: the Host starts from the versioned copy (ADR-002 D5; ADR-027 item 2; UC-002:
// the copy is ensured with the spawn gate held, right before the spawn).
describe('ensureHostRunning starts the Host from the versioned copy (ADR-002 D5)', () => {
  it('[ADR-002, SP-03] the Host is spawned with the executable and the entry inside host/<version>/, never from the install folder', async () => {
    const h = harness()
    h.copy.outcome = {
      ok: true,
      sourceDir: '/opt/DwarfAI-Miners',
      contentDir: '/home/j/.local/share/dwarfai/host/1.4.0'
    }
    h.spawner.onLaunch = () => {
      h.prober.answer = () => helloOk('ready')
    }

    expect(await h.launcher.ensureHostRunning()).toBe('spawned')

    expect(h.copy.prepared).toBe(1)
    expect(h.spawner.requests).toMatchObject([
      {
        file: '/home/j/.local/share/dwarfai/host/1.4.0/dwarfai-miners',
        args: ['/home/j/.local/share/dwarfai/host/1.4.0/resources/app.asar/out/host/main.js']
      }
    ])
  })

  it('[ADR-027, FM-129] when the copy cannot be made no Host is spawned: spawn-failed with the copy code, and the gate is released', async () => {
    const h = harness()
    h.copy.outcome = { ok: false, errCode: 'COPY_ENOSPC' }

    expect(await h.launcher.ensureHostRunning()).toEqual({ unavailable: 'spawn-failed' })

    expect(h.spawner.requests).toEqual([])
    expect(h.gate.released).toBe(1)
    expect(h.log.byEvent('host.spawn')).toEqual([
      expect.objectContaining({
        level: 'error',
        causeClass: 'spawn-failed',
        errCode: 'COPY_ENOSPC'
      })
    ])
  })

  it('[ADR-027] the copy is prepared only when this UI is about to spawn, never when a Host answers', async () => {
    const h = harness()
    h.prober.answer = () => helloOk('ready')

    expect(await h.launcher.ensureHostRunning()).toBe('attached')
    expect(h.copy.prepared).toBe(0)
  })
})
