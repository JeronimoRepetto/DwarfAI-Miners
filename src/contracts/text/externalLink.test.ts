import { describe, expect, it } from 'vitest'
import { MAX_EXTERNAL_LINK_CHARS, externalLinkOf } from './externalLink'

/*
 * The one rule both processes hold (#347). The renderer asks it whether to draw
 * a link at all, and MAIN asks it again before handing anything to
 * `shell.openExternal` — so every case below is asserted once here rather than
 * twice, and neither side can drift into admitting something the other refuses.
 */

describe('externalLinkOf', () => {
  it.each([
    ['http://example.test/page', 'a plain http address'],
    ['https://example.test/page?q=1#top', 'an https address with a query and a fragment'],
    ['HTTPS://EXAMPLE.TEST/', 'an uppercase scheme, which is the same scheme']
  ])('admits %s (%s)', (raw) => {
    expect(externalLinkOf(raw)).toBe(raw)
  })

  /*
   * The whole point of the pair. A transcript is untrusted text: it is written
   * by a model, and before that by whatever the model read. Anything that is
   * not the web is refused, and the caller draws the link's own words instead.
   */
  it.each([
    ['javascript:alert(1)', 'script in a scheme'],
    ['JavaScript:alert(1)', 'the same, shouted'],
    // The URL parser strips tabs and newlines before it reads the scheme, so a
    // split scheme is the same scheme and must be refused as one.
    ['java\nscript:alert(1)', 'a scheme split across a newline'],
    ['java\tscript:alert(1)', 'a scheme split across a tab'],
    ['  javascript:alert(1)', 'a scheme behind leading whitespace'],
    ['vbscript:msgbox(1)', 'the other scripting scheme'],
    ['data:text/html,<script>alert(1)</script>', 'a document smuggled in a data URI'],
    ['file:///etc/passwd', 'a local file'],
    ['./notes.md', 'a relative path, which is not an address at all'],
    ['/absolute/path', 'an absolute path, likewise'],
    ['', 'nothing']
  ])('refuses %s (%s)', (raw) => {
    expect(externalLinkOf(raw)).toBeNull()
  })

  it('admits an address exactly at the length bound', () => {
    const url = `https://example.test/${'a'.repeat(MAX_EXTERNAL_LINK_CHARS - 21)}`
    expect(url).toHaveLength(MAX_EXTERNAL_LINK_CHARS)
    expect(externalLinkOf(url)).toBe(url)
  })

  /*
   * A bound rather than none: a bubble's text is unbounded, and an address is
   * the one thing here that leaves this process for another program.
   */
  it('refuses one character past it', () => {
    const url = `https://example.test/${'a'.repeat(MAX_EXTERNAL_LINK_CHARS - 20)}`
    expect(url).toHaveLength(MAX_EXTERNAL_LINK_CHARS + 1)
    expect(externalLinkOf(url)).toBeNull()
  })

  /*
   * The raw string comes back, never the parser's canonical form: what the
   * renderer shows on hover and what main opens have to be the same characters,
   * and `new URL('http://x.test').href` is already not what was written.
   */
  it('answers with the address as it was written', () => {
    expect(externalLinkOf('http://example.test')).toBe('http://example.test')
  })
})
