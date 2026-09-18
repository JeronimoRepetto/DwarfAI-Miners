import { describe, expect, it } from 'vitest'
import type { DwarfAttachment } from '../domain/types'
import {
  MAX_TERMINAL_TAB_PAYLOAD_CODE_POINTS,
  buildTerminalTabWriteCommand,
  terminalTabPayloadFor
} from './terminalTabWrite'

function attachment(path: string): DwarfAttachment {
  return { path, name: path.slice(path.lastIndexOf('/') + 1), kind: 'image', bytes: 1024 }
}

describe('buildTerminalTabWriteCommand', () => {
  it('hands the tty and the payload to osascript as ARGUMENTS', () => {
    const command = buildTerminalTabWriteCommand('/dev/ttys001', 'hola mundo')
    expect(command?.command).toBe('osascript')
    // The script is a constant in `-e`; the two things that vary are argv, so
    // no user text is ever escaped into AppleScript source.
    expect(command?.args[0]).toBe('-e')
    expect(command?.args.slice(2)).toEqual(['/dev/ttys001', 'hola mundo'])
  })

  it('builds a script that matches a tab by tty and errors when none does', () => {
    const script = buildTerminalTabWriteCommand('/dev/ttys001', 'hi')?.args[1] ?? ''
    expect(script).toContain('on run argv')
    expect(script).toContain('tty of t is targetTty')
    expect(script).toContain('do script payloadText in t')
    expect(script).toContain('error')
  })

  // Nothing is escaped because nothing is interpolated: these characters are
  // exactly what closed an AppleScript literal in the keystroke path.
  it('carries quotes, backslashes and escapes through argv untouched', () => {
    const payload = '[200~/tmp/a b.png[201~"quoted" \\back \'single\' $HOME `tick`'
    expect(buildTerminalTabWriteCommand('/dev/ttys001', payload)?.args[3]).toBe(payload)
  })

  it.each(['', '   ', 'ttys001'])('refuses the unusable tty %p', (tty) => {
    expect(buildTerminalTabWriteCommand(tty, 'hi')).toBeNull()
  })

  it('refuses an empty payload rather than submitting a bare Return', () => {
    expect(buildTerminalTabWriteCommand('/dev/ttys001', '')).toBeNull()
  })

  it('refuses a payload past the argv bound rather than truncating somebody s words', () => {
    const payload = 'x'.repeat(MAX_TERMINAL_TAB_PAYLOAD_CODE_POINTS + 1)
    expect(buildTerminalTabWriteCommand('/dev/ttys001', payload)).toBeNull()
  })

  it('accepts a payload exactly at the bound', () => {
    const payload = 'x'.repeat(MAX_TERMINAL_TAB_PAYLOAD_CODE_POINTS)
    expect(buildTerminalTabWriteCommand('/dev/ttys001', payload)).not.toBeNull()
  })
})

describe('terminalTabPayloadFor', () => {
  // `do script` appends exactly ONE carriage return, so everything that must
  // arrive before that Return has to be in the same call.
  it('joins the attachment pastes and the words into ONE payload', () => {
    expect(terminalTabPayloadFor('look at this', [attachment('/tmp/a b.png')])).toBe(
      '[200~/tmp/a b.png[201~look at this'
    )
  })

  it('carries a files-only message with no words after the paste', () => {
    expect(terminalTabPayloadFor('', [attachment('/tmp/shot.png')])).toBe('[200~/tmp/shot.png[201~')
  })

  it('carries a words-only message as the words alone', () => {
    expect(terminalTabPayloadFor('hola mundo', [])).toBe('hola mundo')
  })

  // Never an Enter chunk: the one `do script` appends is the whole submit, and
  // a `\r` in the payload would be a second line rather than a second submit.
  it('never appends a carriage return of its own', () => {
    expect(terminalTabPayloadFor('hola', [attachment('/tmp/a.png')])).not.toContain('\r')
  })

  it('refuses a path longer than a chunk may be, the way the console write does', () => {
    expect(terminalTabPayloadFor('hi', [attachment(`/tmp/${'p'.repeat(1000)}.png`)])).toBeNull()
  })

  it('refuses a message with nothing in it at all', () => {
    expect(terminalTabPayloadFor('   ', [])).toBeNull()
  })
})
