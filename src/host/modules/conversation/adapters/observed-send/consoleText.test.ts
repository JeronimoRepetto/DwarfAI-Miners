// layer: L1
// The pure builders of the observed-session text relay (ADR-012 item 3; 15 §3.3; spike S-022-1):
// the text a terminal is handed is the console normalization of the message, bounded, and it
// travels as data — base64 on PowerShell's stdin, a tmux buffer read from stdin, or an osascript
// argument — never inside a script or a command line a shell would parse.
import { describe, expect, it } from 'vitest'
import {
  MAX_CONSOLE_CHUNK_CODE_POINTS,
  MAX_RELAY_TEXT_CODE_POINTS,
  TMUX_BUFFER_NAME,
  boundedChunks,
  relayTextOf,
  terminalTabTextArgs,
  tmuxLoadBufferArgs,
  tmuxPasteArgs,
  tmuxSubmitArgs,
  windowsTextWriteScript
} from './consoleText'

const utf16 = (text: string) => Buffer.from(text, 'utf16le').toString('base64')

describe('relayTextOf: the text the console relay hands a terminal', () => {
  it('[S-022-1] is the console normalization of the message: whitespace runs collapsed to one space, then trimmed', () => {
    const probe = '  dig  here\tnow\r\nand\nthen   é ✓ 🙂 — '
    expect(relayTextOf(probe)).toBe('dig here now and then é ✓ 🙂 —')
    expect(relayTextOf('one line')).toBe('one line')
  })

  it('[ADR-012] a message with nothing left to type, or past the relay bound, is no relay text', () => {
    expect(relayTextOf(' \r\n\t ')).toBeNull()
    expect(relayTextOf('x'.repeat(MAX_RELAY_TEXT_CODE_POINTS))).toBe(
      'x'.repeat(MAX_RELAY_TEXT_CODE_POINTS)
    )
    expect(relayTextOf('🙂'.repeat(MAX_RELAY_TEXT_CODE_POINTS + 1))).toBeNull()
  })

  it('[ADR-012] chunks are bounded in code points and never split a surrogate pair', () => {
    const text = '🙂'.repeat(MAX_CONSOLE_CHUNK_CODE_POINTS * 2 + 3)
    const chunks = boundedChunks(text)
    expect(chunks.map((c) => Array.from(c).length)).toEqual([
      MAX_CONSOLE_CHUNK_CODE_POINTS,
      MAX_CONSOLE_CHUNK_CODE_POINTS,
      3
    ])
    expect(chunks.join('')).toBe(text)
    expect(boundedChunks('')).toEqual([])
  })
})

describe('windowsTextWriteScript: the write into a console by pid', () => {
  it('[ADR-012] attaches to that pid and carries each chunk only as base64, then Enter in a call of its own', () => {
    const text = `it's "quoted" $(rm -rf) \`tick\` 🙂`
    const script = windowsTextWriteScript(4242, text)!
    expect(script).toContain('AttachConsole(4242)')
    expect(script).toContain(utf16(text))
    expect(script).toContain(utf16('\r'))
    expect(script).not.toContain('quoted')
    expect(script).not.toContain('rm -rf')
    expect(script.match(/WriteConsoleInputW\(\$conin/g)).toHaveLength(2)
    expect(script.indexOf(utf16(text))).toBeLessThan(script.indexOf(utf16('\r')))
  })

  it('[ADR-012] a long text is one call per bounded chunk, then the Enter call', () => {
    const text = 'a'.repeat(MAX_CONSOLE_CHUNK_CODE_POINTS * 2 + 1)
    const script = windowsTextWriteScript(7, text)!
    expect(script.match(/WriteConsoleInputW\(\$conin/g)).toHaveLength(4)
  })

  it('[ADR-012] runs no cmdlet and compiles nothing (a fresh user has no module cache)', () => {
    const script = windowsTextWriteScript(7, 'dig')!
    for (const cmdlet of ['Add-Type', 'New-Object', 'Start-Sleep']) {
      expect(script).not.toContain(cmdlet)
    }
    expect(script).toContain("$PSModuleAutoLoadingPreference = 'None'")
  })

  it('[ADR-014] a pid that cannot name a process, or no text, builds no script', () => {
    for (const pid of [0, -1, 1.5, Number.NaN])
      expect(windowsTextWriteScript(pid, 'dig')).toBeNull()
    expect(windowsTextWriteScript(7, '')).toBeNull()
  })
})

describe('tmux and Terminal.app: the text as data, never a command line', () => {
  it('[ADR-012] tmux loads the text into its own named buffer from stdin, pastes it bracketed into that pane only, then submits', () => {
    expect(tmuxLoadBufferArgs()).toEqual(['load-buffer', '-b', TMUX_BUFFER_NAME, '-'])
    expect(tmuxPasteArgs('%7')).toEqual([
      'paste-buffer',
      '-p',
      '-d',
      '-b',
      TMUX_BUFFER_NAME,
      '-t',
      '%7'
    ])
    expect(tmuxSubmitArgs('%7')).toEqual(['send-keys', '-t', '%7', 'Enter'])
    for (const pane of ['7', '%7;kill', '', '%']) {
      expect(tmuxPasteArgs(pane)).toBeNull()
      expect(tmuxSubmitArgs(pane)).toBeNull()
    }
  })

  it('[ADR-012] Terminal.app gets the tty and the text as arguments of a fixed script that submits in a second call', () => {
    const text = 'dig "here" \\ now'
    const args = terminalTabTextArgs('/dev/ttys004', text)!
    expect(args).toHaveLength(4)
    expect(args[0]).toBe('-e')
    expect(args.slice(2)).toEqual(['/dev/ttys004', text])
    expect(args[1]).not.toContain('dig')
    expect(args[1]).toContain('do script payloadText in t')
    expect(args[1]).toContain('do script "" in t')
    expect(terminalTabTextArgs('ttys004', text)).toBeNull()
    expect(terminalTabTextArgs('/dev/ttys004', '')).toBeNull()
  })
})
