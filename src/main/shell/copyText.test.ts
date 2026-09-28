import { describe, expect, it } from 'vitest'
import { MAX_DWARF_TEXT_CHARS } from '../domain/types'
import { copyTextToClipboard, parseCopyTextRequest, type ClipboardPort } from './copyText'

/**
 * Copy on a failed message (#635, decision log, Failed delivery): the words the person wrote, put
 * on the system clipboard by main. Pure and Electron-free, like `openExternalLink.ts` beside it:
 * Electron's `clipboard` is `index.ts`'s, handed in as the port, so every branch is a plain
 * assertion against a hand-written fake.
 */

/** A clipboard that remembers every write, so a refusal can be seen to have written nothing. */
function fakeClipboard(): ClipboardPort & { written: string[] } {
  const written: string[] = []
  return {
    written,
    writeText: (text) => {
      written.push(text)
    }
  }
}

describe('parseCopyTextRequest', () => {
  it('reads the message exactly as written, white space and line breaks included', () => {
    expect(parseCopyTextRequest('  Also check\nthat it sorts. ')).toBe(
      '  Also check\nthat it sorts. '
    )
  })

  it('reads a message as long as the longest one a route can carry', () => {
    const longest = 'x'.repeat(MAX_DWARF_TEXT_CHARS)
    expect(parseCopyTextRequest(longest)).toBe(longest)
  })

  /*
   * The same boundary every channel in `index.ts` holds: a payload that is not the shape this
   * channel takes is refused rather than coerced, and one past the largest message any route
   * carries is no message this app drew.
   */
  it.each<[unknown, string]>([
    ['', 'nothing to copy'],
    ['x'.repeat(MAX_DWARF_TEXT_CHARS + 1), 'past the largest message a route carries'],
    [42, 'a number'],
    [null, 'null'],
    [undefined, 'nothing at all'],
    [{ text: 'hi' }, 'an object wearing the text'],
    [['hi'], 'a list of one']
  ])('refuses %s (%s)', (payload) => {
    expect(parseCopyTextRequest(payload as never)).toBeNull()
  })
})

describe('copyTextToClipboard', () => {
  it('writes the text to the clipboard and says so', () => {
    const clipboard = fakeClipboard()
    expect(copyTextToClipboard('Also check that it sorts.', clipboard)).toEqual({ copied: true })
    expect(clipboard.written).toEqual(['Also check that it sorts.'])
  })

  it('writes nothing for a payload it refuses', () => {
    const clipboard = fakeClipboard()
    expect(copyTextToClipboard(42, clipboard)).toEqual({ copied: false })
    expect(clipboard.written).toEqual([])
  })

  it('answers not copied when the clipboard itself throws, rather than throwing across the bridge', () => {
    const clipboard: ClipboardPort = {
      writeText: () => {
        throw new Error('no clipboard owner')
      }
    }
    expect(copyTextToClipboard('hi', clipboard)).toEqual({ copied: false })
  })
})
