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

/*
 * APPENDED for #1463: the transcript row of a message relayed with files carries Claude Code's own
 * token for each one — `[Image #N]` for an image, the pasted path itself for any other file — in
 * whatever order the CLI finished reading them, run together with the words (the shapes the
 * renderer's echo reconciliation was measured against: `src/renderer/src/lib/message/echo.ts`
 * `expectedTokensFor` / `stripAttachmentTokens`, #408, #419; `echo.test.ts` rows such as
 * '[Image #2]C:\mine\debris.mp3[Image #3]C:\mine\notes.pdfC:\mine\config.txtdig deeper').
 */
describe('echoesSentText with files (#1463)', () => {
  const SHOT = { path: 'C:\\mine\\shot.png', name: 'shot.png' }
  const NOTES = { path: 'C:\\mine\\notes.pdf', name: 'notes.pdf' }

  it('[US-MSG-002.AC03, INV-62] a row carrying an image placeholder and the typed words echoes the send with that image', () => {
    expect(echoesSentText('[Image #1] dig  deeper', 'dig deeper', [SHOT])).toBe(true)
    expect(echoesSentText('[Image #12]dig deeper', 'dig\r\ndeeper', [SHOT])).toBe(true)
    expect(echoesSentText('dig deeper[Image #7]', 'dig deeper', [SHOT])).toBe(true)
  })

  it('[US-MSG-002.AC03] each file token is taken off once, wherever it landed, and only the words are left to compare', () => {
    const row = 'C:\\mine\\notes.pdf[Image #5]dig deeper'
    expect(echoesSentText(row, 'dig deeper', [SHOT, NOTES])).toBe(true)
    expect(
      echoesSentText('[Image #5]C:\\mine\\notes.pdfdig deeper', 'dig deeper', [NOTES, SHOT])
    ).toBe(true)
    expect(echoesSentText('[Image #5]', '', [SHOT])).toBe(true)
  })

  it('[US-MSG-002.AC03] different words, a missing token, or a token too many is another message', () => {
    expect(echoesSentText('[Image #1] dig higher', 'dig deeper', [SHOT])).toBe(false)
    expect(echoesSentText('dig deeper', 'dig deeper', [SHOT])).toBe(false)
    expect(echoesSentText('[Image #1]dig deeper', 'dig deeper', [SHOT, NOTES])).toBe(false)
    expect(echoesSentText('[Image #1][Image #2]dig deeper', 'dig deeper', [SHOT])).toBe(false)
    expect(echoesSentText('C:\\mine\\other.pdfdig deeper', 'dig deeper', [NOTES])).toBe(false)
  })

  it('[US-MSG-002.AC03] a path that itself looks like a placeholder is taken off whole, before any placeholder is searched', () => {
    const odd = { path: 'C:\\mine\\shot[Image #5].txt', name: 'shot[Image #5].txt' }
    expect(echoesSentText('C:\\mine\\shot[Image #5].txt[Image #9]dig', 'dig', [odd, SHOT])).toBe(
      true
    )
  })
})
