import { describe, expect, it, vi } from 'vitest'
import {
  CODEX_BINARY_NAMES,
  CODEX_PROBE_SCRIPT,
  PROCESS_START_TOLERANCE_MS,
  buildCodexProbeCommand,
  buildProcessStartProbeCommand,
  createProcessProbe,
  filetimeToEpochMs,
  isCodexAgentProcess,
  parseCodexProbeOutput,
  parseDarwinProcessStart,
  parseLinuxProcessStart,
  parseWindowsProcessStart,
  sameProcessStart,
  type ProbeCommand,
  type ProbeProcessRow
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

  /*
   * AMENDED for #374. Was 'runs pgrep against full command lines on macOS and
   * Linux', expecting ['-f', 'codex'] on both. `-f` alone prints bare pids, and
   * a bare pid cannot be judged: the plugin host that kept a dead session alive
   * for an hour matched the very same pattern a real codex does. The probe now
   * asks pgrep to print the command line beside the pid so the matcher can tell
   * them apart, and the flag for that differs per platform.
   */
  it('asks pgrep to print each match with its command line', () => {
    // -f still matches the whole command line — the coarse filter, which finds
    // a codex started through a wrapper or an interpreter. What is new is the
    // listing flag: procps prints the full command line under -a, and macOS
    // pgrep prints it under -l when -f is also given (its -a does not exist).
    expect(buildCodexProbeCommand('linux').args).toEqual(['-fa', 'codex'])
    expect(buildCodexProbeCommand('darwin').args).toEqual(['-fl', 'codex'])
    for (const platform of ['darwin', 'linux'] as const) {
      expect(buildCodexProbeCommand(platform).command).toBe('pgrep')
    }
  })
})

describe('CODEX_PROBE_SCRIPT', () => {
  it('prints one ProcessId/Name/CommandLine row per match instead of a verdict', () => {
    // The verdict moved into isCodexAgentProcess (#374): WQL can only ask
    // whether a string occurs, and "occurs" is what matched a Chrome plugin
    // host. The script is now a coarse pre-filter that hands rows to
    // TypeScript, so every case below is unit-testable without Windows.
    expect(CODEX_PROBE_SCRIPT).toContain('($_.ProcessId, $_.Name, $_.CommandLine) -join [char]9')
    expect(CODEX_PROBE_SCRIPT).not.toContain('-First 1')
  })

  it('writes through the console rather than the formatter', () => {
    // Out-Default hard-wraps a long line at the host width; a codex command
    // line is long enough to be split, and a marker split across the break
    // would stop matching. [Console]::Out bypasses the formatter entirely.
    expect(CODEX_PROBE_SCRIPT).toContain('[Console]::Out.WriteLine')
  })
})

/*
 * The shapes below are what this machine actually runs, measured read-only on
 * 2026-09-10 against codex-cli 0.153.4 installed through pnpm — recorded in
 * docs/codex-v2-format.md §10. Home paths use the project's `j` placeholder.
 */
describe('isCodexAgentProcess', () => {
  function row(name: string, commandLine: string): ProbeProcessRow {
    return { pid: 4321, name, commandLine }
  }

  const PLUGIN_HOST =
    'C:\\Users\\j\\.codex\\plugins\\cache\\openai-bundled\\chrome\\latest' +
    '\\extension-host\\windows\\x64\\extension-host.exe'
  const VENDOR_BIN =
    'C:\\Users\\j\\AppData\\Local\\pnpm\\global\\v11\\store\\node_modules\\@openai\\codex' +
    '\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe'
  const CLI_SCRIPT =
    'C:\\Users\\j\\AppData\\Local\\pnpm\\global\\v11\\store\\node_modules\\@openai\\codex' +
    '\\bin\\codex.js'

  it('accepts the native binary by name, on either family', () => {
    // The vendored binary is named exactly codex.exe on Windows and codex on
    // POSIX — bin/codex.js builds that path from the target triple, and the
    // triple never reaches the file name.
    expect(isCodexAgentProcess(row('codex.exe', VENDOR_BIN))).toBe(true)
    expect(isCodexAgentProcess(row('codex', '/home/j/.local/share/pnpm/codex'))).toBe(true)
  })

  it('accepts the name whatever case the process list reports it in', () => {
    expect(isCodexAgentProcess(row('CODEX.EXE', VENDOR_BIN))).toBe(true)
  })

  it('accepts the node shape by its entry-point script argument', () => {
    // The installed shim is `node <pkg>/bin/codex.js`, and that node process is
    // the native binary's parent for the whole session.
    expect(isCodexAgentProcess(row('node.exe', `"node.exe"  "${CLI_SCRIPT}"`))).toBe(true)
    expect(
      isCodexAgentProcess(
        row('node', 'node /usr/local/lib/node_modules/@openai/codex/bin/codex.js')
      )
    ).toBe(true)
  })

  it('refuses the Chrome plugin host that kept a dead session on the board', () => {
    // The row from issue #374, as Win32_Process reported it.
    expect(
      isCodexAgentProcess(row('extension-host.exe', `"${PLUGIN_HOST}" --parent-window=0`))
    ).toBe(false)
  })

  it('refuses the cmd.exe that Chrome wraps the plugin host in', () => {
    // Native messaging starts the host through cmd.exe, so the same path is in
    // a second process's command line — measured live on 2026-09-10.
    expect(
      isCodexAgentProcess(
        row('cmd.exe', `C:\\WINDOWS\\system32\\cmd.exe /d /s /c ""${PLUGIN_HOST}"`)
      )
    ).toBe(false)
  })

  it('refuses a codex.exe that lives inside the plugin tree', () => {
    // ~/.codex/plugins/.plugin-appserver/codex.exe exists on this machine: the
    // plugin app-server's own copy, which serves plugins rather than a session.
    // This is why the plugin-tree exclusion is checked before the name.
    expect(
      isCodexAgentProcess(
        row('codex.exe', '"C:\\Users\\j\\.codex\\plugins\\.plugin-appserver\\codex.exe"')
      )
    ).toBe(false)
  })

  it('refuses an editor holding a file from the codex home', () => {
    expect(
      isCodexAgentProcess(
        row(
          'Code.exe',
          '"C:\\Program Files\\Microsoft VS Code\\Code.exe" "C:\\Users\\j\\.codex\\config.toml"'
        )
      )
    ).toBe(false)
  })

  it('refuses a node process that merely mentions the codex home', () => {
    expect(
      isCodexAgentProcess(
        row('node.exe', '"node" "C:\\Users\\j\\scripts\\report.mjs" --home "C:\\Users\\j\\.codex"')
      )
    ).toBe(false)
  })

  it('refuses the sandbox command runner', () => {
    // ~/.codex/.sandbox-bin/codex-command-runner-<version>.exe runs one shell
    // command for a session and exits; the session's own codex.exe is its
    // parent and answers for it. A helper must never be the whole answer.
    expect(
      isCodexAgentProcess(
        row(
          'codex-command-runner-0.153.4.exe',
          '"C:\\Users\\j\\.codex\\.sandbox-bin\\codex-command-runner-0.153.4.exe"'
        )
      )
    ).toBe(false)
  })

  it('refuses the probing PowerShell host, whose own arguments carry the query', () => {
    expect(isCodexAgentProcess(row('powershell.exe', CODEX_PROBE_SCRIPT))).toBe(false)
  })

  it('keeps the measured binary names in one place', () => {
    expect([...CODEX_BINARY_NAMES]).toEqual(['codex', 'codex.exe'])
  })
})

/*
 * Every case here is amended for #374: the probe used to print bare pids, so
 * these tests could only assert pid bookkeeping. The stdout each platform
 * produces now carries a name and a command line per row, which is what the
 * plugin-host false positive needed in order to be excluded at all. The old
 * expectations are named at each amendment; nothing they asserted was dropped.
 */
describe('parseCodexProbeOutput', () => {
  /** A tab-separated Win32_Process row, exactly as CODEX_PROBE_SCRIPT prints one. */
  function winRow(pid: number, name: string, commandLine: string): string {
    return `${pid}\t${name}\t${commandLine}\r\n`
  }

  const PLUGIN_HOST =
    'C:\\Users\\j\\.codex\\plugins\\cache\\openai-bundled\\chrome\\latest' +
    '\\extension-host\\windows\\x64\\extension-host.exe'
  const CODEX_EXE =
    'C:\\Users\\j\\AppData\\Local\\pnpm\\global\\v11\\store\\node_modules\\@openai\\codex' +
    '\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe'
  const NODE_SHIM =
    '"C:\\Users\\j\\AppData\\Local\\pnpm\\bin\\node.exe"  ' +
    '"C:\\Users\\j\\AppData\\Local\\pnpm\\global\\v11\\store\\node_modules\\@openai\\codex' +
    '\\bin\\codex.js"'

  // AMENDED for #374. Was 'reports a codex process when a foreign pid comes
  // back', expecting parseCodexProbeOutput('4321\n', 999) to be true.
  it('reports a codex process when a foreign codex row comes back', () => {
    expect(parseCodexProbeOutput('win32', winRow(4321, 'codex.exe', CODEX_EXE), 999)).toBe(true)
  })

  // AMENDED for #374: signature only. Was parseCodexProbeOutput('', 999) and
  // ('   \n\n', 999), both expected false — still the expectation.
  it('reports nothing running for empty output', () => {
    // pgrep exits 1 and prints nothing when no process matches.
    expect(parseCodexProbeOutput('win32', '', 999)).toBe(false)
    expect(parseCodexProbeOutput('linux', '', 999)).toBe(false)
    expect(parseCodexProbeOutput('win32', '   \n\n', 999)).toBe(false)
  })

  // AMENDED for #374. Was 'excludes this process, which pgrep -f can match
  // through its own arguments', expecting ('999\n', 999) to be false. The
  // exclusion is unchanged; only the row shape it reads is.
  it('excludes this process, which pgrep -f can match through its own arguments', () => {
    // The app's own command line mentions ~/.codex, so it is in the coarse
    // filter's results. Its pid is the one thing that never has to be guessed.
    expect(parseCodexProbeOutput('win32', winRow(999, 'codex.exe', CODEX_EXE), 999)).toBe(false)
    expect(parseCodexProbeOutput('linux', `999 /usr/local/bin/codex\n`, 999)).toBe(false)
  })

  // AMENDED for #374. Was 'still reports running when a foreign pid
  // accompanies this process', expecting ('999\n4321\n', 999) to be true.
  it('still reports running when a foreign codex accompanies this process', () => {
    const stdout = winRow(999, 'codex.exe', CODEX_EXE) + winRow(4321, 'codex.exe', CODEX_EXE)
    expect(parseCodexProbeOutput('win32', stdout, 999)).toBe(true)
  })

  // AMENDED for #374: signature only. Was ('pgrep: illegal option\n', 999),
  // expected false — still the expectation.
  it('ignores non-numeric noise', () => {
    expect(parseCodexProbeOutput('linux', 'pgrep: illegal option\n', 999)).toBe(false)
    expect(parseCodexProbeOutput('win32', 'Get-CimInstance : Access denied\r\n', 999)).toBe(false)
  })

  it('reads the plugin host that kept a dead session working as not running', () => {
    // Issue #374's exact reproduction: no codex process on the machine, and
    // only the orphaned Chrome plugin helpers in the filter's results.
    const stdout =
      winRow(41688, 'extension-host.exe', `"${PLUGIN_HOST}" --parent-window=0`) +
      winRow(38376, 'cmd.exe', `C:\\WINDOWS\\system32\\cmd.exe /d /s /c ""${PLUGIN_HOST}"`) +
      winRow(
        5555,
        'Code.exe',
        '"C:\\Program Files\\Microsoft VS Code\\Code.exe" "C:\\Users\\j\\.codex\\config.toml"'
      )
    expect(parseCodexProbeOutput('win32', stdout, 999)).toBe(false)
  })

  it('reads the node shim as running', () => {
    expect(parseCodexProbeOutput('win32', winRow(4322, 'node.exe', NODE_SHIM), 999)).toBe(true)
  })

  it('finds the one codex row among the helpers', () => {
    const stdout =
      winRow(41688, 'extension-host.exe', `"${PLUGIN_HOST}" --parent-window=0`) +
      winRow(4321, 'codex.exe', CODEX_EXE)
    expect(parseCodexProbeOutput('win32', stdout, 999)).toBe(true)
  })

  it('rejoins a row PowerShell may have wrapped mid-path', () => {
    // Belt and braces for the formatter: a break inside the entry-point path
    // would otherwise hide the marker the node shape is recognised by.
    const at = NODE_SHIM.lastIndexOf('codex.js') + 3
    const split = NODE_SHIM.slice(0, at) + '\r\n' + NODE_SHIM.slice(at)
    expect(parseCodexProbeOutput('win32', `4322\tnode.exe\t${split}\r\n`, 999)).toBe(true)
  })

  it('judges pgrep rows by the same rule', () => {
    const stdout =
      '41688 /home/j/.codex/plugins/cache/openai-bundled/chrome/latest/extension-host/' +
      'linux/x64/extension-host chrome-extension://abc/\n' +
      '5555 /usr/share/code/code /home/j/.codex/config.toml\n'
    expect(parseCodexProbeOutput('linux', stdout, 999)).toBe(false)
    expect(
      parseCodexProbeOutput(
        'linux',
        stdout + '4322 node /usr/local/lib/node_modules/@openai/codex/bin/codex.js\n',
        999
      )
    ).toBe(true)
    expect(
      parseCodexProbeOutput(
        'darwin',
        '4321 /opt/homebrew/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/bin/codex\n',
        999
      )
    ).toBe(true)
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

  /*
   * AMENDED for #374. Was 'runs the platform command and reports its verdict'
   * with stdout '4321\n' and args ['-f', 'codex']; the probe now prints a
   * command line beside each pid and the argv says so.
   */
  it('runs the platform command and reports its verdict', async () => {
    const { run, seen } = record('4321 /usr/local/bin/codex\n')
    const probe = createProcessProbe({ platform: 'linux', run, selfPid: 999 })
    expect(await probe.isCodexProcessRunning()).toBe(true)
    expect(seen).toEqual([{ command: 'pgrep', args: ['-fa', 'codex'] }])
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

/*
 * The comparison every pid-reuse guard makes, given its own name because two
 * of them now make it: the Claude registry's procStart check (#45) and the
 * launch register's re-adoption after a restart (#231).
 */
describe('sameProcessStart', () => {
  it('reads two probes of one process as the same process', () => {
    expect(sameProcessStart(FIXTURE_EPOCH_MS, FIXTURE_EPOCH_MS)).toBe(true)
  })

  /*
   * The whole reason this is not an equality test. `ps -o lstart=` answers in
   * whole seconds, /proc/<pid>/stat in 10ms ticks against a btime that is
   * itself recomputed per read, and the FILETIME conversion truncates — so two
   * honest readings of one process differ by rounding, not by identity.
   */
  it('absorbs the rounding each platform probe answers with', () => {
    for (const drift of [-1_999, -1_000, -10, 10, 1_000, 1_999]) {
      expect(sameProcessStart(FIXTURE_EPOCH_MS + drift, FIXTURE_EPOCH_MS)).toBe(true)
    }
  })

  it('reads a reading past the tolerance as a different process', () => {
    expect(
      sameProcessStart(FIXTURE_EPOCH_MS + PROCESS_START_TOLERANCE_MS + 1, FIXTURE_EPOCH_MS)
    ).toBe(false)
    expect(sameProcessStart(FIXTURE_EPOCH_MS, FIXTURE_EPOCH_MS + 60_000)).toBe(false)
  })

  /*
   * Orders of magnitude tighter than any real pid-recycling interval, which is
   * what makes a window this wide safe: a recycled pid names a process created
   * seconds to days later, never 2s later.
   */
  it('keeps the window far below any interval a pid is actually recycled over', () => {
    expect(PROCESS_START_TOLERANCE_MS).toBe(2_000)
  })
})
