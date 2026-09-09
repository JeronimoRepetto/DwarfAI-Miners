import { describe, expect, it } from 'vitest'
import { EXTERNAL_LINK_REFUSED_REASON, parseExternalLinkRequest } from './openExternalLink'

/**
 * The boundary a bubble's link crosses (#347).
 *
 * Pure and Electron-free, exactly like `openMineFile.ts` beside it:
 * `shell.openExternal` is `index.ts`'s, and this module only decides whether
 * the call is safe to make at all. Which is why every branch below is a plain
 * assertion with no display and no browser anywhere near it.
 */

describe('parseExternalLinkRequest', () => {
  it('reads an http address a renderer asked for', () => {
    expect(parseExternalLinkRequest('http://example.test/page')).toBe('http://example.test/page')
  })

  it('reads an https one', () => {
    expect(parseExternalLinkRequest('https://example.test/page')).toBe('https://example.test/page')
  })

  /*
   * The renderer already refused these before drawing anything (see
   * shared/externalLink), and main refuses them AGAIN here. Not redundancy: a
   * renderer's word is never a permission, and this handler is reachable by
   * anything holding the bridge.
   */
  it.each([
    ['javascript:alert(1)', 'script in a scheme'],
    ['data:text/html,<script>alert(1)</script>', 'a document smuggled in a data URI'],
    ['file:///etc/passwd', 'a local file, which is the other channel entirely'],
    ['./relative', 'not an address'],
    ['', 'nothing']
  ])('refuses %s (%s)', (payload) => {
    expect(parseExternalLinkRequest(payload)).toBeNull()
  })

  /*
   * The same discipline every channel in `index.ts` holds: a payload that is
   * not the shape this channel takes is refused outright rather than coerced
   * into something that could still mean an action.
   */
  it.each<[unknown, string]>([
    [42, 'a number'],
    [null, 'null'],
    [undefined, 'nothing at all'],
    [{ url: 'https://example.test' }, 'an object wearing the address'],
    [['https://example.test'], 'a list of one']
  ])('refuses %s (%s), because it is not a string', (payload) => {
    expect(parseExternalLinkRequest(payload)).toBeNull()
  })

  /*
   * ONE sentence, unlike #279's three. That issue could tell a person something
   * useful — outside the mine, gone, or unopenable — because it was resolving a
   * path they could see. Here there is nothing useful to distinguish: an
   * address that is not the web and an address the OS would not take are the
   * same fact to a reader, and inventing a difference would say more about the
   * machine than about the link.
   */
  it('has one fixed refusal, written by this app rather than by the platform', () => {
    expect(EXTERNAL_LINK_REFUSED_REASON).toBe('That link could not be opened.')
  })
})
