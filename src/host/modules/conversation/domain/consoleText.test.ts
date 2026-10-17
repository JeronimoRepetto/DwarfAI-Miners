// layer: L1
// The console normalization of a message (spike S-022-1): what a terminal relay types, and so what
// the transcript records for a relayed message; the echo of a sent message is its text as sent
// (stream-json) or this normalization of it (the console relay), with no further folding.
import { describe, expect, it } from 'vitest'
import { echoesSentText, normalizeConsoleText } from './consoleText'

describe('normalizeConsoleText', () => {
  it('[S-022-1] collapses every whitespace run, tab and line break to one space, then trims', () => {
    expect(normalizeConsoleText('  dig  here\tnow\r\nand\nthen   é ✓ 🙂 — ')).toBe(
      'dig here now and then é ✓ 🙂 —'
    )
    expect(normalizeConsoleText(' \r\n\t ')).toBe('')
  })
})

describe('echoesSentText', () => {
  it('[S-022-1] a record echoes a sent text when it equals it as sent or as the console relay typed it, nothing else', () => {
    const sent = 'dig  the\r\nnorth tunnel'
    expect(echoesSentText(sent, sent)).toBe(true)
    expect(echoesSentText('dig the north tunnel', sent)).toBe(true)
    expect(echoesSentText('dig the north tunnel ', sent)).toBe(false)
    expect(echoesSentText('Dig the north tunnel', sent)).toBe(false)
    expect(echoesSentText('dig the  north tunnel', sent)).toBe(false)
  })
})
