import { describe, expect, it } from 'vitest'
import { RecordingSpawnProcess, type FakeChildProcess } from './fakes/FakeChildProcess'
import { FakeWinLaunch } from './fakes/FakeWinLaunch'
import type { HostSpawnRequest, LaunchOutcome } from './ports'
import {
  BREAKAWAY_CREATION_FLAGS,
  HOST_WATCH_MS,
  createWindowsSpawner,
  environmentBlock,
  environmentList,
  launcherScript,
  parseLauncherLine,
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
 * One spawn whose WMI step's child the test drives; the timeout never fires on its own.
 * AMENDED (fix: launch timeout): breakaway runs in-process now, so the helper double answers it; by
 * default it refuses, which is the one case that still starts the PowerShell (WMI) step.
 */
function launch(
  drive: (child: FakeChildProcess) => void,
  helper: FakeWinLaunch = refusingHelper()
) {
  const recorder = new RecordingSpawnProcess()
  const timeouts: Array<() => void> = []
  recorder.onSpawn = drive
  const outcome = createWindowsSpawner({
    loadHelper: () => ({ ok: true, binding: helper.binding }),
    spawnProcess: recorder.spawn,
    env: { SystemRoot: 'D:\\Win' },
    after: (_ms, run) => {
      timeouts.push(run)
      return () => {}
    }
  })(REQUEST)
  return { recorder, outcome, timeouts, helper }
}

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

  it('[ADR-002, FM-114] the step is Windows PowerShell by path and its script carries constants only', () => {
    expect(windowsPowerShell({ SystemRoot: 'D:\\Win\\' })).toBe(
      'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    )
    expect(windowsPowerShell({})).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    )
    const script = launcherScript()
    expect(script).toContain('[Console]::In.ReadToEnd()')
    // AMENDED (fix: launch timeout; was: the script held the breakaway code, `IsProcessInJob`):
    // the script is the WMI step alone and compiles nothing.
    expect(script).not.toContain('IsProcessInJob')
    expect(script).not.toContain('Add-Type')
    expect(script).toContain('Win32_Process -MethodName Create')
    expect(script).toContain('CurrentDirectory = $request.cwd')
    expect(script).toContain('EnvironmentVariables = [string[]]$request.env')
  })

  it('[ADR-002] each line the step prints is read as its fact, anything else is ignored', () => {
    // AMENDED (fix: launch timeout): the step is the WMI step only. It prints the pid of the Host
    // it created (the helper opens it to watch its exit); breakaway and exit lines are the
    // in-process helper's now, so the step's `launched breakaway`, `refused` and `exit` lines
    // are no longer facts.
    expect(parseLauncherLine('launched wmi 17\r')).toEqual({ kind: 'launched', pid: 17 })
    expect(parseLauncherLine('launched breakaway 4242')).toBeNull()
    expect(parseLauncherLine('refused STILL_IN_JOB')).toBeNull()
    expect(parseLauncherLine('in-job WMI_9')).toEqual({ kind: 'in-job', code: 'WMI_9' })
    expect(parseLauncherLine('failed CREATE_2')).toEqual({ kind: 'failed', code: 'CREATE_2' })
    expect(parseLauncherLine('exit 65')).toBeNull()
    expect(parseLauncherLine('WARNING: something')).toBeNull()
    expect(parseLauncherLine('failed C:\\path with spaces')).toBeNull()
  })

  it('[ADR-002, FM-012] breakaway refused then WMI is launched; WMI failing too is in-job', async () => {
    // AMENDED (fix: launch timeout): the helper refuses breakaway (it used to be the step printing
    // `refused`), then the WMI step creates the Host, which the helper opens by its pid to watch.
    const wmi = launch((child) => child.print('launched wmi 4242'))
    const launched = await wmi.outcome
    expect(launched.kind).toBe('launched')
    expect(launched.kind === 'launched' && launched.host.how).toBe('wmi')
    expect(wmi.helper.opened).toEqual([4242])
    expect(wmi.helper.watchedFor()).toBe(HOST_WATCH_MS)

    const refused = launch((child) => {
      child.print('in-job WMI_ERROR')
      child.finish(3)
    }, refusingHelper('CREATE_5'))
    expect(await refused.outcome).toEqual({ kind: 'in-job', errCode: 'WMI_ERROR' })
  })

  it('[ADR-002, FM-008] a step that fails, ends without a launch, cannot start or never reports is a failed launch', async () => {
    // AMENDED (fix: launch timeout): a create that fails is the helper's answer now; the WMI
    // step's own failures below stay as they were.
    const helper = new FakeWinLaunch()
    helper.answer = () => ({ status: 'failed', code: 'CREATE_2' })
    const failed = launch(() => {}, helper)
    expect(await failed.outcome).toEqual({ kind: 'failed', errCode: 'CREATE_2' })
    expect(failed.recorder.calls).toEqual([])

    const unavailable = await createWindowsSpawner({
      loadHelper: () => ({ ok: false, errCode: 'LAUNCHER_HELPER_MISSING' })
    })(REQUEST)
    expect(unavailable).toEqual({ kind: 'failed', errCode: 'LAUNCHER_HELPER_MISSING' })

    const silent = launch((child) => child.finish(1))
    expect(await silent.outcome).toEqual({ kind: 'failed', errCode: 'LAUNCHER_EXIT_1' })

    const missing = launch((child) =>
      child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
    )
    expect(await missing.outcome).toEqual({ kind: 'failed', errCode: 'ENOENT' })

    const hung = launch(() => {})
    await Promise.resolve()
    hung.timeouts.forEach((run) => run())
    expect(await hung.outcome).toEqual({ kind: 'failed', errCode: 'LAUNCHER_TIMEOUT' })
    expect(hung.recorder.calls[0]?.child.killed).toBe(true)
  })

  // AMENDED (fix: launch timeout; was: "… the step reports … release ends only the step"): the
  // in-process helper watches the Host and reports its exit; release ends the watch and closes the
  // handle, never the Host. A Host still running when the watch ends, or one WMI created that
  // cannot be opened, can no longer be watched (null).
  it('[S12.03, FM-011] the Host exit the helper reports reaches the launcher, and release ends only the watch', async () => {
    const run = launch(() => {}, new FakeWinLaunch())
    const outcome: LaunchOutcome = await run.outcome
    if (outcome.kind !== 'launched') throw new Error(`expected a launch, got ${outcome.kind}`)
    expect(run.helper.watchedFor()).toBe(HOST_WATCH_MS)
    run.helper.exit(65)
    expect(await outcome.host.exited).toBe(65)
    expect(run.helper.released).toEqual([run.helper.process])

    const watched = launch((child) => child.print('launched wmi 4242'))
    const second = await watched.outcome
    if (second.kind !== 'launched') throw new Error(`expected a launch, got ${second.kind}`)
    second.host.release()
    expect(await second.host.exited).toBeNull()
    expect(watched.helper.released).toEqual([watched.helper.process])

    const outlived = launch(() => {}, new FakeWinLaunch())
    const third = await outlived.outcome
    if (third.kind !== 'launched') throw new Error(`expected a launch, got ${third.kind}`)
    outlived.helper.exit(-1)
    expect(await third.host.exited).toBeNull()

    const gone = refusingHelper()
    gone.canOpen = false
    const unopened = await launch((child) => child.print('launched wmi 4242'), gone).outcome
    if (unopened.kind !== 'launched') throw new Error(`expected a launch, got ${unopened.kind}`)
    expect(await unopened.host.exited).toBeNull()
  })

  it('[ADR-002] the step runs without PSModulePath and gets the request as JSON on stdin', async () => {
    // AMENDED (fix: launch timeout): the step runs only after a refused breakaway, and WMI reads
    // the command line, not the executable, so `file` is no longer sent.
    const recorder = new RecordingSpawnProcess()
    recorder.onSpawn = (child) => child.print('launched wmi 1')
    const helper = refusingHelper()
    await createWindowsSpawner({
      loadHelper: () => ({ ok: true, binding: helper.binding }),
      spawnProcess: recorder.spawn,
      env: { SystemRoot: 'C:\\Windows', PSModulePath: 'C:\\pwsh\\Modules', TEMP: 'C:\\t' }
    })(REQUEST)
    const [call] = recorder.calls
    expect(call?.options.env).toEqual({ SystemRoot: 'C:\\Windows', TEMP: 'C:\\t' })
    expect(JSON.parse(call?.child.stdinText ?? '{}')).toEqual({
      commandLine:
        '"C:\\DwarfAI\\DwarfAI-Miners.exe" "C:\\DwarfAI\\resources\\app.asar\\out\\host\\main.js"',
      cwd: REQUEST.cwd,
      env: ['ELECTRON_RUN_AS_NODE=1']
    })
  })

  // ADDED (fix: Windows Host launch timeout, CI windows-latest LAUNCHER_TIMEOUT): the breakaway
  // step used to be a PowerShell process compiling C# with Add-Type on every spawn, which a cold or
  // busy machine could not finish within the report timeout, so the Host failed to start.
  it('[ADR-002, FM-008] a slow PowerShell cannot fail the spawn: breakaway runs in-process and starts no launcher step', async () => {
    const helper = new FakeWinLaunch()
    const recorder = new RecordingSpawnProcess()
    const timeouts: Array<() => void> = []
    const outcome = createWindowsSpawner({
      loadHelper: () => ({ ok: true, binding: helper.binding }),
      spawnProcess: recorder.spawn,
      env: { SystemRoot: 'D:\\Win' },
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
    expect(recorder.calls, 'no PowerShell step is started').toEqual([])
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
})
