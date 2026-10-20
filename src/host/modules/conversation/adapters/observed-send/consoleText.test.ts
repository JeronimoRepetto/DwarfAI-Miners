// layer: L1
// The pure builders of the observed-session text relay (ADR-012 item 3; 15 §3.3; spike S-022-1):
// the text a terminal is handed is the console normalization of the message, bounded, and it
// travels as data — base64 on PowerShell's stdin, a tmux buffer read from stdin, or an osascript
// argument — never inside a script or a command line a shell would parse.
import { describe, expect, it } from 'vitest'
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  MAX_CONSOLE_CHUNK_CODE_POINTS,
  MAX_RELAY_TEXT_CODE_POINTS,
  TMUX_BUFFER_NAME,
  boundedChunks,
  pastedPathOf,
  relayPayloadOf,
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

/*
 * APPENDED for #1463: an observed Claude session's files, the way legacy measured them (#408,
 * `attachmentDelivery.ts` `consoleChunksFor`, the console-hosting research §6): each path inside
 * bracketed-paste markers, so the receiving CLI attaches it as if it were dropped on the terminal,
 * then the words, then Enter in a call of its own.
 */
describe('relayPayloadOf: the files and the words a terminal is handed', () => {
  it('[US-MSG-002.AC03] wraps each path in bracketed-paste markers, in the order sent, ahead of the relay text', () => {
    expect(BRACKETED_PASTE_START).toBe('\u001b[200~')
    expect(BRACKETED_PASTE_END).toBe('\u001b[201~')
    expect(relayPayloadOf(' look\n at  this ', ['C:\\work\\red.png', '/work/notes.txt'])).toEqual({
      pastes: ['\u001b[200~C:\\work\\red.png\u001b[201~', '\u001b[200~/work/notes.txt\u001b[201~'],
      words: 'look at this'
    })
  })

  it('[US-MSG-002.AC03] carries files with no words, and is nothing at all with neither', () => {
    expect(relayPayloadOf('  ', ['/work/red.png'])).toEqual({
      pastes: ['\u001b[200~/work/red.png\u001b[201~'],
      words: ''
    })
    expect(relayPayloadOf(' \n ', [])).toBeNull()
    expect(relayPayloadOf('dig', [])).toEqual({ pastes: [], words: 'dig' })
  })

  it('[ADR-012] refuses the whole message for a path a terminal cannot take whole: a control character, or past one chunk', () => {
    for (const path of [
      '/work/a\nb.png',
      '/work/a\rb.png',
      '/work/\u001b[201~x',
      '/work/\u0007.png'
    ]) {
      expect(pastedPathOf(path)).toBeNull()
      expect(relayPayloadOf('dig', ['/work/ok.png', path])).toBeNull()
    }
    const fits = `/${'p'.repeat(MAX_CONSOLE_CHUNK_CODE_POINTS - BRACKETED_PASTE_START.length - BRACKETED_PASTE_END.length - 1)}`
    expect(pastedPathOf(fits)).toBe(`${BRACKETED_PASTE_START}${fits}${BRACKETED_PASTE_END}`)
    expect(pastedPathOf(`${fits}p`)).toBeNull()
    expect(pastedPathOf('')).toBeNull()
  })

  it('[ADR-012] refuses a message whose files and words together pass the relay bound', () => {
    const paste = `${BRACKETED_PASTE_START}/work/a.png${BRACKETED_PASTE_END}`
    const words = 'x'.repeat(MAX_RELAY_TEXT_CODE_POINTS - paste.length)
    expect(relayPayloadOf(words, ['/work/a.png'])).toEqual({ pastes: [paste], words })
    expect(relayPayloadOf(words, ['/work/ab.png'])).toBeNull()
  })
})

describe('windowsTextWriteScript with files (#1463)', () => {
  it('[US-MSG-002.AC03] writes each paste in a call of its own, then the words, then Enter alone', () => {
    const paste = '\u001b[200~C:\\work\\red.png\u001b[201~'
    const script = windowsTextWriteScript(4242, 'look', [paste])!
    expect(script.match(/WriteConsoleInputW\(\$conin/g)).toHaveLength(3)
    expect(script).not.toContain('red.png')
    expect(script.indexOf(utf16(paste))).toBeGreaterThan(-1)
    expect(script.indexOf(utf16(paste))).toBeLessThan(script.indexOf(utf16('look')))
    expect(script.indexOf(utf16('look'))).toBeLessThan(script.indexOf(utf16('\r')))
  })

  it('[US-MSG-002.AC03] a message of files alone is the pastes and Enter, with no empty call', () => {
    const script = windowsTextWriteScript(7, '', ['\u001b[200~/a.png\u001b[201~'])!
    expect(script.match(/WriteConsoleInputW\(\$conin/g)).toHaveLength(2)
  })
})
