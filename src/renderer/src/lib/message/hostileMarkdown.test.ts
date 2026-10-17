// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import MarkdownBubble from '../../components/message/MarkdownBubble.vue'
import corpus from './__fixtures__/hostile-markdown.json'
import { markdownBlocks, type MarkdownBlock, type MarkdownInline } from './markdown'

/*
 * C-04 (18 §5.1, §6): whatever a provider writes stays data. The corpus is
 * hostile Markdown written by hand from ADR-019 item 4; every case is mounted
 * through the real bubble and its DOM is read, because only the DOM can tell an
 * element from characters that spell one.
 *
 * Two halves are asserted for every case. Nothing outside the closed tree's
 * elements and attributes exists, AND the hostile characters are still on the
 * screen as text: dropping raw HTML would also produce a clean DOM, but it would
 * silently change what the message says, and it is exactly what a parser with
 * raw HTML switched on does before a later step turns it back into markup.
 */

interface CorpusCase {
  id: string
  markdown: string
  shows: string
}

/** Every element `MarkdownBubble` builds from the closed tree, and nothing else. */
const CLOSED_TREE_ELEMENTS = new Set([
  'div',
  'p',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'code',
  'em',
  'strong',
  's',
  'button',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'hr'
])

/** Every attribute the bubble sets itself. An `on*` handler or an `href`/`src` is never one. */
const CLOSED_TREE_ATTRIBUTES = new Set(['class', 'type', 'title', 'style'])

/** Vue's own scoped-style marker: an empty attribute the compiler adds, never provider text. */
const SCOPED_STYLE_MARKER = /^data-v-[0-9a-f]{8}$/

function isClosedTreeAttribute(attribute: Attr): boolean {
  if (CLOSED_TREE_ATTRIBUTES.has(attribute.name)) return true
  return SCOPED_STYLE_MARKER.test(attribute.name) && attribute.value === ''
}

/** The closed tree's node kinds, as `markdown.ts` declares them. */
const BLOCK_KINDS = new Set(['paragraph', 'list', 'quote', 'codeBlock', 'table', 'rule'])
const INLINE_KINDS = new Set(['text', 'code', 'emphasis', 'strong', 'strikethrough', 'link'])

function bubble(markdown: string) {
  return mount(MarkdownBubble, { props: { text: markdown } })
}

/** Every element below the bubble's root, the root included. */
function elementsOf(root: Element): Element[] {
  return [root, ...Array.from(root.querySelectorAll('*'))]
}

/** What does not belong to the closed tree, named so a failure says which. */
function foreignParts(root: Element): string[] {
  const found: string[] = []
  for (const element of elementsOf(root)) {
    const tag = element.tagName.toLowerCase()
    if (!CLOSED_TREE_ELEMENTS.has(tag)) found.push(`element <${tag}>`)
    for (const attribute of Array.from(element.attributes)) {
      if (!isClosedTreeAttribute(attribute)) {
        found.push(`attribute ${attribute.name} on <${tag}>`)
      }
    }
  }
  return found
}

/** Every inline and block node kind in a tree, so an unknown shape cannot hide in it. */
function kindsOf(blocks: readonly MarkdownBlock[]): string[] {
  const kinds: string[] = []
  const inlines = (nodes: readonly MarkdownInline[]): void => {
    for (const node of nodes) {
      kinds.push(node.kind)
      if ('children' in node) inlines(node.children)
    }
  }
  for (const block of blocks) {
    kinds.push(block.kind)
    switch (block.kind) {
      case 'paragraph':
        inlines(block.children)
        break
      case 'list':
        for (const item of block.items) kinds.push(...kindsOf(item.blocks))
        break
      case 'quote':
        kinds.push(...kindsOf(block.blocks))
        break
      case 'table':
        for (const cell of [...block.header, ...block.rows.flat()]) inlines(cell.children)
        break
      default:
        break
    }
  }
  return kinds
}

const markupCases: readonly CorpusCase[] = corpus.markup
const imageCases: readonly CorpusCase[] = corpus.images
const unsafeLinkCases: readonly CorpusCase[] = corpus.unsafeLinks

describe('C-04 provider text stays data (ADR-019 item 4)', () => {
  it('[ADR-019, NFR-SEC-07] a hostile markdown corpus renders as a closed tree: no script, no event-handler attribute and no raw HTML element', () => {
    for (const hostile of markupCases) {
      const wrapper = bubble(hostile.markdown)
      const root = wrapper.element as Element
      const tree = markdownBlocks(hostile.markdown)

      expect(foreignParts(root), `${hostile.id}: DOM outside the closed tree`).toEqual([])
      expect(
        kindsOf(tree).filter((kind) => !BLOCK_KINDS.has(kind) && !INLINE_KINDS.has(kind)),
        `${hostile.id}: node kind outside the closed tree`
      ).toEqual([])
      expect(root.textContent, `${hostile.id}: hostile markup must stay visible as text`).toContain(
        hostile.shows
      )
      wrapper.unmount()
    }
  })

  it('[ADR-019] a transcript image renders as its alt text and never as an img element, so nothing is fetched', () => {
    for (const image of imageCases) {
      const wrapper = bubble(image.markdown)
      const root = wrapper.element as Element

      expect(
        root.querySelectorAll('img, picture, source, video, audio, object, embed').length
      ).toBe(0)
      expect(foreignParts(root), `${image.id}: DOM outside the closed tree`).toEqual([])
      expect(root.textContent, `${image.id}: the alt text is what is drawn`).toBe(image.shows)
      wrapper.unmount()
    }
  })

  it('[ADR-019, NFR-SEC-07] a javascript:, file: or data: link renders as text and an http link goes only through the external-link allowlist', async () => {
    for (const unsafe of unsafeLinkCases) {
      const wrapper = bubble(unsafe.markdown)
      const root = wrapper.element as Element

      expect(root.querySelectorAll('button, a').length, `${unsafe.id}: no control is drawn`).toBe(0)
      expect(foreignParts(root), `${unsafe.id}: DOM outside the closed tree`).toEqual([])
      expect(root.textContent, `${unsafe.id}: the words survive as text`).toContain(unsafe.shows)
      wrapper.unmount()
    }

    for (const safe of corpus.safeLinks) {
      const wrapper = bubble(safe.markdown)
      const buttons = wrapper.findAll('button')

      expect(buttons, `${safe.id}: one control`).toHaveLength(1)
      const button = buttons[0]!
      // The allowlist hands back the address exactly as written (shared/externalLink), so the
      // address shown and emitted is the corpus's own characters, never a rewrite.
      expect(button.attributes('title')).toBe(safe.href)
      expect(button.text()).toBe(safe.shows)
      await button.trigger('click')
      expect(wrapper.emitted('open-link')).toEqual([[safe.href]])
      // No anchor, so there is no href for the window itself to be navigated by.
      expect(wrapper.find('a').exists()).toBe(false)
      wrapper.unmount()
    }
  })
})
