import { describe, expect, it } from 'vitest'
import { RecordingSpawnProcess, type FakeChildProcess } from './fakes/FakeChildProcess'
import type { HostSpawnRequest, LaunchOutcome } from './ports'
import {
  createWindowsSpawner,
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

/** A launcher step whose child the test drives; the timeout never fires on its own. */
function launch(drive: (child: FakeChildProcess) => void) {
  const recorder = new RecordingSpawnProcess()
  const timeouts: Array<() => void> = []
  recorder.onSpawn = drive
  const outcome = createWindowsSpawner({
    spawnProcess: recorder.spawn,
    env: { SystemRoot: 'D:\\Win' },
    after: (_ms, run) => {
      timeouts.push(run)
      return () => {}
    }
  })(REQUEST)
  return { recorder, outcome, timeouts }
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
    expect(script).toContain('IsProcessInJob')
    expect(script).toContain('Win32_Process -MethodName Create')
    expect(script).toContain('CurrentDirectory = $request.cwd')
    expect(script).toContain('EnvironmentVariables = [string[]]$request.env')
  })

  it('[ADR-002] each line the step prints is read as its fact, anything else is ignored', () => {
    expect(parseLauncherLine('launched breakaway 4242')).toEqual({
      kind: 'launched',
      how: 'breakaway'
    })
    expect(parseLauncherLine('launched wmi 17\r')).toEqual({ kind: 'launched', how: 'wmi' })
    expect(parseLauncherLine('refused STILL_IN_JOB')).toEqual({
      kind: 'refused',
      code: 'STILL_IN_JOB'
    })
    expect(parseLauncherLine('in-job WMI_9')).toEqual({ kind: 'in-job', code: 'WMI_9' })
    expect(parseLauncherLine('failed CREATE_2')).toEqual({ kind: 'failed', code: 'CREATE_2' })
    expect(parseLauncherLine('exit 65')).toEqual({ kind: 'exit', code: 65 })
    expect(parseLauncherLine('exit 3221225477')).toEqual({ kind: 'exit', code: 3221225477 })
    expect(parseLauncherLine('WARNING: something')).toBeNull()
    expect(parseLauncherLine('failed C:\\path with spaces')).toBeNull()
  })

  it('[ADR-002, FM-012] breakaway refused then WMI is launched; WMI failing too is in-job', async () => {
    const wmi = launch((child) => {
      child.print('refused STILL_IN_JOB')
      child.print('launched wmi 4242')
    })
    const launched = await wmi.outcome
    expect(launched.kind).toBe('launched')
    expect(launched.kind === 'launched' && launched.host.how).toBe('wmi')

    const refused = launch((child) => {
      child.print('refused CREATE_5')
      child.print('in-job WMI_ERROR')
      child.finish(3)
    })
    expect(await refused.outcome).toEqual({ kind: 'in-job', errCode: 'WMI_ERROR' })
  })

  it('[ADR-002, FM-008] a step that fails, ends without a launch, cannot start or never reports is a failed launch', async () => {
    const failed = launch((child) => child.print('failed CREATE_2'))
    expect(await failed.outcome).toEqual({ kind: 'failed', errCode: 'CREATE_2' })

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

  it('[S12.03, FM-011] the Host exit the step reports reaches the launcher, and release ends only the step', async () => {
    let step: FakeChildProcess | undefined
    const run = launch((child) => {
      step = child
      child.print('launched breakaway 4242')
    })
    const outcome: LaunchOutcome = await run.outcome
    if (outcome.kind !== 'launched') throw new Error(`expected a launch, got ${outcome.kind}`)
    step?.print('exit 65')
    expect(await outcome.host.exited).toBe(65)

    const watched = launch((child) => child.print('launched wmi 4242'))
    const second = await watched.outcome
    if (second.kind !== 'launched') throw new Error(`expected a launch, got ${second.kind}`)
    second.host.release()
    expect(await second.host.exited).toBeNull()
    expect(watched.recorder.calls[0]?.child.killed).toBe(true)
  })

  it('[ADR-002] the step runs without PSModulePath and gets the request as JSON on stdin', async () => {
    const recorder = new RecordingSpawnProcess()
    recorder.onSpawn = (child) => child.print('launched breakaway 1')
    await createWindowsSpawner({
      spawnProcess: recorder.spawn,
      env: { SystemRoot: 'C:\\Windows', PSModulePath: 'C:\\pwsh\\Modules', TEMP: 'C:\\t' }
    })(REQUEST)
    const [call] = recorder.calls
    expect(call?.options.env).toEqual({ SystemRoot: 'C:\\Windows', TEMP: 'C:\\t' })
    expect(JSON.parse(call?.child.stdinText ?? '{}')).toEqual({
      file: REQUEST.file,
      commandLine:
        '"C:\\DwarfAI\\DwarfAI-Miners.exe" "C:\\DwarfAI\\resources\\app.asar\\out\\host\\main.js"',
      cwd: REQUEST.cwd,
      env: ['ELECTRON_RUN_AS_NODE=1']
    })
  })
})
