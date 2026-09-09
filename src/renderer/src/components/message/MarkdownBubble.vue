<script lang="ts">
import { computed, defineComponent, h, type VNode } from 'vue'
import { markdownBlocks, type MarkdownBlock, type MarkdownInline } from '../../lib/message/markdown'

/*
 * What one message SAYS, drawn (#347).
 *
 * ## Why this is a render function and not a template
 *
 * The tree is recursive — a list item holds blocks, a block quote holds blocks,
 * emphasis holds inlines — and a template drawing it would be a component
 * calling itself twice over. `h()` is the shorter, plainer version of the same
 * thing, and it is also the version that CANNOT accidentally grow a `v-html`:
 * every node below is an element this file named, built from a tree, never from
 * a string. There is no markup anywhere in the path from transcript to screen,
 * which is why no sanitizer stands in it either — see lib/message/markdown for
 * the whole argument.
 *
 * ## Where the surface comes from
 *
 * Nowhere here. The caller passes `class="bubble"` and the panel's own scoped
 * rule paints it, so this component decides nothing about ink, border or
 * alignment — only about the shape of what is inside. That keeps the two
 * bubbles the design draws (the dwarf's and the person's) one surface with one
 * rule, exactly as they were before this file existed.
 */
export default defineComponent({
  name: 'MarkdownBubble',
  props: {
    /** The message, exactly as the transcript carries it. Untrusted. */
    text: { type: String, required: true }
  },
  emits: {
    /**
     * A link was pressed. The address is already `http:` or `https:` —
     * `externalLinkOf` refused anything else before it was ever drawn — and
     * this component opens NOTHING: the window above relays it to main, which
     * validates it a second time and owns the only `shell.openExternal` in the
     * app. The same division #279 drew for an activity line's own path.
     */
    'open-link': (href: string) => typeof href === 'string' && href.length > 0
  },
  setup(props, { emit }) {
    const blocks = computed(() => markdownBlocks(props.text))

    function inlineNode(node: MarkdownInline): VNode | string {
      switch (node.kind) {
        case 'text':
          return node.text
        case 'code':
          return h('code', { class: 'markdown-code' }, node.text)
        case 'emphasis':
          return h('em', node.children.map(inlineNode))
        case 'strong':
          return h('strong', node.children.map(inlineNode))
        case 'link':
          return h(
            'button',
            {
              type: 'button',
              class: 'markdown-link',
              // The address itself, revealed on hover — the design's own rule.
              // A button rather than an anchor, so there is no href for this
              // window to be navigated by (#279 drew the same line).
              title: node.href,
              onClick: () => emit('open-link', node.href)
            },
            node.children.map(inlineNode)
          )
      }
    }

    function blockNode(block: MarkdownBlock): VNode {
      switch (block.kind) {
        case 'paragraph':
          return h('p', { class: 'markdown-paragraph' }, block.children.map(inlineNode))
        case 'list':
          return h(
            block.ordered ? 'ol' : 'ul',
            { class: 'markdown-list' },
            block.items.map((item) =>
              h('li', { class: 'markdown-item' }, item.blocks.map(blockNode))
            )
          )
        case 'quote':
          return h('blockquote', { class: 'markdown-quote' }, block.blocks.map(blockNode))
        case 'codeBlock':
          // The language is a CLASS and nothing else: there is no highlighter
          // here, and the class is what one could later attach to.
          return h('pre', { class: 'markdown-block-code' }, [
            h(
              'code',
              block.language === undefined ? {} : { class: `language-${block.language}` },
              block.text
            )
          ])
      }
    }

    return () => h('div', { class: 'markdown' }, blocks.value.map(blockNode))
  }
})
</script>

<style scoped>
/*
 * A column of blocks. The gap is in `em` on purpose: it is a gap between
 * paragraphs, so it belongs to the text's own size rather than to a spacing
 * token measured for the chrome.
 */
.markdown {
  display: flex;
  flex-direction: column;
  gap: 0.5em;
  /*
   * The bubble is a flex item of the message row, and a fenced block inside it
   * is wider than the panel by design. Without this the block's intrinsic width
   * wins and the whole conversation column scrolls sideways instead (#307 is
   * the same failure from the other direction).
   */
  min-width: 0;
}
/*
 * `pre-wrap` is what the bubble itself used to carry: a transcript's own line
 * breaks are visible, and a plain multi-line message draws exactly as it did
 * before Markdown was parsed at all. On the paragraph rather than the bubble,
 * because the gaps BETWEEN blocks are layout and must not become blank lines.
 */
.markdown-paragraph {
  margin: 0;
  white-space: pre-wrap;
}
.markdown-list {
  margin: 0;
  padding-left: 1.4em;
}
.markdown-item > .markdown-list {
  margin-top: 0.35em;
}
/*
 * The quote's rule is the bubble's own ink at the width the design gives every
 * other active border — no new colour, and nothing invented: this is the one
 * mark that says a line is quoted rather than said.
 */
.markdown-quote {
  display: flex;
  flex-direction: column;
  gap: 0.5em;
  margin: 0;
  padding-left: 8px;
  border-left: 2px solid var(--color-panel);
  opacity: 0.8;
}
/*
 * Code, inline and fenced, in the stack the permission card already uses — one
 * token now, so the two cannot drift. The surface is the bubble's own cream
 * taken one step toward the panel behind it, mixed from two existing tokens
 * rather than declared as a third colour.
 */
.markdown-code,
.markdown-block-code {
  border-radius: 4px;
  background: color-mix(in srgb, var(--color-cream) 88%, var(--color-panel));
  font-family: var(--font-code);
  font-size: var(--text-meta);
}
.markdown-code {
  padding: 0 3px;
  overflow-wrap: anywhere;
}
/*
 * A long line SCROLLS inside the bubble and never widens it — the design says
 * so outright, and the panel has 990px to spend on a conversation rather than
 * on one shell command.
 */
.markdown-block-code {
  overflow-x: auto;
  margin: 0;
  max-width: 100%;
  padding: 6px 8px;
  border-radius: var(--radius-default);
  line-height: 1.35;
  white-space: pre;
}
/*
 * The text button #279 established for this panel, on the bubble's surface:
 * the ink it sits in, underlined so it reads as the one thing in a sentence
 * that can be pressed, and the pointer cursor as the second tell.
 */
.markdown-link {
  padding: 0;
  border: 0;
  color: inherit;
  cursor: pointer;
  background: none;
  font: inherit;
  overflow-wrap: anywhere;
  text-align: left;
  text-decoration: underline;
}
.markdown-link:focus-visible {
  outline: 2px solid var(--color-panel);
  outline-offset: 1px;
}
</style>
