import { win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  LINUX_TERMINALS,
  buildDarwinTerminalCommand,
  buildFallbackArgs,
  buildLinuxTerminalCommand,
  buildPosixViewerArgv,
  buildViewerLaunchChain,
  buildWtArgs,
  launchTranscriptViewer,
  quotePosixArgv,
  resolveViewerScriptPath,
  viewerScriptName,
  type SpawnFn,
  type SpawnedProcess
} from './terminalLauncher'

describe('viewerScriptName', () => {
  it('uses the PowerShell viewer on Windows and the POSIX one elsewhere', () => {
    expect(viewerScriptName('win32')).toBe('dwarf-feed-viewer.ps1')
    expect(viewerScriptName('darwin')).toBe('dwarf-feed-viewer.sh')
    expect(viewerScriptName('linux')).toBe('dwarf-feed-viewer.sh')
  })
})

describe('resolveViewerScriptPath', () => {
  it('resolves inside process.resourcesPath once packaged', () => {
    const result = resolveViewerScriptPath(
      {
        isPackaged: true,
        resourcesPath: 'C:\\Program Files\\DwarfAI-Miners\\resources',
        appPath: 'C:\\Program Files\\DwarfAI-Miners\\resources\\app.asar'
      },
      'win32'
    )
    expect(result).toBe(
      win32.join('C:\\Program Files\\DwarfAI-Miners\\resources', 'dwarf-feed-viewer.ps1')
    )
  })

  it('resolves next to the project resources dir in dev', () => {
    const result = resolveViewerScriptPath(
      {
        isPackaged: false,
        resourcesPath: '',
        appPath: 'C:\\Users\\j\\Desktop\\Sample-Project\\agent-name'
      },
      'win32'
    )
    expect(result).toBe(
      win32.join(
        'C:\\Users\\j\\Desktop\\Sample-Project\\agent-name',
        'resources',
        'dwarf-feed-viewer.ps1'
      )
    )
  })

  it('builds POSIX paths for the POSIX viewer, whatever host runs the test', () => {
    expect(
      resolveViewerScriptPath(
        {
          isPackaged: true,
          resourcesPath: '/Applications/DwarfAI-Miners.app/Contents/Resources',
          appPath: '/Applications/DwarfAI-Miners.app/Contents/Resources/app.asar'
        },
        'darwin'
      )
    ).toBe('/Applications/DwarfAI-Miners.app/Contents/Resources/dwarf-feed-viewer.sh')

    expect(
      resolveViewerScriptPath(
        { isPackaged: false, resourcesPath: '', appPath: '/home/j/agent-name' },
        'linux'
      )
    ).toBe('/home/j/agent-name/resources/dwarf-feed-viewer.sh')
  })
})

describe('buildWtArgs', () => {
  it('opens a titled new tab running the viewer script against the transcript', () => {
    const args = buildWtArgs(
      'Foreman',
      'C:\\app\\resources\\dwarf-feed-viewer.ps1',
      'C:\\logs\\session.jsonl'
    )
    expect(args).toEqual([
      '-w',
      '-1',
      'new-tab',
      '--title',
      'Foreman',
      'powershell',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'C:\\app\\resources\\dwarf-feed-viewer.ps1',
      '-Path',
      'C:\\logs\\session.jsonl',
      // AMENDED for #635 (was: '-Title', 'Foreman' as two arguments): one argument, so a title
      // that starts with '-' can never be read as a parameter of the script.
      '-Title:Foreman'
    ])
  })
})

describe('buildFallbackArgs', () => {
  it('runs the viewer script directly for a standalone PowerShell window', () => {
    const args = buildFallbackArgs(
      'Foreman',
      'C:\\app\\resources\\dwarf-feed-viewer.ps1',
      'C:\\logs\\session.jsonl'
    )
    expect(args).toEqual([
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'C:\\app\\resources\\dwarf-feed-viewer.ps1',
      '-Path',
      'C:\\logs\\session.jsonl',
      // AMENDED for #635 (was: '-Title', 'Foreman' as two arguments), as buildWtArgs's above.
      '-Title:Foreman'
    ])
  })
})

describe('buildPosixViewerArgv', () => {
  it('runs the shipped script through sh, so no execute bit is needed', () => {
    expect(
      buildPosixViewerArgv({
        title: 'Foreman',
        viewerScriptPath: '/app/resources/dwarf-feed-viewer.sh',
        transcriptPath: '/home/j/.claude/projects/enc/s1.jsonl',
        nodePath: '/opt/DwarfAI-Miners/dwarfai-miners'
      })
    ).toEqual([
      'sh',
      '/app/resources/dwarf-feed-viewer.sh',
      '--path',
      '/home/j/.claude/projects/enc/s1.jsonl',
      '--title',
      'Foreman',
      // The viewer parses JSONL with the Node runtime the app already ships,
      // so no system Node is required on the user's machine.
      '--node',
      '/opt/DwarfAI-Miners/dwarfai-miners'
    ])
  })
})

describe('quotePosixArgv', () => {
  it('quotes every argument literally', () => {
    expect(quotePosixArgv(['sh', '/a b/c.sh', '--title', 'My Mine'])).toBe(
      "'sh' '/a b/c.sh' '--title' 'My Mine'"
    )
  })

  it('survives an argument containing a single quote', () => {
    // A project directory called `j's stuff` must not end the literal and
    // leave the rest of the path running as shell source.
    expect(quotePosixArgv(["j's stuff"])).toBe("'j'\\''s stuff'")
  })
})

describe('buildDarwinTerminalCommand', () => {
  const launch = buildDarwinTerminalCommand(['sh', '/app/viewer.sh', '--title', 'Foreman'])

  it('asks Terminal.app to run the command and come forward', () => {
    expect(launch.command).toBe('osascript')
    expect(launch.args[0]).toBe('-e')
    expect(launch.args[1]).toContain('tell application "Terminal" to do script')
    expect(launch.args[3]).toBe('tell application "Terminal" to activate')
  })

  it('carries the shell-quoted argv as the script to run', () => {
    expect(launch.args[1]).toContain("'sh' '/app/viewer.sh' '--title' 'Foreman'")
  })

  it('escapes the shell command line for the AppleScript literal it sits in', () => {
    // Two parsers, two escapes: the shell must see the quotes literally, and
    // AppleScript must not end its own string early on them.
    const quoted = buildDarwinTerminalCommand(['echo', 'say "hi"']).args[1] as string
    expect(quoted).toBe(`tell application "Terminal" to do script "'echo' 'say \\"hi\\"'"`)
  })
})

describe('buildLinuxTerminalCommand', () => {
  it('uses the exec flag each terminal actually accepts', () => {
    expect(buildLinuxTerminalCommand('gnome-terminal', ['sh', 'v.sh']).args).toEqual([
      '--',
      'sh',
      'v.sh'
    ])
    expect(buildLinuxTerminalCommand('xfce4-terminal', ['sh', 'v.sh']).args).toEqual([
      '-x',
      'sh',
      'v.sh'
    ])
    for (const terminal of ['x-terminal-emulator', 'konsole', 'xterm']) {
      expect(buildLinuxTerminalCommand(terminal, ['sh', 'v.sh']).args).toEqual(['-e', 'sh', 'v.sh'])
    }
  })
})

describe('buildViewerLaunchChain', () => {
  const options = {
    title: 'Foreman',
    viewerScriptPath: '/app/viewer.sh',
    transcriptPath: '/logs/s.jsonl',
    nodePath: '/app/node'
  }

  it('tries Windows Terminal before a standalone PowerShell window', () => {
    const chain = buildViewerLaunchChain({ ...options, platform: 'win32' })
    expect(chain.map((launch) => launch.command)).toEqual(['wt.exe', 'powershell.exe'])
  })

  it('has one candidate on macOS: Terminal.app through osascript', () => {
    const chain = buildViewerLaunchChain({ ...options, platform: 'darwin' })
    expect(chain.map((launch) => launch.command)).toEqual(['osascript'])
  })

  it('walks the Linux terminal chain, most portable first', () => {
    // No Linux terminal is guaranteed installed, so every candidate gets a
    // turn rather than the app declaring defeat after the first ENOENT.
    const chain = buildViewerLaunchChain({ ...options, platform: 'linux' })
    expect(chain.map((launch) => launch.command)).toEqual([...LINUX_TERMINALS])
    expect(LINUX_TERMINALS[0]).toBe('x-terminal-emulator')
  })
})

/** A fake child process the test controls: no real process is ever spawned. */
function fakeChild(): {
  proc: SpawnedProcess
  emit: (event: 'error' | 'spawn', error?: Error) => void
} {
  const listeners = new Map<string, (error?: Error) => void>()
  return {
    proc: {
      once: (event, listener) => {
        listeners.set(event, listener)
      },
      unref: () => {}
    },
    emit: (event, error) => listeners.get(event)?.(error)
  }
}

describe('launchTranscriptViewer', () => {
  it('returns true once wt.exe actually spawns, and never tries the fallback', async () => {
    const commands: string[] = []
    const spawn: SpawnFn = (command) => {
      commands.push(command)
      const fake = fakeChild()
      queueMicrotask(() => fake.emit('spawn'))
      return fake.proc
    }

    const ok = await launchTranscriptViewer({
      dwarfName: 'Foreman',
      transcriptPath: 'C:\\log.jsonl',
      viewerScriptPath: 'C:\\view.ps1',
      platform: 'win32',
      spawn
    })

    expect(ok).toBe(true)
    expect(commands).toEqual(['wt.exe'])
  })

  it('falls back to a standalone PowerShell window when wt.exe is missing', async () => {
    const commands: string[] = []
    const spawn: SpawnFn = (command) => {
      commands.push(command)
      const fake = fakeChild()
      if (command === 'wt.exe') {
        queueMicrotask(() => fake.emit('error', new Error('ENOENT')))
      } else {
        queueMicrotask(() => fake.emit('spawn'))
      }
      return fake.proc
    }

    const ok = await launchTranscriptViewer({
      dwarfName: 'Foreman',
      transcriptPath: 'C:\\log.jsonl',
      viewerScriptPath: 'C:\\view.ps1',
      platform: 'win32',
      spawn
    })

    expect(ok).toBe(true)
    expect(commands).toEqual(['wt.exe', 'powershell.exe'])
  })

  it('returns false when both wt.exe and the PowerShell fallback fail to spawn', async () => {
    const spawn: SpawnFn = () => {
      const fake = fakeChild()
      queueMicrotask(() => fake.emit('error', new Error('nope')))
      return fake.proc
    }

    const ok = await launchTranscriptViewer({
      dwarfName: 'Foreman',
      transcriptPath: 'C:\\log.jsonl',
      viewerScriptPath: 'C:\\view.ps1',
      platform: 'win32',
      spawn
    })

    expect(ok).toBe(false)
  })

  it('opens Terminal.app through osascript on macOS', async () => {
    const commands: string[] = []
    const spawn: SpawnFn = (command) => {
      commands.push(command)
      const fake = fakeChild()
      queueMicrotask(() => fake.emit('spawn'))
      return fake.proc
    }

    const ok = await launchTranscriptViewer({
      dwarfName: 'Foreman',
      transcriptPath: '/logs/s.jsonl',
      viewerScriptPath: '/app/viewer.sh',
      platform: 'darwin',
      nodePath: '/app/node',
      spawn
    })

    expect(ok).toBe(true)
    expect(commands).toEqual(['osascript'])
  })

  it('keeps trying Linux terminals until one is actually installed', async () => {
    const commands: string[] = []
    const spawn: SpawnFn = (command) => {
      commands.push(command)
      const fake = fakeChild()
      queueMicrotask(() => {
        if (command === 'konsole') fake.emit('spawn')
        else fake.emit('error', new Error('ENOENT'))
      })
      return fake.proc
    }

    const ok = await launchTranscriptViewer({
      dwarfName: 'Foreman',
      transcriptPath: '/logs/s.jsonl',
      viewerScriptPath: '/app/viewer.sh',
      platform: 'linux',
      nodePath: '/app/node',
      spawn
    })

    expect(ok).toBe(true)
    expect(commands).toEqual(['x-terminal-emulator', 'gnome-terminal', 'konsole'])
  })

  it('returns false when no Linux terminal is installed at all', async () => {
    const spawn: SpawnFn = () => {
      const fake = fakeChild()
      queueMicrotask(() => fake.emit('error', new Error('ENOENT')))
      return fake.proc
    }

    const ok = await launchTranscriptViewer({
      dwarfName: 'Foreman',
      transcriptPath: '/logs/s.jsonl',
      viewerScriptPath: '/app/viewer.sh',
      platform: 'linux',
      nodePath: '/app/node',
      spawn
    })

    expect(ok).toBe(false)
  })
})

/*
 * A custom name as the console's title (#635, handoff "Dwarf names in the app", Where it shows).
 * A person types it, so it is the first title this chain carries that no provider chose: spaces and
 * an apostrophe are ordinary. On every platform it may land only where the title goes — the argv
 * of every candidate differs from the base name's at the title's own places and nowhere else — and
 * on macOS it stays one literal shell word inside the AppleScript string.
 */
describe('buildViewerLaunchChain with a custom name as the title (#635)', () => {
  const CUSTOM = "Old Watcher's"
  const chainFor = (platform: 'win32' | 'darwin' | 'linux', title: string) =>
    buildViewerLaunchChain({
      platform,
      title,
      viewerScriptPath: platform === 'win32' ? 'C:\\app\\viewer.ps1' : '/app/viewer.sh',
      transcriptPath: platform === 'win32' ? 'C:\\logs\\s.jsonl' : '/logs/s.jsonl',
      nodePath: '/app/node'
    })

  it.each(['win32', 'linux'] as const)(
    'puts the name only where the title goes on %s',
    (platform) => {
      const renamed = chainFor(platform, CUSTOM)
      const base = chainFor(platform, 'dwarfai-55')
      expect(renamed.map((c) => c.command)).toEqual(base.map((c) => c.command))
      renamed.forEach((candidate, i) => {
        const other = base[i]!.args
        expect(candidate.args).toHaveLength(other.length)
        // AMENDED for #635 (PowerShell's title is one `-Title:<title>` argument now, below; was:
        // the name alone after a `--title` or `-Title` argument, in every differing place).
        candidate.args.forEach((arg, j) => {
          if (arg === other[j]) return
          if (arg.startsWith('-Title:')) {
            expect([arg, other[j]]).toEqual(['-Title:' + CUSTOM, '-Title:dwarfai-55'])
            return
          }
          expect([arg, other[j]]).toEqual([CUSTOM, 'dwarfai-55'])
          expect(candidate.args[j - 1]).toMatch(/^(--title|-Title)$/)
        })
        expect(candidate.args.some((arg) => arg.endsWith(CUSTOM))).toBe(true)
      })
    }
  )

  it('keeps the name one literal shell word in the Terminal.app script on darwin', () => {
    const [launch] = chainFor('darwin', CUSTOM)
    expect(launch!.command).toBe('osascript')
    // The shell's '\'' for the apostrophe, its backslash doubled for the AppleScript string.
    expect(launch!.args[1]).toContain(`'--title' 'Old Watcher'\\\\''s' '--node'`)
  })
})

/*
 * The console title is display text a person may have typed (#635): a custom name reaches these
 * command lines now, and a base name is a folder's name. Neither may ever act as anything but a
 * title, on any platform.
 *
 * Windows Terminal separates its own commands with `;` and documents no escape for one inside an
 * argument (Microsoft Learn, "Windows Terminal command line arguments"), so a `;` in a title could
 * start another wt command: every `;` becomes U+FF1B, which reads the same. It documents no quoting
 * rule for the command line it hands on either, so a `"` becomes U+FF02 on that route too.
 * PowerShell takes the title as one `-Title:<title>` argument, the form that binds a value to its
 * parameter whatever it starts with (reproduced against powershell.exe -File: `-Title -Path` fails
 * to bind, `-Title:-Path` binds "-Path"). wt's own `--title` has no documented one-argument form, so
 * a title starting with `-` starts with U+2010 there instead. Control characters and line breaks
 * are never part of a title, on any platform.
 */
describe('the console title is display text only (#635)', () => {
  const SCRIPT = 'C:\\app\\viewer.ps1'
  const LOG = 'C:\\logs\\s.jsonl'
  const windows = (title: string) =>
    buildViewerLaunchChain({
      platform: 'win32',
      title,
      viewerScriptPath: SCRIPT,
      transcriptPath: LOG,
      nodePath: 'unused'
    })
  const wtArgv = (wtTitle: string, psTitle: string) => [
    '-w',
    '-1',
    'new-tab',
    '--title',
    wtTitle,
    'powershell',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    SCRIPT,
    '-Path',
    LOG,
    '-Title:' + psTitle
  ]
  const psArgv = (psTitle: string) => [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    SCRIPT,
    '-Path',
    LOG,
    '-Title:' + psTitle
  ]

  it.each([
    ['a normal name', 'Watcher', 'Watcher', 'Watcher'],
    ['a name with ;', 'Rock;Roll', 'Rock\uFF1BRoll', 'Rock\uFF1BRoll'],
    [
      'a name that is a wt command',
      'x ; new-tab cmd /c calc',
      'x \uFF1B new-tab cmd /c calc',
      'x \uFF1B new-tab cmd /c calc'
    ],
    ['a name starting with -', '-Path', '\u2010Path', '-Path'],
    ['a name with a quote', 'Old "Iron"', 'Old \uFF02Iron\uFF02', 'Old \uFF02Iron\uFF02'],
    [
      'a name with a line break and a bell',
      'Stone\r\nbeard\u0007!',
      'Stone beard !',
      'Stone beard !'
    ],
    /*
     * Seen live against wt.exe on Windows (#635): wt expands environment variables in the command
     * line it hands PowerShell, so `a%USERNAME%b` arrived as the account's name and
     * `x%ProgramFiles%y` split into two arguments. Every `%` becomes U+FF05, on both routes.
     */
    ['a name with a variable', 'a%USERNAME%b', 'a％USERNAME％b', 'a％USERNAME％b'],
    [
      'a name whose variable holds a space',
      'x%ProgramFiles%y',
      'x％ProgramFiles％y',
      'x％ProgramFiles％y'
    ],
    /*
     * Also seen live: wt quotes an argument holding a space without doubling the backslashes
     * before its closing quote, so `Old Watcher\` arrived as `Old Watcher"`. Every `\` becomes
     * U+FF3C, on both routes.
     */
    ['a name ending in \\ with a space', 'Old Watcher\\', 'Old Watcher＼', 'Old Watcher＼'],
    ['a name with a \\ inside', 'a\\b', 'a＼b', 'a＼b']
  ])('win32, %s: the exact argv of both candidates', (_case, title, wtTitle, psTitle) => {
    expect(windows(title)).toEqual([
      { command: 'wt.exe', args: wtArgv(wtTitle, psTitle) },
      { command: 'powershell.exe', args: psArgv(psTitle) }
    ])
  })

  it('win32: no argument carries a bare ; or a quote, and wt reads no title as an option', () => {
    for (const title of ['x ; new-tab cmd /c calc', ';;', '-w 0 nt', '--help', 'a"b"c']) {
      for (const candidate of windows(title)) {
        for (const arg of candidate.args) {
          expect(arg).not.toContain(';')
          expect(arg).not.toContain('"')
        }
      }
      const [wt] = windows(title)
      const value = wt!.args[wt!.args.indexOf('--title') + 1]!
      expect(value.startsWith('-')).toBe(false)
    }
  })

  // The paths keep their `\`: only the title is display text a person may have typed.
  it('win32: no title argument carries a % or a \\, on either route', () => {
    for (const title of ['%PATH%', 'C:\\x\\', '%%\\%', 'Old Watcher\\']) {
      const [wt, ps] = windows(title)
      const titles = [
        wt!.args[wt!.args.indexOf('--title') + 1]!,
        wt!.args.at(-1)!,
        ps!.args.at(-1)!
      ]
      for (const shown of titles) {
        expect(shown).not.toMatch(/[%\\]/)
      }
      expect(wt!.args).toContain(SCRIPT)
      expect(ps!.args).toContain(LOG)
    }
  })

  /*
   * macOS: the argv is quoted for the shell and then escaped for the AppleScript string, so `;`,
   * a leading `-`, `"` and `\` all stay inside one literal word; the viewer script's own parser
   * takes whatever follows `--title` as its value. Only the control characters go.
   */
  it('darwin: the exact Terminal.app script, the title one literal shell word', () => {
    const script = (title: string) =>
      buildViewerLaunchChain({
        platform: 'darwin',
        title,
        viewerScriptPath: '/app/viewer.sh',
        transcriptPath: '/logs/s.jsonl',
        nodePath: '/app/node'
      })[0]!.args[1]
    const expected = (word: string) =>
      `tell application "Terminal" to do script "'sh' '/app/viewer.sh' '--path' '/logs/s.jsonl' '--title' ${word} '--node' '/app/node'"`
    expect(script('Watcher')).toBe(expected("'Watcher'"))
    expect(script('x ; new-tab cmd /c calc')).toBe(expected("'x ; new-tab cmd /c calc'"))
    expect(script('-Path')).toBe(expected("'-Path'"))
    expect(script('a"b\\c')).toBe(expected("'a\\\"b\\\\c'"))
    expect(script('Stone\nbeard\u001b]0;x\u0007')).toBe(expected("'Stone beard ]0;x'"))
  })

  /*
   * Linux: no terminal is handed a title flag; the title reaches the viewer script as an argv
   * element after the terminal's own "run this" flag, so `;` and a leading `-` are data. Only the
   * control characters go, which would otherwise reach the script's OSC title escape.
   */
  it('linux: the exact argv every terminal is given', () => {
    const chain = buildViewerLaunchChain({
      platform: 'linux',
      title: 'x ; -e calc\u001b\u0007',
      viewerScriptPath: '/app/viewer.sh',
      transcriptPath: '/logs/s.jsonl',
      nodePath: '/app/node'
    })
    const argv = [
      'sh',
      '/app/viewer.sh',
      '--path',
      '/logs/s.jsonl',
      '--title',
      'x ; -e calc',
      '--node',
      '/app/node'
    ]
    expect(chain).toEqual([
      { command: 'x-terminal-emulator', args: ['-e', ...argv] },
      { command: 'gnome-terminal', args: ['--', ...argv] },
      { command: 'konsole', args: ['-e', ...argv] },
      { command: 'xfce4-terminal', args: ['-x', ...argv] },
      { command: 'xterm', args: ['-e', ...argv] }
    ])
  })
})
