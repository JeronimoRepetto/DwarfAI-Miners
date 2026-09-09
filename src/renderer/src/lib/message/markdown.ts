import MarkdownIt from 'markdown-it'
import type { Token } from 'markdown-it'
import { externalLinkOf } from '../../../../shared/externalLink'

/**
 * What a bubble's Markdown MEANS, as a tree this module owns (#347).
 *
 * ## Why a tree and not HTML
 *
 * markdown-it can render a string of HTML, and this module deliberately never
 * asks it to. A transcript is untrusted text — written by a model, and before
 * that by whatever the model read — and the moment a string of markup exists,
 * something downstream has to turn it back into DOM. `v-html` is that
 * something, and there is no version of it that is safe for this input.
 *
 * So the token stream is read into the shape below, and `MarkdownBubble.vue`
 * builds real vnodes from it with `h()`. No markup string exists at any point,
 * which means no sanitizer stands between two parsers with different ideas
 * about what a tag is. `html: false` is still set, so raw HTML never becomes a
 * token in the first place; it arrives here as characters, and characters are
 * all the tree can carry.
 *
 * ## Why the vocabulary is closed
 *
 * `components.md`'s #347 amendment names the constructs a bubble draws:
 * paragraphs, emphasis, lists, block quotes, inline code, fenced code and
 * links, with headings folded to bold paragraphs. That list is the whole of
 * this file's vocabulary. Syntax outside it — tables, strikethrough, horizontal
 * rules, images — is left as the characters the agent wrote, which is visible
 * and honest; drawing it would mean inventing UI the design does not specify,
 * and `ui-rebuild` refuses that.
 */

/** A run of characters, exactly as they were written. */
export interface MarkdownText {
  kind: 'text'
  text: string
}

/** `code` between backticks — monospace, never parsed further. */
export interface MarkdownCode {
  kind: 'code'
  text: string
}

export interface MarkdownEmphasis {
  kind: 'emphasis'
  children: readonly MarkdownInline[]
}

export interface MarkdownStrong {
  kind: 'strong'
  children: readonly MarkdownInline[]
}

/**
 * A link whose address `externalLinkOf` already admitted. A refused address
 * never reaches this shape at all: its own words are emitted where it stood, so
 * the sentence survives and the control does not.
 */
export interface MarkdownLink {
  kind: 'link'
  href: string
  children: readonly MarkdownInline[]
}

export type MarkdownInline =
  MarkdownText | MarkdownCode | MarkdownEmphasis | MarkdownStrong | MarkdownLink

export interface MarkdownParagraph {
  kind: 'paragraph'
  children: readonly MarkdownInline[]
}

/** One list entry, which holds blocks of its own — a nested list among them. */
export interface MarkdownItem {
  blocks: readonly MarkdownBlock[]
}

export interface MarkdownList {
  kind: 'list'
  ordered: boolean
  items: readonly MarkdownItem[]
}

export interface MarkdownQuote {
  kind: 'quote'
  blocks: readonly MarkdownBlock[]
}

/**
 * A fenced or indented block. `language` is kept as a CLASS NAME and nothing
 * else — there is no highlighter here and the design asks for none — so it
 * survives only when it could not be anything but a name.
 */
export interface MarkdownCodeBlock {
  kind: 'codeBlock'
  language?: string
  text: string
}

export type MarkdownBlock = MarkdownParagraph | MarkdownList | MarkdownQuote | MarkdownCodeBlock

/**
 * A fence's info string is transcript text like every other part of the
 * message, so it is admitted only as a bare name. Anything else — a quote, a
 * space, an angle bracket — and the language is dropped rather than repaired:
 * a class name is the one thing this value is used for, and a half-cleaned one
 * is worth less than none.
 */
const LANGUAGE_NAME = /^[a-zA-Z0-9_+.-]+$/

/**
 * The parser, built once.
 *
 * - `html: false` — raw HTML is never a token; it arrives as characters.
 * - `linkify: false` — a bare address is text somebody typed. Turning it into a
 *   control nobody asked for is the panel deciding something.
 * - `typographer: false` (the default, stated) — a transcript's own quotes and
 *   dashes are not this app's to rewrite.
 * - The four disabled rules are the syntax the design does not name. Disabling
 *   them is what makes their source survive as characters rather than as a
 *   construct with nowhere to be drawn.
 */
const parser = new MarkdownIt({ html: false, linkify: false, typographer: false }).disable([
  'table',
  'strikethrough',
  'hr',
  'image'
])

/** What one bubble draws, in order. Empty for a message with nothing in it. */
export function markdownBlocks(text: string): readonly MarkdownBlock[] {
  return blocksIn(parser.parse(text, {}), 0, undefined)
}

/**
 * The index of the token that closes the container opened at `open`.
 *
 * Counted rather than read off `level`, so that a list inside a list, or a
 * quote inside a quote, closes at the right place.
 */
function closeOf(tokens: readonly Token[], open: number): number {
  const openType = tokens[open]!.type
  const closeType = `${openType.slice(0, -'_open'.length)}_close`
  let depth = 0
  for (let i = open; i < tokens.length; i++) {
    const type = tokens[i]!.type
    if (type === openType) depth++
    else if (type === closeType && --depth === 0) return i
  }
  return tokens.length
}

function blocksIn(tokens: readonly Token[], from: number, to: number | undefined): MarkdownBlock[] {
  const end = to ?? tokens.length
  const blocks: MarkdownBlock[] = []
  let i = from
  while (i < end) {
    const token = tokens[i]!
    switch (token.type) {
      case 'paragraph_open': {
        const close = closeOf(tokens, i)
        blocks.push({ kind: 'paragraph', children: inlineIn(tokens, i + 1, close) })
        i = close + 1
        continue
      }
      // A bubble is not a page: the design draws a heading as a bold paragraph,
      // never at a heading size. Folded HERE rather than in the component, so
      // the component has no notion of a heading and no size to reintroduce.
      case 'heading_open': {
        const close = closeOf(tokens, i)
        const children = inlineIn(tokens, i + 1, close)
        blocks.push({ kind: 'paragraph', children: [{ kind: 'strong', children }] })
        i = close + 1
        continue
      }
      case 'bullet_list_open':
      case 'ordered_list_open': {
        const close = closeOf(tokens, i)
        blocks.push({
          kind: 'list',
          ordered: token.type === 'ordered_list_open',
          items: itemsIn(tokens, i + 1, close)
        })
        i = close + 1
        continue
      }
      case 'blockquote_open': {
        const close = closeOf(tokens, i)
        blocks.push({ kind: 'quote', blocks: blocksIn(tokens, i + 1, close) })
        i = close + 1
        continue
      }
      case 'fence':
      case 'code_block': {
        blocks.push(codeBlockOf(token))
        i++
        continue
      }
      default:
        // Any other block token contributes nothing on its own. Nothing is lost
        // by skipping it: the four constructs that would have produced one are
        // disabled above, so their source is still here as paragraph text.
        i++
    }
  }
  return blocks
}

function itemsIn(tokens: readonly Token[], from: number, to: number): MarkdownItem[] {
  const items: MarkdownItem[] = []
  let i = from
  while (i < to) {
    if (tokens[i]!.type !== 'list_item_open') {
      i++
      continue
    }
    const close = closeOf(tokens, i)
    items.push({ blocks: blocksIn(tokens, i + 1, close) })
    i = close + 1
  }
  return items
}

function codeBlockOf(token: Token): MarkdownCodeBlock {
  // markdown-it ends a fence's content with the newline before the closing
  // fence. Kept, and it would draw as a trailing blank line inside the block.
  const text = token.content.replace(/\n$/, '')
  const language = token.info.trim().split(/\s+/)[0] ?? ''
  if (!LANGUAGE_NAME.test(language)) return { kind: 'codeBlock', text }
  return { kind: 'codeBlock', language, text }
}

function inlineIn(tokens: readonly Token[], from: number, to: number): MarkdownInline[] {
  const nodes: MarkdownInline[] = []
  for (let i = from; i < to; i++) {
    const token = tokens[i]!
    if (token.type !== 'inline') continue
    nodes.push(...inlineNodes(token.children ?? []))
  }
  return nodes
}

function inlineNodes(tokens: readonly Token[]): MarkdownInline[] {
  const nodes: MarkdownInline[] = []
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i]!
    switch (token.type) {
      case 'text':
        // markdown-it leaves an EMPTY text token on each side of a delimiter
        // run, which draws nothing and would only make the tree harder to read
        // and to assert against.
        if (token.content !== '') nodes.push({ kind: 'text', text: token.content })
        i++
        continue
      // Both breaks become a newline rather than an element, because the bubble
      // keeps `pre-wrap` on its paragraphs: a plain multi-line message has to
      // draw exactly as it did before this module existed.
      case 'softbreak':
      case 'hardbreak':
        nodes.push({ kind: 'text', text: '\n' })
        i++
        continue
      case 'code_inline':
        nodes.push({ kind: 'code', text: token.content })
        i++
        continue
      case 'em_open':
      case 'strong_open': {
        const close = closeOf(tokens, i)
        const kind = token.type === 'em_open' ? 'emphasis' : 'strong'
        nodes.push({ kind, children: inlineNodes(tokens.slice(i + 1, close)) })
        i = close + 1
        continue
      }
      case 'link_open': {
        const close = closeOf(tokens, i)
        const children = inlineNodes(tokens.slice(i + 1, close))
        // `String(...)` because an attribute value is typed as string OR
        // number here; a number could never be an address, and this way it is
        // refused by the one rule rather than by a second guard.
        const href = externalLinkOf(String(token.attrGet('href') ?? ''))
        // A refused address does not take the words with it: the link simply
        // stops being one and its own text is drawn where it stood.
        if (href === null) nodes.push(...children)
        else nodes.push({ kind: 'link', href, children })
        i = close + 1
        continue
      }
      default:
        i++
    }
  }
  return nodes
}
