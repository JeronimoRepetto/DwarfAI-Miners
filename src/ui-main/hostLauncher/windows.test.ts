import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FakeWinLaunch } from './fakes/FakeWinLaunch'
import type { HostSpawnRequest, LaunchOutcome } from './ports'
import {
  BREAKAWAY_CREATION_FLAGS,
  HOST_WATCH_MS,
  LAUNCH_REPORT_TIMEOUT_MS,
  createWindowsSpawner,
  environmentBlock,
  environmentList,
  quoteWindowsArg,
  windowsCommandLine,
  windowsPowerShell
} from './windows'

const REQUEST: HostSpawnRequest = {
  file: 'C:\\DwarfAI\\DwarfAI-Miners.exe',
  args: ['C:\\DwarfAI\\resources\\app.asar\\out\\host\\main.js'],
  env: { ELECTRON_RUN_AS_NODE: '1' },
  cwd: 'C:\\Users\\j\\AppData\\Roaming\\DwarfAI-Miners\\host'
}

/**
 * One spawn through the helper double; the timeout never fires on its own.
 * AMENDED (fix: launch timeout): breakaway runs in-process now, so the helper double answers it; by
 * default it refuses, which is the one case that still starts the PowerShell (WMI) step.
 * AMENDED (fix: FM-009 LAUNCHER_TIMEOUT): the WMI create is the helper's too, so the double answers
 * it (`wmiAnswer`) and no step child is driven any more.
 */
function launch(helper: FakeWinLaunch = refusingHelper()) {
  const timeouts: Array<() => void> = []
  const outcome = createWindowsSpawner({
    loadHelper: () => ({ ok: true, binding: helper.binding }),
    after: (_ms, run) => {
      timeouts.push(run)
      return () => {}
    }
  })(REQUEST)
  return { outcome, timeouts, helper }
}

/** The spawner's source, for the structural check that it starts no process. */
const WINDOWS_SOURCE = readFileSync(fileURLToPath(new URL('./windows.ts', import.meta.url)), 'utf8')
/** A value import of node:child_process, the only way the spawner could start a process. */
const NODE_PROCESS_IMPORT = /^import (?!type ).*from 'node:child_process'/m

/** A helper whose breakaway is refused (`code`), so WMI follows (D6 item 2). */
function refusingHelper(code = 'STILL_IN_JOB'): FakeWinLaunch {
  const helper = new FakeWinLaunch()
  helper.answer = () => ({ status: 'refused', code })
  return helper
}

describe('Windows launcher step (ADR-002 D6, SP-02)', () => {
  it('[ADR-002] arguments are quoted so CommandLineToArgvW reads them back unchanged', () => {
    expect(quoteWindowsArg('C:\\Program Files\\App\\app.exe')).toBe(
      '"C:\\Program Files\\App\\app.exe"'
    )
    expect(quoteWindowsArg('C:\\dir\\')).toBe('"C:\\dir\\\\"')
    expect(quoteWindowsArg('say "hi"')).toBe('"say \\"hi\\""')
    expect(quoteWindowsArg('a\\"b')).toBe('"a\\\\\\"b"')
    expect(quoteWindowsArg('')).toBe('""')
    expect(windowsCommandLine('C:\\a b\\x.exe', ['C:\\c\\main.js'])).toBe(
      '"C:\\a b\\x.exe" "C:\\c\\main.js"'
    )
  })

  it('[ADR-002] the environment block is NAME=value sorted ignoring case, without entries a block cannot hold', () => {
    expect(
      environmentList({
        path: 'C:\\Windows',
        ELECTRON_RUN_AS_NODE: '1',
        '=C:': 'C:\\',
        Bad: 'a\0b',
        DWARFAI_HOST_DATA_DIR: 'C:\\h'
      })
    ).toEqual(['DWARFAI_HOST_DATA_DIR=C:\\h', 'ELECTRON_RUN_AS_NODE=1', 'path=C:\\Windows'])
    // ADDED (fix: launch timeout): the block the in-process breakaway hands CreateProcessW.
    expect(environmentBlock({ B: '2', a: '1' })).toBe('a=1\0B=2\0\0')
    expect(environmentBlock({})).toBe('\0\0')
  })

  // AMENDED (fix: FM-009 LAUNCHER_TIMEOUT; was: "the step is Windows PowerShell by path and its
  // script carries constants only"): the launcher has no PowerShell step any more. The Host
  // identity query (processStart.ts) still runs Windows PowerShell by path, named here.
  it('[ADR-002, FM-114] Windows PowerShell is named by its path under SystemRoot, never looked up on PATH', () => {
    expect(windowsPowerShell({ SystemRoot: 'D:\\Win\\' })).toBe(
      'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    )
    expect(windowsPowerShell({})).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    )
  })

  // REMOVED (fix: FM-009 LAUNCHER_TIMEOUT): "[ADR-002] each line the step prints is read as its
  // fact, anything else is ignored". The PowerShell step and its printed lines are gone: the
  // helper's wmiCreate answers a typed result, read in the cases below and proven against the real
  // WMI in win-launch/nativeWinLaunch.os.test.ts (docs/test-removals.md).

  it('[ADR-002, FM-012] breakaway refused then WMI is launched; WMI failing too is in-job', async () => {
    // AMENDED (fix: launch timeout): the helper refuses breakaway (it used to be the step printing
    // `refused`), then the WMI step creates the Host, which the helper opens by its pid to watch.
    // AMENDED (fix: FM-009 LAUNCHER_TIMEOUT): the WMI create is the helper's (`wmiAnswer`).
    const wmi = launch()
    const launched = await wmi.outcome
    expect(launched.kind).toBe('launched')
    expect(launched.kind === 'launched' && launched.host.how).toBe('wmi')
    expect(wmi.helper.opened).toEqual([4242])
    expect(wmi.helper.watchedFor()).toBe(HOST_WATCH_MS)

    const helper = refusingHelper('CREATE_5')
    helper.wmiAnswer = () => Promise.resolve({ status: 'refused', code: 'WMI_0x80041003' })
    const refused = launch(helper)
    expect(await refused.outcome).toEqual({ kind: 'in-job', errCode: 'WMI_0x80041003' })
  })

  it('[ADR-002, FM-008] a step that fails, ends without a launch, cannot start or never reports is a failed launch', async () => {
    // AMENDED (fix: launch timeout): a create that fails is the helper's answer now; the WMI
    // step's own failures below stay as they were.
    // AMENDED (fix: FM-009 LAUNCHER_TIMEOUT): the WMI create is the helper's, so its failures are
    // a call that throws or rejects, and one that never settles within LAUNCH_REPORT_TIMEOUT_MS.
    const helper = new FakeWinLaunch()
    helper.answer = () => ({ status: 'failed', code: 'CREATE_2' })
    const failed = launch(helper)
    expect(await failed.outcome).toEqual({ kind: 'failed', errCode: 'CREATE_2' })
    expect(failed.helper.wmiCreates).toEqual([])

    const unavailable = await createWindowsSpawner({
      loadHelper: () => ({ ok: false, errCode: 'LAUNCHER_HELPER_MISSING' })
    })(REQUEST)
    expect(unavailable).toEqual({ kind: 'failed', errCode: 'LAUNCHER_HELPER_MISSING' })

    const throwing = refusingHelper()
    throwing.wmiAnswer = () => {
      throw new TypeError('wmiCreate(commandLine, cwd: string, environment: string[])')
    }
    expect(await launch(throwing).outcome).toEqual({ kind: 'failed', errCode: 'WMI_ERROR' })

    const rejecting = refusingHelper()
    rejecting.wmiAnswer = () => Promise.reject(Object.assign(new Error('x'), { code: 'WMI_NOMEM' }))
    expect(await launch(rejecting).outcome).toEqual({ kind: 'failed', errCode: 'WMI_NOMEM' })

    const silent = refusingHelper()
    silent.wmiAnswer = () => new Promise(() => {})
    const hung = launch(silent)
    await Promise.resolve()
    hung.timeouts.forEach((run) => run())
    expect(await hung.outcome).toEqual({ kind: 'failed', errCode: 'LAUNCHER_TIMEOUT' })
    expect(LAUNCH_REPORT_TIMEOUT_MS).toBe(10_000)
  })

  // AMENDED (fix: launch timeout; was: "… the step reports … release ends only the step"): the
  // in-process helper watches the Host and reports its exit; release ends the watch and closes the
  // handle, never the Host. A Host still running when the watch ends, or one WMI created that
  // cannot be opened, can no longer be watched (null).
  it('[S12.03, FM-011] the Host exit the helper reports reaches the launcher, and release ends only the watch', async () => {
    const run = launch(new FakeWinLaunch())
    const outcome: LaunchOutcome = await run.outcome
    if (outcome.kind !== 'launched') throw new Error(`expected a launch, got ${outcome.kind}`)
    expect(run.helper.watchedFor()).toBe(HOST_WATCH_MS)
    run.helper.exit(65)
    expect(await outcome.host.exited).toBe(65)
    expect(run.helper.released).toEqual([run.helper.process])

    const watched = launch()
    const second = await watched.outcome
    if (second.kind !== 'launched') throw new Error(`expected a launch, got ${second.kind}`)
    second.host.release()
    expect(await second.host.exited).toBeNull()
    expect(watched.helper.released).toEqual([watched.helper.process])

    const outlived = launch(new FakeWinLaunch())
    const third = await outlived.outcome
    if (third.kind !== 'launched') throw new Error(`expected a launch, got ${third.kind}`)
    outlived.helper.exit(-1)
    expect(await third.host.exited).toBeNull()

    const gone = refusingHelper()
    gone.canOpen = false
    const unopened = await launch(gone).outcome
    if (unopened.kind !== 'launched') throw new Error(`expected a launch, got ${unopened.kind}`)
    expect(await unopened.host.exited).toBeNull()
  })

  // AMENDED (fix: FM-009 LAUNCHER_TIMEOUT; was: "the step runs without PSModulePath and gets the
  // request as JSON on stdin"): no step process runs, so there is no PSModulePath to drop and no
  // stdin; the helper's WMI create gets the command line, the working folder and the environment
  // entries as arguments. WMI reads the command line, not the executable, so `file` is not sent.
  it('[ADR-002] the WMI create gets the command line, the working folder and the whole environment as arguments', async () => {
    const helper = refusingHelper()
    await createWindowsSpawner({
      loadHelper: () => ({ ok: true, binding: helper.binding })
    })({ ...REQUEST, env: { TEMP: 'C:\\t', ELECTRON_RUN_AS_NODE: '1', '=C:': 'C:\\' } })
    expect(helper.wmiCreates).toEqual([
      {
        commandLine:
          '"C:\\DwarfAI\\DwarfAI-Miners.exe" "C:\\DwarfAI\\resources\\app.asar\\out\\host\\main.js"',
        cwd: REQUEST.cwd,
        environment: ['ELECTRON_RUN_AS_NODE=1', 'TEMP=C:\\t']
      }
    ])
  })

  // ADDED (fix: Windows Host launch timeout, CI windows-latest LAUNCHER_TIMEOUT): the breakaway
  // step used to be a PowerShell process compiling C# with Add-Type on every spawn, which a cold or
  // busy machine could not finish within the report timeout, so the Host failed to start.
  it('[ADR-002, FM-008] a slow PowerShell cannot fail the spawn: breakaway runs in-process and starts no launcher step', async () => {
    const helper = new FakeWinLaunch()
    const timeouts: Array<() => void> = []
    // AMENDED (fix: FM-009 LAUNCHER_TIMEOUT): the spawner takes no process starter any more (it
    // starts none), so "no PowerShell step" is checked on its source below.
    const outcome = createWindowsSpawner({
      loadHelper: () => ({ ok: true, binding: helper.binding }),
      after: (_ms, run) => {
        timeouts.push(run)
        return () => {}
      }
    })(REQUEST)
    // Whatever step exists never reports, and its report timeout fires.
    await Promise.resolve()
    await Promise.resolve()
    timeouts.forEach((run) => run())

    const launched = await outcome
    expect(launched.kind).toBe('launched')
    expect(launched.kind === 'launched' && launched.host.how).toBe('breakaway')
    expect(WINDOWS_SOURCE, 'no PowerShell step is started').not.toMatch(NODE_PROCESS_IMPORT)
    expect(helper.wmiCreates).toEqual([])
    expect(helper.breakaways).toEqual([
      {
        file: REQUEST.file,
        commandLine:
          '"C:\\DwarfAI\\DwarfAI-Miners.exe" "C:\\DwarfAI\\resources\\app.asar\\out\\host\\main.js"',
        cwd: REQUEST.cwd,
        environment: 'ELECTRON_RUN_AS_NODE=1\0\0',
        flags: BREAKAWAY_CREATION_FLAGS
      }
    ])
  })

  // ADDED (fix: FM-009 LAUNCHER_TIMEOUT on windows-latest, CI run 36889737566): where the UI's job
  // forbids breakaway (the CI runner's does, so every Windows OS-lane launch takes this path), the
  // WMI step was still a Windows PowerShell process, whose cold start on a busy machine outran its
  // report timeout and failed the spawn. SP-02 measured the WMI create itself at 46–67 ms in
  // process; the helper now makes it in the UI process, so no process stands before the Host.
  it('[ADR-002, FM-008] a slow PowerShell cannot fail the spawn when breakaway is refused either: WMI runs in-process and starts no launcher step', async () => {
    const helper = refusingHelper('CREATE_5')
    const launched = await createWindowsSpawner({
      loadHelper: () => ({ ok: true, binding: helper.binding })
    })(REQUEST)

    expect(WINDOWS_SOURCE, 'no PowerShell step is started').not.toMatch(NODE_PROCESS_IMPORT)
    expect(launched.kind === 'launched' && launched.host.how).toBe('wmi')
    expect(helper.wmiCreates).toEqual([
      {
        commandLine:
          '"C:\\DwarfAI\\DwarfAI-Miners.exe" "C:\\DwarfAI\\resources\\app.asar\\out\\host\\main.js"',
        cwd: REQUEST.cwd,
        environment: ['ELECTRON_RUN_AS_NODE=1']
      }
    ])
    expect(helper.opened).toEqual([4242])
    expect(helper.watchedFor()).toBe(HOST_WATCH_MS)
  })
})
