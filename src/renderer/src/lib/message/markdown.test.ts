import { describe, expect, it } from 'vitest'
import { markdownBlocks, type MarkdownBlock, type MarkdownInline } from './markdown'

/*
 * The TREE is what is asserted here, never a string of HTML — because a string
 * of HTML is exactly what this module refuses to produce (#347). Nothing
 * downstream may hand markup to a parser, so nothing here may pin one.
 */

/** One paragraph's inline children, which is the shape most cases end in. */
function inlineOf(blocks: readonly MarkdownBlock[], at = 0): readonly MarkdownInline[] {
  const block = blocks[at]
  if (block?.kind !== 'paragraph') throw new Error(`block ${at} is ${block?.kind ?? 'missing'}`)
  return block.children
}

/** Every character the tree would draw, in order — what a reader actually sees. */
function textOf(nodes: readonly MarkdownInline[]): string {
  return nodes
    .map((node) => {
      if (node.kind === 'text' || node.kind === 'code') return node.text
      return textOf(node.children)
    })
    .join('')
}

describe('plain text, which must survive untouched', () => {
  it('draws one sentence as one paragraph of one text node', () => {
    expect(markdownBlocks('Found the seam.')).toEqual([
      { kind: 'paragraph', children: [{ kind: 'text', text: 'Found the seam.' }] }
    ])
  })

  /*
   * The bubble drew `white-space: pre-wrap` over the raw text before #347, so a
   * transcript's own line breaks were visible. A soft break therefore has to
   * survive as a newline rather than becoming a space, or every multi-line
   * plain message in every panel silently reflows.
   */
  it("keeps a line break inside a paragraph, as the bubble's pre-wrap did", () => {
    expect(textOf(inlineOf(markdownBlocks('first\nsecond')))).toBe('first\nsecond')
  })

  it('keeps a hard break too', () => {
    expect(textOf(inlineOf(markdownBlocks('first  \nsecond')))).toBe('first\nsecond')
  })

  it('splits a blank line into two paragraphs and loses no word', () => {
    const blocks = markdownBlocks('first\n\nsecond')
    expect(blocks).toHaveLength(2)
    expect(textOf(inlineOf(blocks, 0))).toBe('first')
    expect(textOf(inlineOf(blocks, 1))).toBe('second')
  })

  it('answers with nothing for nothing', () => {
    expect(markdownBlocks('')).toEqual([])
    expect(markdownBlocks('   ')).toEqual([])
  })
})

describe('the constructs the design names', () => {
  it('reads **bold** as a strong run', () => {
    expect(inlineOf(markdownBlocks('**Done**'))).toEqual([
      { kind: 'strong', children: [{ kind: 'text', text: 'Done' }] }
    ])
  })

  it('reads *italic* as an emphasis run', () => {
    expect(inlineOf(markdownBlocks('_maybe_'))).toEqual([
      { kind: 'emphasis', children: [{ kind: 'text', text: 'maybe' }] }
    ])
  })

  it('reads `code` as an inline code run', () => {
    expect(inlineOf(markdownBlocks('run `pnpm test` first'))).toEqual([
      { kind: 'text', text: 'run ' },
      { kind: 'code', text: 'pnpm test' },
      { kind: 'text', text: ' first' }
    ])
  })

  it('reads a bulleted list as an unordered list of one paragraph each', () => {
    expect(markdownBlocks('- one\n- two')).toEqual([
      {
        kind: 'list',
        ordered: false,
        items: [
          { blocks: [{ kind: 'paragraph', children: [{ kind: 'text', text: 'one' }] }] },
          { blocks: [{ kind: 'paragraph', children: [{ kind: 'text', text: 'two' }] }] }
        ]
      }
    ])
  })

  it('reads a numbered list as an ordered one', () => {
    const blocks = markdownBlocks('1. one\n2. two')
    expect(blocks[0]).toMatchObject({ kind: 'list', ordered: true })
    expect(blocks[0]).toHaveProperty('items.length', 2)
  })

  it('reads a nested list as a list inside its item', () => {
    const blocks = markdownBlocks('- one\n  - deeper')
    expect(blocks[0]).toMatchObject({
      kind: 'list',
      ordered: false,
      items: [{ blocks: [{ kind: 'paragraph' }, { kind: 'list', ordered: false }] }]
    })
  })

  it('reads a block quote as a quote holding its own blocks', () => {
    expect(markdownBlocks('> quoted')).toEqual([
      {
        kind: 'quote',
        blocks: [{ kind: 'paragraph', children: [{ kind: 'text', text: 'quoted' }] }]
      }
    ])
  })

  it('reads a fenced block, keeping its lines and dropping the fence', () => {
    expect(markdownBlocks('```\nline one\nline two\n```')).toEqual([
      { kind: 'codeBlock', text: 'line one\nline two' }
    ])
  })

  /*
   * The language is kept as a CLASS NAME and nothing else — there is no
   * highlighter here and the design asks for none. So it survives only when it
   * could not be anything but a name; an info string is transcript text like
   * every other part of the message.
   */
  it('keeps a fence language when it is a plain name', () => {
    expect(markdownBlocks('```ts\nconst a = 1\n```')).toEqual([
      { kind: 'codeBlock', language: 'ts', text: 'const a = 1' }
    ])
  })

  it('drops a fence language that is not a plain name', () => {
    const blocks = markdownBlocks('```ts" onload="alert(1)\nconst a = 1\n```')
    expect(blocks).toEqual([{ kind: 'codeBlock', text: 'const a = 1' }])
  })

  it('reads an indented block as code with no language', () => {
    expect(markdownBlocks('    indented')).toEqual([{ kind: 'codeBlock', text: 'indented' }])
  })

  /*
   * A bubble is not a page, so a heading is drawn as a bold paragraph — the
   * design says so outright. Folded HERE rather than in the component: the
   * component then needs no notion of a heading at all, and there is no size
   * for anyone to reintroduce later.
   */
  it.each(['# Title', '## Title', '###### Title'])('folds %s into a bold paragraph', (source) => {
    expect(markdownBlocks(source)).toEqual([
      {
        kind: 'paragraph',
        children: [{ kind: 'strong', children: [{ kind: 'text', text: 'Title' }] }]
      }
    ])
  })
})

describe('links', () => {
  it('keeps an http address, with the text that was written for it', () => {
    expect(inlineOf(markdownBlocks('[the issue](https://example.test/347)'))).toEqual([
      {
        kind: 'link',
        href: 'https://example.test/347',
        children: [{ kind: 'text', text: 'the issue' }]
      }
    ])
  })

  /*
   * A refused address does not remove the words that carried it. The link
   * simply stops being one, and its own text is drawn where it stood.
   */
  it.each([
    ['[click me](javascript:alert(1))', 'click me'],
    ['[click me](data:text/html,<script>alert(1)</script>)', 'click me'],
    ['[click me](file:///etc/passwd)', 'click me'],
    ['[click me](./relative.md)', 'click me']
  ])('draws %s as its own text, with no link node', (source, expected) => {
    const inline = inlineOf(markdownBlocks(source))
    expect(inline.some((node) => node.kind === 'link')).toBe(false)
    expect(textOf(inline)).toContain(expected)
  })

  /*
   * `linkify` is off: a bare address is text somebody typed, and turning it
   * into a control nobody asked for is the panel deciding something.
   */
  it('leaves a bare address as text', () => {
    expect(inlineOf(markdownBlocks('see https://example.test/347'))).toEqual([
      { kind: 'text', text: 'see https://example.test/347' }
    ])
  })
})

/*
 * The transcript is untrusted, and this is the half of that claim the parser
 * owns: `html: false` means every one of these arrives as CHARACTERS. The other
 * half — that nothing downstream turns characters back into markup — is pinned
 * in MarkdownBubble's own tests, because only a mounted component can prove it.
 */
describe('raw HTML, which is text and only text', () => {
  it.each([
    '<script>alert(1)</script>',
    '<img src=x onerror="alert(1)">',
    '<div onclick="alert(1)">hello</div>',
    '<!-- a comment -->',
    '<iframe src="https://example.test"></iframe>'
  ])('reads %s as plain text', (source) => {
    const blocks = markdownBlocks(source)
    for (const block of blocks) expect(block.kind).toBe('paragraph')
    expect(textOf(inlineOf(blocks))).toBe(source)
  })

  it('reads HTML wrapped around real Markdown as text around real Markdown', () => {
    const inline = inlineOf(markdownBlocks('<b>**bold**</b>'))
    expect(inline).toEqual([
      { kind: 'text', text: '<b>' },
      { kind: 'strong', children: [{ kind: 'text', text: 'bold' }] },
      { kind: 'text', text: '</b>' }
    ])
  })
})

/*
 * The design names a closed list of constructs. Everything outside it stays as
 * the agent wrote it — visible, and never quietly dropped. A rule the panel can
 * state, rather than a growing set of half-drawn syntaxes.
 */
describe('syntax the design does not name', () => {
  it.each([
    ['a | b\n--- | ---\n1 | 2', 'a table'],
    ['~~struck~~', 'strikethrough'],
    ['***', 'a horizontal rule']
  ])('leaves %s (%s) as the characters that were written', (source) => {
    const drawn = markdownBlocks(source)
      .map((block) => (block.kind === 'paragraph' ? textOf(block.children) : ''))
      .join('\n')
    expect(drawn).toContain(source.split('\n')[0])
  })
})
