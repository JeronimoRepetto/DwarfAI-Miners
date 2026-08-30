import { describe, expect, it, vi } from 'vitest'
import {
  CODEX_PROBE_SCRIPT,
  buildCodexProbeCommand,
  buildProcessStartProbeCommand,
  createProcessProbe,
  filetimeToEpochMs,
  parseCodexProbeOutput,
  parseDarwinProcessStart,
  parseLinuxProcessStart,
  parseWindowsProcessStart,
  type ProbeCommand
} from './processProbe'

/**
 * The procStart value from the Claude session-entry fixture. FILETIME counts
 * 100ns units since 1601-01-01; this one converts to 2026-08-29T11:12:52.136Z.
 */
const FIXTURE_FILETIME = '134324755721362761'
const FIXTURE_EPOCH_MS = 1_788_001_972_136

describe('buildCodexProbeCommand', () => {
  it('runs the WQL script through powershell on Windows', () => {
    const probe = buildCodexProbeCommand('win32')
    expect(probe.command).toBe('powershell.exe')
    expect(probe.args).toEqual(['-NoProfile', '-Command', CODEX_PROBE_SCRIPT])
  })

  it('runs pgrep against full command lines on macOS and Linux', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const probe = buildCodexProbeCommand(platform)
      expect(probe.command).toBe('pgrep')
      // -f matches the whole command line, which is what finds a `codex`
      // started through a wrapper or an interpreter.
      expect(probe.args).toEqual(['-f', 'codex'])
    }
  })
})

describe('parseCodexProbeOutput', () => {
  it('reports a codex process when a foreign pid comes back', () => {
    expect(parseCodexProbeOutput('4321\n', 999)).toBe(true)
  })

  it('reports nothing running for empty output', () => {
    // pgrep exits 1 and prints nothing when no process matches.
    expect(parseCodexProbeOutput('', 999)).toBe(false)
    expect(parseCodexProbeOutput('   \n\n', 999)).toBe(false)
  })

  it('excludes this process, which pgrep -f can match through its own arguments', () => {
    // Same self-match class as the Windows probe (whose powershell host's
    // CommandLine contains the query text, and therefore "codex"): a
    // command line mentioning codex matches the pattern that looks for it.
    expect(parseCodexProbeOutput('999\n', 999)).toBe(false)
  })

  it('still reports running when a foreign pid accompanies this process', () => {
    expect(parseCodexProbeOutput('999\n4321\n', 999)).toBe(true)
  })

  it('ignores non-numeric noise', () => {
    expect(parseCodexProbeOutput('pgrep: illegal option\n', 999)).toBe(false)
  })
})

describe('createProcessProbe', () => {
  function record(stdout: string): {
    run: (c: ProbeCommand) => Promise<string>
    seen: ProbeCommand[]
  } {
    const seen: ProbeCommand[] = []
    return {
      seen,
      run: async (command) => {
        seen.push(command)
        return stdout
      }
    }
  }

  it('runs the platform command and reports its verdict', async () => {
    const { run, seen } = record('4321\n')
    const probe = createProcessProbe({ platform: 'linux', run, selfPid: 999 })
    expect(await probe.isCodexProcessRunning()).toBe(true)
    expect(seen).toEqual([{ command: 'pgrep', args: ['-f', 'codex'] }])
  })

  it('reports not running when the probe itself fails', async () => {
    // A missing pgrep, a denied WQL query or a timeout are all "unknown", and
    // unknown must never block a poll tick or throw out of it.
    const probe = createProcessProbe({
      platform: 'darwin',
      run: () => Promise.reject(new Error('ENOENT')),
      selfPid: 999
    })
    expect(await probe.isCodexProcessRunning()).toBe(false)
  })

  it('does not run anything until asked', async () => {
    const run = vi.fn(async () => '')
    createProcessProbe({ platform: 'win32', run, selfPid: 1 })
    expect(run).not.toHaveBeenCalled()
  })
})

describe('buildProcessStartProbeCommand', () => {
  it('asks Get-Process for the FILETIME start on Windows', () => {
    const probe = buildProcessStartProbeCommand('win32', 4242)
    expect(probe.command).toBe('powershell.exe')
    // ToFileTime() yields the same unit procStart is recorded in, so the
    // comparison needs no locale-dependent date parsing on Windows at all.
    expect(probe.args).toEqual([
      '-NoProfile',
      '-Command',
      '(Get-Process -Id 4242).StartTime.ToFileTime()'
    ])
  })

  it('reads the per-pid stat and the boot time together on Linux', () => {
    // One spawn for both files: starttime (field 22) is ticks since boot, so
    // it is meaningless without btime from /proc/stat read at the same moment.
    expect(buildProcessStartProbeCommand('linux', 4242)).toEqual({
      command: 'cat',
      args: ['/proc/4242/stat', '/proc/stat']
    })
  })

  it('asks ps for lstart on macOS', () => {
    // lstart is the only stock ps column with an unambiguous year; etime and
    // start both need "now" arithmetic that would add its own error.
    expect(buildProcessStartProbeCommand('darwin', 4242)).toEqual({
      command: 'ps',
      args: ['-p', '4242', '-o', 'lstart=']
    })
  })
})

describe('filetimeToEpochMs', () => {
  it('converts a FILETIME string to epoch milliseconds', () => {
    expect(filetimeToEpochMs(FIXTURE_FILETIME)).toBe(FIXTURE_EPOCH_MS)
  })

  it('rejects values that are not plain digit runs', () => {
    expect(filetimeToEpochMs('')).toBeNull()
    expect(filetimeToEpochMs('garbage')).toBeNull()
    expect(filetimeToEpochMs('-134324755721362761')).toBeNull()
    expect(filetimeToEpochMs('1.34e17')).toBeNull()
  })

  it('rejects numbers outside a plausible process-lifetime window', () => {
    // A registry written by a future Claude Code on another OS might reuse the
    // procStart key for a different unit; an implausible conversion must
    // disable the guard rather than declare every session dead.
    expect(filetimeToEpochMs('123')).toBeNull()
    expect(filetimeToEpochMs('116444736000000000')).toBeNull() // epoch 0
    expect(filetimeToEpochMs('999999999999999999999')).toBeNull()
  })
})

describe('parseWindowsProcessStart', () => {
  it('parses the FILETIME line PowerShell prints', () => {
    expect(parseWindowsProcessStart(`${FIXTURE_FILETIME}\r\n`)).toBe(FIXTURE_EPOCH_MS)
  })

  it('returns null for empty output (missing pid) or noise', () => {
    expect(parseWindowsProcessStart('')).toBeNull()
    expect(parseWindowsProcessStart('Get-Process : Cannot find a process\r\n')).toBeNull()
  })
})

describe('parseLinuxProcessStart', () => {
  /** A /proc/<pid>/stat line whose comm deliberately contains spaces and parens. */
  const statLine =
    '4242 (tmux: (server)) S 1 4242 4242 0 -1 4194304 1000 0 0 0 5 3 0 0 20 0 4 0 ' +
    '123456 100000 500 18446744073709551615'
  const procStat = 'cpu  1 2 3 4\ncpu0 1 2 3 4\nbtime 1756000000\nprocesses 999\n'

  it('combines starttime ticks with the boot time', () => {
    // starttime is scaled to USER_HZ (fixed at 100 by the kernel ABI):
    // 1756000000s * 1000 + 123456 ticks * 10ms = 1756001234560.
    expect(parseLinuxProcessStart(`${statLine}\n${procStat}`)).toBe(1_756_001_234_560)
  })

  it('returns null when the pid stat line is missing', () => {
    // cat keeps going after a missing first file, so /proc/stat alone comes
    // back for a dead pid — no line with a parenthesized comm, no answer.
    expect(parseLinuxProcessStart(procStat)).toBeNull()
  })

  it('returns null when btime is missing', () => {
    expect(parseLinuxProcessStart(`${statLine}\n`)).toBeNull()
  })

  it('returns null for empty output', () => {
    expect(parseLinuxProcessStart('')).toBeNull()
  })
})

describe('parseDarwinProcessStart', () => {
  it('parses the asctime-shaped lstart line as local time', () => {
    // lstart prints local time; Date's component constructor is the local-time
    // interpretation, so the expectation is built the same way.
    const expected = new Date(2026, 7, 29, 11, 7, 36).getTime()
    expect(parseDarwinProcessStart('Sat Aug 29 11:07:36 2026\n')).toBe(expected)
  })

  it('tolerates the double space ps pads single-digit days with', () => {
    const expected = new Date(2026, 8, 3, 9, 0, 5).getTime()
    expect(parseDarwinProcessStart('Thu Sep  3 09:00:05 2026\n')).toBe(expected)
  })

  it('returns null for empty output (missing pid) or an unknown month', () => {
    expect(parseDarwinProcessStart('')).toBeNull()
    expect(parseDarwinProcessStart('Sat Foo 29 11:07:36 2026\n')).toBeNull()
    expect(parseDarwinProcessStart('ps: illegal option\n')).toBeNull()
  })
})

describe('createProcessProbe — processStartTimeMs', () => {
  it('runs the per-platform command and parses its output', async () => {
    const seen: ProbeCommand[] = []
    const statOutput =
      '4242 (node) S 1 4242 4242 0 -1 4194304 1000 0 0 0 5 3 0 0 20 0 4 0 123456 1 1 1\n' +
      'btime 1756000000\n'
    const probe = createProcessProbe({
      platform: 'linux',
      run: async (command) => {
        seen.push(command)
        return statOutput
      },
      selfPid: 999
    })
    expect(await probe.processStartTimeMs(4242)).toBe(1_756_001_234_560)
    expect(seen).toEqual([{ command: 'cat', args: ['/proc/4242/stat', '/proc/stat'] }])
  })

  it('answers null when the probe itself fails', async () => {
    // Missing binary, denied query, timeout: all "unknown". The pid-reuse
    // guard treats unknown as alive, so null must never become an exception.
    const probe = createProcessProbe({
      platform: 'win32',
      run: () => Promise.reject(new Error('ENOENT')),
      selfPid: 999
    })
    expect(await probe.processStartTimeMs(4242)).toBeNull()
  })

  it('answers null for unparseable output', async () => {
    const probe = createProcessProbe({ platform: 'win32', run: async () => '', selfPid: 999 })
    expect(await probe.processStartTimeMs(4242)).toBeNull()
  })
})
