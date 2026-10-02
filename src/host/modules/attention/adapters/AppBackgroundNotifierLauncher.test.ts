// layer: L2
// L2 (17 §1.2): `AppBackgroundNotifierLauncher` (16 §4.11 adapter of `NotifierLauncher`) over
// FakeProcessControl, FakeClock and FakeScheduler: it runs the NotifierLauncher contract the double
// runs, and starts the app's own executable `--background` through `ProcessControl.spawn` (R17:
// never a shell, which the ProcessControl adapter fixes), in its own process group, with no stdio
// tie to the Host, and with an environment the Host's own markers were taken out of. The OS lane
// (AppBackgroundNotifierLauncher.os.test.ts) starts a real stub. ADR-018 item 5; ADR-014; R17.
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { FakeProcessControl } from '../../../kernel/fakes/FakeProcessControl'
import { FakeScheduler } from '../../../kernel/fakes/FakeScheduler'
import { runNotifierLauncherContract } from '../testing/notifierLauncher.contract'
import {
  AppBackgroundNotifierLauncher,
  NOTIFIER_ATTACH_BOUND_MS,
  type AppBackgroundNotifierLauncherDeps
} from './AppBackgroundNotifierLauncher'

const EXEC = 'fake-install/DwarfAI-Miners'
const FIRST_PID = 20_000

/** The Host's environment as the UI's launcher left it (spawnHost.ts `hostEnvironment`). */
const HOST_ENV = {
  PATH: 'fake-bin',
  HOME: 'fake-home/j',
  ELECTRON_RUN_AS_NODE: '1',
  DWARFAI_HOST_DATA_DIR: 'fake-home/j/.config/DwarfAI-Miners/host',
  dwarfai_delegation_token: 'never-forwarded',
  DWARFAI_LOG: 'debug',
  UNSET: undefined
}

function world(overrides: Partial<AppBackgroundNotifierLauncherDeps> = {}) {
  const clock = new FakeClock(1_790_000_000_000)
  const scheduler = new FakeScheduler(clock)
  const processes = new FakeProcessControl({ clock, firstPid: FIRST_PID })
  const listeners = new Set<() => void>()
  const launcher = new AppBackgroundNotifierLauncher({
    processes,
    paths: { execPath: EXEC },
    env: HOST_ENV,
    scheduler,
    onNotifierAttach: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    ...overrides
  })
  const notifierAttaches = () => {
    for (const listener of [...listeners]) listener()
  }
  return { clock, processes, launcher, listeners, notifierAttaches }
}

/** Lets the spawn's promises reach the launcher. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

describe('AppBackgroundNotifierLauncher', () => {
  runNotifierLauncherContract(() => {
    const { processes, launcher, notifierAttaches } = world()
    return {
      launcher,
      notifierAttaches,
      startFails: () => processes.exit(FIRST_PID, { code: 1, signal: null }),
      dispose: () => undefined
    }
  })

  it('[ADR-018] starts the app executable with --background, in its own group, with no stdio and without the Host markers', async () => {
    const { processes, launcher, notifierAttaches } = world()
    const outcome = launcher.ensureNotifier()
    notifierAttaches()
    expect(await outcome).toBe('attached')

    expect(processes.spawns).toStrictEqual([
      {
        executable: EXEC,
        args: ['--background'],
        cwd: 'fake-install',
        processGroup: 'own',
        stdio: 'ignore',
        // ELECTRON_RUN_AS_NODE would start the app as plain Node with no tray; the Host's data
        // folder and any DwarfAI token are the Host's own. The log level is inherited (19 §6).
        env: { PATH: 'fake-bin', HOME: 'fake-home/j', DWARFAI_LOG: 'debug' }
      }
    ])
    // Nothing is ended: the started app and every session keep running.
    expect(processes.signals).toStrictEqual([])
  })

  it('[ADR-018] a development build passes the app folder before --background', async () => {
    const { processes, launcher, notifierAttaches } = world({ appArgs: ['fake-repo'] })
    const outcome = launcher.ensureNotifier()
    notifierAttaches()
    await outcome
    expect(processes.spawns.map((spawn) => spawn.args)).toStrictEqual([
      ['fake-repo', '--background']
    ])
  })

  it('[ADR-018, S12.C04] a start whose notifier never attaches settles spawn-failed after the attach bound, and leaves the process alone', async () => {
    const { clock, processes, launcher, listeners } = world()
    let outcome: string | null = null
    void launcher.ensureNotifier().then((value) => (outcome = value))

    clock.advance(NOTIFIER_ATTACH_BOUND_MS - 1)
    await flush()
    expect(outcome).toBeNull()
    clock.advance(1)
    await flush()
    expect(outcome).toBe('spawn-failed')
    expect(listeners.size).toBe(0)
    expect(processes.signals).toStrictEqual([])
  })

  it('[ADR-018, S12.C04] a spawn the OS refuses settles spawn-failed', async () => {
    const { processes, launcher } = world()
    processes.spawn = () => {
      throw new Error('ENOENT')
    }
    expect(await launcher.ensureNotifier()).toBe('spawn-failed')
  })
})
