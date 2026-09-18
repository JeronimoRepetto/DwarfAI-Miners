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
    const command = buildTerminalTabWriteCommand('/dev/ttys001', 'hola mundo', true)
    expect(command?.command).toBe('osascript')
    // The script is a constant in `-e`; the two things that vary are argv, so
    // no user text is ever escaped into AppleScript source.
    expect(command?.args[0]).toBe('-e')
    expect(command?.args.slice(2)).toEqual(['/dev/ttys001', 'hola mundo'])
  })

  it('builds a script that matches a tab by tty and errors when none does', () => {
    const script = buildTerminalTabWriteCommand('/dev/ttys001', 'hi', true)?.args[1] ?? ''
    expect(script).toContain('on run argv')
    expect(script).toContain('tty of t is targetTty')
    expect(script).toContain('do script payloadText in t')
    expect(script).toContain('error')
  })

  // Nothing is escaped because nothing is interpolated: these characters are
  // exactly what closed an AppleScript literal in the keystroke path.
  it('carries quotes, backslashes and escapes through argv untouched', () => {
    const payload = '[200~/tmp/a b.png[201~"quoted" \\back \'single\' $HOME `tick`'
    expect(buildTerminalTabWriteCommand('/dev/ttys001', payload, true)?.args[3]).toBe(payload)
  })

  it.each(['', '   ', 'ttys001'])('refuses the unusable tty %p', (tty) => {
    expect(buildTerminalTabWriteCommand(tty, 'hi', true)).toBeNull()
  })

  /*
   * AMENDED for #367's submit fix. It was 'refuses an empty payload rather than
   * submitting a bare Return', asserting null — written when a bare Return was
   * only ever an accident. It is a SHAPE now: the Enter-only write, which is
   * what the second call of a message does on its own. The refusal for a
   * message with nothing in it did not go anywhere; it lives one level up, in
   * `terminalTabPayloadFor`, which is where "the person typed nothing" is
   * actually known. A builder cannot tell that from a deliberate Enter.
   */
  it('builds the Enter-only write from an empty payload', () => {
    expect(buildTerminalTabWriteCommand('/dev/ttys001', '', false)).not.toBeNull()
  })

  /*
   * #404, one to one, on the platform that had to learn it twice.
   *
   * A message written in ONE `do script` call landed in a live Claude Code
   * composer and was never submitted — measured from the panel on 2026-09-18,
   * and two consecutive messages concatenated there until the maintainer
   * pressed Enter by hand. Ink reads a multi-character chunk arriving in one
   * read as a PASTE, and inside a paste a carriage return is line content, not
   * a submit gesture. The raw-mode node reader this script was first measured
   * against has no such rule, which is exactly how the one-call shape looked
   * right on 2026-09-18.
   *
   * So the submit is the SECOND call, as on Windows. The delay between them is
   * only a margin against the two being coalesced into one read.
   *
   * AMENDED for the margin change: the pinned delay string was `delay 0.05`
   * and is `delay 0.2`. Pinned here rather than read off the constant, the way
   * `consoleInputWrite.test.ts` pins its own — a test that imported the value
   * would agree with any edit to it, including one nobody meant. The name and
   * every other assertion are untouched; what this proves is the ORDER (payload,
   * then the wait, then the submit), and only the literal moved.
   */
  const EXPECTED_SUBMIT_SPLIT_DELAY = 'delay 0.2'

  it('follows the payload with a second do script, so the Return is a submit and not paste content', () => {
    const script = buildTerminalTabWriteCommand('/dev/ttys001', 'hola mundo', true)?.args[1] ?? ''
    expect(script.match(/do script .* in t/g)).toHaveLength(2)
    expect(script).toContain('do script payloadText in t')
    expect(script).toContain('do script "" in t')
    const payloadCall = script.indexOf('do script payloadText in t')
    const delay = script.indexOf(EXPECTED_SUBMIT_SPLIT_DELAY)
    const submitCall = script.indexOf('do script "" in t')
    expect(delay).toBeGreaterThan(-1)
    expect(payloadCall).toBeLessThan(delay)
    expect(delay).toBeLessThan(submitCall)
  })

  // The Enter-only shape IS the submit, so a second one would be a second
  // Return into whatever the composer holds next.
  it('makes exactly one call when the payload is empty', () => {
    const script = buildTerminalTabWriteCommand('/dev/ttys001', '', false)?.args[1] ?? ''
    expect(script.match(/do script .* in t/g)).toHaveLength(1)
    expect(script).not.toContain('delay')
  })

  /*
   * Whether a second call follows is the CALLER's to state, not something the
   * builder infers from the payload (#471). A one-digit key answer is a
   * non-empty payload that must stay one call: it is read as a keystroke, not a
   * paste, so its own appended Return is the confirmation the dialog consumes.
   * Deriving `submits` from `payload !== ''` was right while a message was the
   * only caller and would press Return twice on a digit.
   */
  it('makes one call for a non-empty payload when the caller says it does not submit', () => {
    const script = buildTerminalTabWriteCommand('/dev/ttys001', '4', false)?.args[1] ?? ''
    expect(script.match(/do script .* in t/g)).toHaveLength(1)
    expect(script).toContain('do script payloadText in t')
    expect(script).not.toContain('do script "" in t')
    expect(script).not.toContain('delay')
  })

  it('refuses a payload past the argv bound rather than truncating somebody s words', () => {
    const payload = 'x'.repeat(MAX_TERMINAL_TAB_PAYLOAD_CODE_POINTS + 1)
    expect(buildTerminalTabWriteCommand('/dev/ttys001', payload, true)).toBeNull()
  })

  it('accepts a payload exactly at the bound', () => {
    const payload = 'x'.repeat(MAX_TERMINAL_TAB_PAYLOAD_CODE_POINTS)
    expect(buildTerminalTabWriteCommand('/dev/ttys001', payload, true)).not.toBeNull()
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
