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
 * `components.md`'s #347 amendment named paragraphs, emphasis, lists, block
 * quotes, inline code, fenced code and links, with headings folded to bold
 * paragraphs, and left tables, strikethrough and horizontal rules as the
 * characters the agent wrote — the design did not name them yet. Its #412
 * amendment (2026-09-16) widens the list to all three: the vocabulary is
 * still closed, it is just closed to the whole of GitHub-flavoured Markdown a
 * bubble can draw honestly now that the design names exactly this set.
 * Images stay a stated exception rather than an oversight: a transcript's
 * image address is untrusted and a local path could not be shown from the
 * renderer anyway, so an image is drawn as its alt text in the link treatment
 * below rather than fetched — nothing is ever loaded on the person's behalf.
 * Drawing UI the design does not specify is still what `ui-rebuild` refuses;
 * #412 only changes how much of it the design now specifies.
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

/** `~~struck~~` (#412) — a line through its children, nothing else. */
export interface MarkdownStrikethrough {
  kind: 'strikethrough'
  children: readonly MarkdownInline[]
}

/**
 * A link whose address `externalLinkOf` already admitted. A refused address
 * never reaches this shape at all: its own words are emitted where it stood, so
 * the sentence survives and the control does not.
 *
 * An image (#412) becomes exactly this shape rather than one of its own: its
 * alt text (or its address, when the alt is empty) is its children, and its
 * address goes through the same admission check. Nothing here ever draws an
 * `img` — see `inlineNodes`' `image` case for why.
 */
export interface MarkdownLink {
  kind: 'link'
  href: string
  children: readonly MarkdownInline[]
}

export type MarkdownInline =
  | MarkdownText
  | MarkdownCode
  | MarkdownEmphasis
  | MarkdownStrong
  | MarkdownStrikethrough
  | MarkdownLink

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

/** `---` between paragraphs (#412) — the same rule the block quote's own line draws. */
export interface MarkdownRule {
  kind: 'rule'
}

/** A column's alignment from the delimiter row, or `null` when the row left it unset. */
export type MarkdownAlign = 'left' | 'center' | 'right' | null

/** One table cell (#412). GFM allows only inlines inside a cell, never a block. */
export interface MarkdownCell {
  children: readonly MarkdownInline[]
}

/**
 * A GFM table (#412). `align` has one entry per column, read off the header
 * row's delimiter line — the only place alignment is stated — and every row's
 * cells line up with it positionally.
 */
export interface MarkdownTable {
  kind: 'table'
  header: readonly MarkdownCell[]
  rows: readonly (readonly MarkdownCell[])[]
  align: readonly MarkdownAlign[]
}

export type MarkdownBlock =
  | MarkdownParagraph
  | MarkdownList
  | MarkdownQuote
  | MarkdownCodeBlock
  | MarkdownTable
  | MarkdownRule

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
 * - `table`, `strikethrough`, `hr` and `image` are markdown-it's own defaults
 *   and stay enabled (#412): the design now names all four in the bubble's
 *   vocabulary, `image` included — it is drawn as a link, never as an `img`,
 *   so admitting the rule is what lets `inlineNodes` reshape it below rather
 *   than leave it as raw characters.
 */
const parser = new MarkdownIt({ html: false, linkify: false, typographer: false })

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
      case 'table_open': {
        const close = closeOf(tokens, i)
        blocks.push(tableOf(tokens, i, close))
        i = close + 1
        continue
      }
      // Nesting 0 — one token, nothing to close.
      case 'hr':
        blocks.push({ kind: 'rule' })
        i++
        continue
      default:
        // Any other block token contributes nothing on its own. `html_block`
        // is the one that could reach here, and `html: false` means it never
        // does: raw HTML arrives as plain text inside a paragraph instead
        // (see inlineNodes' default case).
        i++
    }
  }
  return blocks
}

/**
 * A table's alignment, read off one `th_open`/`td_open` token's `style`
 * attribute — the only place markdown-it records it, repeated on every cell
 * of the column rather than kept once. `null` for a column the delimiter row
 * left unset.
 */
function alignOf(token: Token): MarkdownAlign {
  const style = token.attrGet('style')
  if (style === 'text-align:left') return 'left'
  if (style === 'text-align:center') return 'center'
  if (style === 'text-align:right') return 'right'
  return null
}

/**
 * The cells of one row — a `tr_open`…`tr_close` span — matched against
 * `cellType` so the same walk reads a header's `th_open` cells or a body
 * row's `td_open` cells. A cell holds exactly one `inline` token regardless
 * of content, even an empty one, so `inlineIn` always has something to read.
 */
function cellsOf(
  tokens: readonly Token[],
  from: number,
  to: number,
  cellType: 'th_open' | 'td_open'
): { cells: MarkdownCell[]; aligns: MarkdownAlign[] } {
  const cells: MarkdownCell[] = []
  const aligns: MarkdownAlign[] = []
  let i = from
  while (i < to) {
    if (tokens[i]!.type !== cellType) {
      i++
      continue
    }
    const close = closeOf(tokens, i)
    cells.push({ children: inlineIn(tokens, i + 1, close) })
    aligns.push(alignOf(tokens[i]!))
    i = close + 1
  }
  return { cells, aligns }
}

/**
 * A table, from its `table_open` to the `table_close` the caller already
 * found. markdown-it's own table rule always emits `thead_open` immediately
 * after `table_open`, with its one header row immediately after that — so
 * both are read positionally rather than searched for. A `tbody_open` is
 * emitted only when at least one body row exists; `rows` is `[]` otherwise.
 */
function tableOf(tokens: readonly Token[], open: number, close: number): MarkdownTable {
  const theadOpen = open + 1
  const theadClose = closeOf(tokens, theadOpen)
  const headerTr = theadOpen + 1
  const headerTrClose = closeOf(tokens, headerTr)
  const { cells: header, aligns: align } = cellsOf(tokens, headerTr, headerTrClose, 'th_open')

  const rows: MarkdownCell[][] = []
  const bodyOpen = theadClose + 1
  if (bodyOpen < close && tokens[bodyOpen]!.type === 'tbody_open') {
    const bodyClose = closeOf(tokens, bodyOpen)
    let i = bodyOpen + 1
    while (i < bodyClose) {
      if (tokens[i]!.type !== 'tr_open') {
        i++
        continue
      }
      const trClose = closeOf(tokens, i)
      rows.push(cellsOf(tokens, i, trClose, 'td_open').cells)
      i = trClose + 1
    }
  }

  return { kind: 'table', header, align, rows }
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
      case 's_open': {
        const close = closeOf(tokens, i)
        nodes.push({ kind: 'strikethrough', children: inlineNodes(tokens.slice(i + 1, close)) })
        i = close + 1
        continue
      }
      /*
       * An image never becomes an `img` (#412): the transcript's address is
       * untrusted and a local path could not be shown from the renderer
       * anyway, so nothing is ever fetched. It becomes the same `link` shape
       * a real link takes instead — its alt text as the words (or its address,
       * when the alt is empty, so there is always something to press), and its
       * address through the identical `externalLinkOf` admission a link's
       * `href` already goes through. A refused address falls back to plain
       * text exactly the way `link_open` below does.
       */
      case 'image': {
        const src = String(token.attrGet('src') ?? '')
        const alt = inlineNodes(token.children ?? [])
        const children = alt.length > 0 ? alt : [{ kind: 'text', text: src } satisfies MarkdownText]
        const href = externalLinkOf(src)
        if (href === null) nodes.push(...children)
        else nodes.push({ kind: 'link', href, children })
        i++
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
