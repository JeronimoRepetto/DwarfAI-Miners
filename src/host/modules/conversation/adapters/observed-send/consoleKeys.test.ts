// layer: L1
// L1 (17 §1.1): the pure builders of the observed-session key relay (ADR-012 item 3; 15 §3.3 "fails
// when the terminal cannot be targeted"). Every per-OS command is a value here, so each OS's argv
// is asserted on every host (skills/platform-ports); the OS lane proves the effect
// (ConsoleKeystrokeDelivery.os.test.ts).
import { describe, expect, it } from 'vitest'
import {
  POWERSHELL_ARGS,
  isAddressableKey,
  keyRecordOf,
  parsePidTty,
  parseTmuxPanes,
  powerShellStdinLine,
  terminalTabKeyArgs,
  tmuxKeyArgs,
  tmuxPaneOn,
  ttyOfArgs,
  windowsKeyWriteScript,
  type ConsoleKey
} from './consoleKeys'

const ONE: ConsoleKey = { kind: 'text', text: '1' }
const ESC: ConsoleKey = { kind: 'escape' }

describe('consoleKeys: the keys a permission answer may press', () => {
  it('[ADR-012] only one digit 1-9 or Esc is addressable; Enter, several characters and 0 are not', () => {
    expect(isAddressableKey(ONE)).toBe(true)
    expect(isAddressableKey({ kind: 'text', text: '9' })).toBe(true)
    expect(isAddressableKey(ESC)).toBe(true)
    for (const text of ['', '0', '12', '\r', '\n', '1\r', 'y', 'Escape', '\u001b']) {
      expect({ text, addressable: isAddressableKey({ kind: 'text', text }) }).toEqual({
        text,
        addressable: false
      })
    }
  })
})

describe('consoleKeys: Windows, a write into the console input buffer by pid', () => {
  it('[ADR-012] 1 is the character 1 with no virtual key and Esc is VK_ESCAPE carrying ESC, never Enter', () => {
    expect(keyRecordOf(ONE)).toEqual({ virtualKey: 0, unit: 0x31 })
    expect(keyRecordOf(ESC)).toEqual({ virtualKey: 0x1b, unit: 0x1b })
    expect(keyRecordOf({ kind: 'text', text: '\r' })).toBeNull()
  })

  it('[ADR-012] the script attaches to that pid, writes one key down and up in one call, and detaches', () => {
    const script = windowsKeyWriteScript(4242, ESC)
    expect(script).not.toBeNull()
    expect(script).toContain('[Win32.ConsoleInput]::AttachConsole(4242)')
    expect(script).toContain("CreateFileW('CONIN$'")
    expect(script!.match(/WriteConsoleInputW\(\$conin/g)).toHaveLength(1)
    expect(script).toContain('[uint16]27).CopyTo($buffer, $offset + 10)')
    expect(script).toContain('[uint16]27).CopyTo($buffer, $offset + 14)')
    // FreeConsole before the attach (a child already has a console) and after the write.
    expect(script!.match(/FreeConsole\(\)/g)!.length).toBeGreaterThanOrEqual(3)
    const digit = windowsKeyWriteScript(4242, ONE)!
    expect(digit).toContain('[uint16]0).CopyTo($buffer, $offset + 10)')
    expect(digit).toContain('[uint16]49).CopyTo($buffer, $offset + 14)')
    expect(digit).not.toContain('[uint16]13)')
  })

  it('[ADR-014, INV-51] no script is built for a pid that cannot name a process or a key that is not addressable', () => {
    for (const pid of [0, -1, 1.5, Number.NaN]) {
      expect({ pid, script: windowsKeyWriteScript(pid, ONE) }).toEqual({ pid, script: null })
    }
    expect(windowsKeyWriteScript(4242, { kind: 'text', text: '1\r' })).toBeNull()
  })

  it('[ADR-012] the script travels as ONE stdin line to a PowerShell with no profile, read as a whole script', () => {
    expect(POWERSHELL_ARGS).toEqual(['-NoProfile', '-NonInteractive', '-Command', '-'])
    const line = powerShellStdinLine('exit 7')
    expect(line.endsWith('\n')).toBe(true)
    expect(line.slice(0, -1)).not.toContain('\n')
    const encoded = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(line)?.[1]
    expect(Buffer.from(encoded ?? '', 'base64').toString('utf8')).toBe('exit 7')
  })
})

describe('consoleKeys: POSIX, a tmux pane or a Terminal.app tab named by the tty', () => {
  it('[ADR-012] the tty of a pid is read with ps and normalised to its device path', () => {
    expect(ttyOfArgs(4242)).toEqual(['-o', 'tty=', '-p', '4242'])
    expect(ttyOfArgs(0)).toBeNull()
    expect(parsePidTty('ttys001\n')).toBe('/dev/ttys001')
    expect(parsePidTty('pts/4\n')).toBe('/dev/pts/4')
    for (const none of ['', '??\n', '?\n', 'a b']) expect(parsePidTty(none)).toBeNull()
  })

  it('[ADR-012] the pane is the one tmux reports on that tty; no tty or no such pane is no pane', () => {
    const panes = parseTmuxPanes('%1 /dev/pts/1 100\nnot a pane\n%7 /dev/pts/4 200\n')
    expect(panes).toEqual([
      { paneId: '%1', tty: '/dev/pts/1' },
      { paneId: '%7', tty: '/dev/pts/4' }
    ])
    expect(tmuxPaneOn('/dev/pts/4', panes)).toBe('%7')
    expect(tmuxPaneOn('/dev/pts/9', panes)).toBeNull()
    expect(tmuxPaneOn(null, panes)).toBeNull()
  })

  it('[ADR-012] tmux sends 1 literally and Esc as the Escape key, to that pane only, with no Enter', () => {
    expect(tmuxKeyArgs('%7', ONE)).toEqual(['send-keys', '-t', '%7', '-l', '1'])
    expect(tmuxKeyArgs('%7', ESC)).toEqual(['send-keys', '-t', '%7', 'Escape'])
    expect(tmuxKeyArgs('%7; kill', ONE)).toBeNull()
    expect(tmuxKeyArgs('%7', { kind: 'text', text: 'Enter' })).toBeNull()
  })

  it('[ADR-012] a Terminal.app tab takes a digit by its tty and never an Esc, whose appended Return is unmeasured', () => {
    const args = terminalTabKeyArgs('/dev/ttys001', ONE)
    expect(args).not.toBeNull()
    expect(args![0]).toBe('-e')
    expect(args!.slice(2)).toEqual(['/dev/ttys001', '1'])
    expect(args![1]).toContain('if tty of t is targetTty then')
    expect(args![1]).toContain('do script payloadText in t')
    expect(terminalTabKeyArgs('/dev/ttys001', ESC)).toBeNull()
    expect(terminalTabKeyArgs('ttys001', ONE)).toBeNull()
  })
})
