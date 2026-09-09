// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import MarkdownBubble from './MarkdownBubble.vue'

/*
 * `lib/message/markdown` already pins what the transcript MEANS (#347). What
 * only a mounted component can prove is the other half of the safety claim:
 * that the tree becomes real elements built with `h()`, and that no step
 * between here and the screen turns characters back into markup.
 *
 * So these tests read the DOM. A tree assertion could not tell a `<strong>`
 * element from a string that says `<strong>`, and that difference is the whole
 * subject.
 */

function bubble(text: string) {
  return mount(MarkdownBubble, { props: { text } })
}

describe('the constructs a bubble draws', () => {
  it('draws bold as a strong element, with the delimiters gone', () => {
    const wrapper = bubble('**Done**')
    expect(wrapper.find('strong').text()).toBe('Done')
    expect(wrapper.text()).not.toContain('*')
  })

  it('draws emphasis as an em element', () => {
    expect(bubble('_maybe_').find('em').text()).toBe('maybe')
  })

  it('draws a bulleted list as a ul of li', () => {
    const wrapper = bubble('- one\n- two')
    expect(wrapper.findAll('ul > li')).toHaveLength(2)
    expect(wrapper.text()).not.toContain('-')
  })

  it('draws a numbered list as an ol', () => {
    expect(bubble('1. one\n2. two').findAll('ol > li')).toHaveLength(2)
  })

  it('draws a block quote as a blockquote', () => {
    expect(bubble('> quoted').find('blockquote').text()).toBe('quoted')
  })

  it('draws inline code as a code element, with the backticks gone', () => {
    const wrapper = bubble('run `pnpm test` first')
    expect(wrapper.find('code').text()).toBe('pnpm test')
    expect(wrapper.text()).toBe('run pnpm test first')
  })

  /*
   * The narrow panel is the whole reason a fenced block gets its own treatment:
   * a long line must scroll INSIDE the bubble rather than widen it, so the
   * conversation column never gains a horizontal scrollbar of its own.
   */
  it('draws a fenced block as a pre that scrolls on its own', () => {
    const wrapper = bubble('```\nconst a = 1\n```')
    const pre = wrapper.find('pre')
    expect(pre.exists()).toBe(true)
    expect(pre.text()).toBe('const a = 1')
    expect(pre.attributes('class')).toContain('markdown-block-code')
  })

  it('names a fenced block language as a class and nothing else', () => {
    expect(bubble('```ts\nconst a = 1\n```').find('pre code').classes()).toContain('language-ts')
  })

  /*
   * A bubble is not a page. The design draws a heading as a bold paragraph, so
   * no heading element may reach the DOM at any level.
   */
  it.each(['# Title', '### Title'])('draws %s as a bold paragraph, never a heading', (source) => {
    const wrapper = bubble(source)
    expect(wrapper.find('h1, h2, h3, h4, h5, h6').exists()).toBe(false)
    expect(wrapper.find('p strong').text()).toBe('Title')
  })
})

describe('links', () => {
  it('shows the words and reveals the address on hover', () => {
    const link = bubble('[the issue](https://example.test/347)').find('.markdown-link')
    expect(link.text()).toBe('the issue')
    expect(link.attributes('title')).toBe('https://example.test/347')
  })

  /*
   * A button, not an anchor — the pattern #279 established for this panel. An
   * anchor with an href is a navigation this window could actually perform, and
   * a renderer that can navigate is a renderer that can be navigated.
   */
  it('is a button, so the panel cannot be navigated away from', () => {
    const link = bubble('[the issue](https://example.test/347)').find('.markdown-link')
    expect(link.element.tagName).toBe('BUTTON')
    expect(link.attributes('href')).toBeUndefined()
  })

  it('reports the address it was pressed on, and never opens anything itself', async () => {
    const wrapper = bubble('[the issue](https://example.test/347)')
    await wrapper.find('.markdown-link').trigger('click')
    expect(wrapper.emitted('open-link')).toEqual([['https://example.test/347']])
  })

  it('draws a refused address as its own words, with no control at all', () => {
    const wrapper = bubble('[click me](javascript:alert(1))')
    expect(wrapper.find('.markdown-link').exists()).toBe(false)
    expect(wrapper.text()).toContain('click me')
  })
})

/*
 * The security regression the issue asks for. Every one of these is a payload a
 * transcript could carry: an agent that read a hostile README, a tool that
 * echoed a page back. None of them may become an element.
 */
describe('a hostile transcript', () => {
  const HOSTILE = [
    '<script>alert(1)</script>',
    '',
    '<img src=x onerror="alert(1)">',
    '',
    '<iframe src="https://example.test"></iframe>',
    '',
    '[press me](javascript:alert(1))',
    '',
    '<!-- a comment -->',
    '',
    '<div onclick="alert(1)">not a div</div>'
  ].join('\n')

  // Searched from the root DOWN, never including it: the component's own root
  // is a div, and the question is whether the transcript grew one.
  it.each(['script', 'img', 'iframe', 'div', 'a'])('grows no %s element', (tag) => {
    expect(bubble(HOSTILE).element.querySelectorAll(tag)).toHaveLength(0)
  })

  it('binds no handler a payload asked for', () => {
    const wrapper = bubble(HOSTILE)
    for (const element of wrapper.element.querySelectorAll('*')) {
      expect(element.getAttributeNames()).not.toContain('onerror')
      expect(element.getAttributeNames()).not.toContain('onclick')
      expect(element.getAttributeNames()).not.toContain('onload')
    }
  })

  it('escapes the markup instead of parsing it', () => {
    expect(bubble(HOSTILE).html()).toContain('&lt;script&gt;')
  })

  it('shows every payload as the characters it is, losing none of them', () => {
    const shown = bubble(HOSTILE).text()
    expect(shown).toContain('<script>alert(1)</script>')
    expect(shown).toContain('<img src=x onerror="alert(1)">')
    expect(shown).toContain('<!-- a comment -->')
    expect(shown).toContain('press me')
  })

  /*
   * An HTML comment is the one payload that could disappear without anybody
   * noticing: it draws as nothing if it is ever parsed, so its presence in the
   * text is the proof it was not.
   */
  it('leaves no comment node behind', () => {
    const wrapper = bubble('<!-- a comment -->')
    const walker = document.createTreeWalker(wrapper.element, NodeFilter.SHOW_COMMENT)
    expect(walker.nextNode()).toBeNull()
  })
})

describe('plain text, which must look exactly as it did', () => {
  it('draws a sentence as one paragraph', () => {
    const wrapper = bubble('Found the seam.')
    expect(wrapper.findAll('p')).toHaveLength(1)
    expect(wrapper.text()).toBe('Found the seam.')
  })

  /*
   * The bubble held `white-space: pre-wrap` over the raw text before this
   * component existed, so a transcript's own line breaks were visible. The
   * paragraph carries the newline and the class that makes it show.
   */
  it("keeps a line break, as the bubble's pre-wrap did", () => {
    const wrapper = bubble('first\nsecond')
    expect(wrapper.findAll('p')).toHaveLength(1)
    expect(wrapper.find('p').text()).toBe('first\nsecond')
    expect(wrapper.find('p').classes()).toContain('markdown-paragraph')
  })

  it('draws nothing at all for an empty message', () => {
    expect(bubble('').text()).toBe('')
  })
})
