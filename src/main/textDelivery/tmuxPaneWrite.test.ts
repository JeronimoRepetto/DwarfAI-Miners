import { describe, expect, it } from 'vitest'
import {
  MAX_TMUX_PAYLOAD_CODE_POINTS,
  TMUX_BUFFER_NAME,
  TMUX_NOT_RUNNING,
  TMUX_NO_PANE_FOR_TTY,
  TMUX_SUBMIT_SPLIT_DELAY_MS,
  buildTmuxKeyCommand,
  buildTmuxListPanesCommand,
  buildTmuxLoadBufferCommand,
  buildTmuxPasteBufferCommand,
  buildTmuxSubmitCommand,
  parseTmuxPanes,
  selectTmuxPaneId,
  tmuxPaneReachFor
} from './tmuxPaneWrite'

/** The exact shape `-F '#{pane_id} #{pane_tty} #{pane_pid}'` prints. */
const PANES = ['%0 /dev/pts/1 4321', '%3 /dev/pts/4 9876', '%12 /dev/pts/9 5150'].join('\n')

describe('buildTmuxListPanesCommand', () => {
  it('asks every pane in every session for its id, tty and pid', () => {
    expect(buildTmuxListPanesCommand()).toEqual({
      command: 'tmux',
      args: ['list-panes', '-a', '-F', '#{pane_id} #{pane_tty} #{pane_pid}']
    })
  })
})

describe('parseTmuxPanes', () => {
  it('reads every pane row', () => {
    expect(parseTmuxPanes(`${PANES}\n`)).toEqual([
      { paneId: '%0', tty: '/dev/pts/1', pid: 4321 },
      { paneId: '%3', tty: '/dev/pts/4', pid: 9876 },
      { paneId: '%12', tty: '/dev/pts/9', pid: 5150 }
    ])
  })

  // Skipped rather than thrown on, the way parseUnixProcessRows already does:
  // one unreadable row must not cost the panes beside it.
  it.each(['', '\n', 'not a pane row\n', '%0 /dev/pts/1\n', 'x /dev/pts/1 4321\n'])(
    'skips what it cannot read in %p',
    (stdout) => {
      expect(parseTmuxPanes(stdout)).toEqual([])
    }
  )

  it('keeps the readable rows beside an unreadable one', () => {
    expect(parseTmuxPanes(`junk\n%3 /dev/pts/4 9876\n`)).toEqual([
      { paneId: '%3', tty: '/dev/pts/4', pid: 9876 }
    ])
  })
})

describe('selectTmuxPaneId', () => {
  it('finds the pane on that tty', () => {
    expect(selectTmuxPaneId(parseTmuxPanes(PANES), '/dev/pts/4')).toBe('%3')
  })

  it('answers null for a tty no pane is on', () => {
    expect(selectTmuxPaneId(parseTmuxPanes(PANES), '/dev/pts/7')).toBeNull()
  })

  it('answers null for no panes at all', () => {
    expect(selectTmuxPaneId([], '/dev/pts/4')).toBeNull()
  })
})

describe('tmuxPaneReachFor', () => {
  it('reaches its own console for a matched pane', () => {
    expect(tmuxPaneReachFor('/dev/pts/4', parseTmuxPanes(PANES))).toEqual({
      reach: 'own-console',
      paneId: '%3'
    })
  })

  it('refuses a tty no pane carries, and names the reason', () => {
    expect(tmuxPaneReachFor('/dev/pts/7', parseTmuxPanes(PANES))).toEqual({
      reach: 'terminal-host',
      error: TMUX_NO_PANE_FOR_TTY
    })
  })

  it('refuses a session with no tty at all', () => {
    expect(tmuxPaneReachFor(null, parseTmuxPanes(PANES))).toEqual({
      reach: 'terminal-host',
      error: TMUX_NO_PANE_FOR_TTY
    })
  })

  // No panes at all is tmux not running, which is a different thing to tell the
  // person than "your session is not in one of its panes".
  it('names tmux itself when there are no panes at all', () => {
    expect(tmuxPaneReachFor('/dev/pts/4', [])).toEqual({
      reach: 'terminal-host',
      error: TMUX_NOT_RUNNING
    })
  })
})

describe('buildTmuxLoadBufferCommand', () => {
  it('puts the payload on STDIN, never on the argv', () => {
    const command = buildTmuxLoadBufferCommand('hola mundo')
    expect(command).toEqual({
      command: 'tmux',
      args: ['load-buffer', '-b', TMUX_BUFFER_NAME, '-'],
      stdin: 'hola mundo'
    })
    expect(command?.args).not.toContain('hola mundo')
  })

  // Nothing is escaped because nothing is interpolated, exactly as the darwin
  // tab write carries its payload through argv rather than through a literal.
  it('carries quotes, backslashes and escapes untouched', () => {
    const payload = '[200~/tmp/a b.png[201~"quoted" \\back $HOME `tick`'
    expect(buildTmuxLoadBufferCommand(payload)?.stdin).toBe(payload)
  })

  it('refuses an empty payload rather than pasting nothing', () => {
    expect(buildTmuxLoadBufferCommand('')).toBeNull()
  })

  it('refuses a payload past the bound', () => {
    expect(buildTmuxLoadBufferCommand('x'.repeat(MAX_TMUX_PAYLOAD_CODE_POINTS + 1))).toBeNull()
  })
})

describe('buildTmuxPasteBufferCommand', () => {
  it('pastes into the pane as a BRACKETED paste, and deletes the buffer after', () => {
    expect(buildTmuxPasteBufferCommand('%3')).toEqual({
      command: 'tmux',
      args: ['paste-buffer', '-p', '-d', '-b', TMUX_BUFFER_NAME, '-t', '%3']
    })
  })

  it.each(['', '3', 'pane', '%', '%3; rm -rf /', '%-1'])(
    'refuses the unusable pane id %p',
    (paneId) => {
      expect(buildTmuxPasteBufferCommand(paneId)).toBeNull()
    }
  )
})

describe('buildTmuxSubmitCommand', () => {
  // #404 and #485: the submit is a SEPARATE write. A paste carrying its own
  // carriage return is line content to a TUI, never a submit gesture.
  it('sends Enter as a key in its own call', () => {
    expect(buildTmuxSubmitCommand('%3')).toEqual({
      command: 'tmux',
      args: ['send-keys', '-t', '%3', 'Enter']
    })
  })

  it('refuses an unusable pane id', () => {
    expect(buildTmuxSubmitCommand('nope')).toBeNull()
  })

  it('keeps a margin between the paste and the Enter, the size darwin settled on', () => {
    expect(TMUX_SUBMIT_SPLIT_DELAY_MS).toBe(200)
  })
})

describe('buildTmuxKeyCommand', () => {
  // `-l` sends the digit LITERALLY, so tmux cannot read it as a key name, and
  // no Enter follows it: the digit fires its row by itself.
  it('sends one digit literally, with no Enter behind it', () => {
    expect(buildTmuxKeyCommand('%3', '4')).toEqual({
      command: 'tmux',
      args: ['send-keys', '-t', '%3', '-l', '4']
    })
  })

  it.each(['', '12', '0', 'a', 'Enter', ''])('refuses the key %p', (key) => {
    expect(buildTmuxKeyCommand('%3', key)).toBeNull()
  })

  it('refuses an unusable pane id', () => {
    expect(buildTmuxKeyCommand('nope', '4')).toBeNull()
  })
})
