// outputTail (15 §4.11, ISSUE-157): the captured stream of an "Other…" command as log entries,
// keyed by byte offset and bounded (06 MessageText), the same keys however the pipe chunked it
// and whether the program ended its lines in LF or CRLF (15 §1.5, C-19, HO-37).
import { describe, expect, it } from 'vitest'
import { logEntry, MAX_ENTRY_BYTES, OutputTail } from './outputTail'

function lines(tail: OutputTail, chunks: readonly (string | Buffer)[]): [number, string][] {
  return [...chunks.flatMap((chunk) => tail.push(chunk)), ...tail.flush()].map((line) => [
    line.offset,
    line.text
  ])
}

describe('OutputTail', () => {
  it('[C-19] lines are keyed by their byte offset whatever the chunking', () => {
    const text = 'first line\n\nsecond line\nlast'
    const whole = lines(new OutputTail('stdout'), [text])
    expect(whole).toEqual([
      [0, 'first line'],
      [12, 'second line'],
      [24, 'last']
    ])
    expect(lines(new OutputTail('stdout'), [...text])).toEqual(whole)
  })

  it('[C-19] CRLF line ends key and read exactly like LF, even with the CR and LF in two chunks', () => {
    const lf = lines(new OutputTail('stdout'), ['one\ntwo\n'])
    expect(lines(new OutputTail('stdout'), ['one\r', '\ntwo\r\n'])).toEqual(lf)
  })

  it('[C-19] a multi-byte character split across chunks is decoded whole and counted in bytes', () => {
    const bytes = Buffer.from('é!\nnext\n', 'utf8')
    expect(lines(new OutputTail('stdout'), [bytes.subarray(0, 1), bytes.subarray(1)])).toEqual([
      [0, 'é!'],
      [4, 'next']
    ])
  })

  it('[C-05] a line longer than the entry bound is cut into bounded pieces at their own offsets', () => {
    const long = 'x'.repeat(MAX_ENTRY_BYTES + 10)
    const out = new OutputTail('stdout').push(`${long}\n`)
    expect(out.map((line) => [line.offset, line.text.length])).toEqual([
      [0, MAX_ENTRY_BYTES],
      [MAX_ENTRY_BYTES, 10]
    ])
    const open = new OutputTail('stdout').push(long)
    expect(open.map((line) => line.text.length)).toEqual([MAX_ENTRY_BYTES])
  })

  it('[C-05] stdout is a dwarf message and stderr a redacted activity step of the open turn', () => {
    // The redaction rule is bound by wiring (05 R9); a marker shows the summary goes through it.
    const redact = (text: string): string => text.replace('secret', '[redacted]')
    const context = { streamId: 'other:launch-1', turnKey: 'turn-key', at: 5, redact }
    expect(logEntry({ stream: 'stdout', offset: 7, text: 'done secret' }, context)).toEqual({
      t: 'message',
      record: {
        sourceKey: 'other:other:launch-1:stdout@7',
        role: 'dwarf',
        text: 'done secret',
        providerTime: null
      }
    })
    expect(logEntry({ stream: 'stderr', offset: 0, text: 'token secret' }, context)).toEqual({
      t: 'activity',
      step: {
        sourceKey: 'other:other:launch-1:stderr@0',
        turnKey: 'turn-key',
        kind: 'other',
        summary: 'token [redacted]',
        state: 'finished',
        at: 5
      }
    })
  })
})
