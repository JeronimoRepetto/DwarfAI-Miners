import { describe, expect, it } from 'vitest'
import {
  accept,
  anatomyAttributes,
  anatomyRoot,
  anatomyTexts,
  checkFraming,
  checkStates,
  componentOf,
  expectation,
  framingFor,
  stageWidth
} from './states.mjs'

/*
 * The golden states contract (#634), pinned without a browser or a design repository: which
 * states.json entries are valid against a manifest, how wide each stage is, where the framing a
 * state needs is read from, and how a state marked red must flip once it passes. The manifest rows
 * and Markdown here are small stand-ins written for the test, not copies of the design's.
 */

const manifest = {
  'atoms/lamp#lit': { file: 'atoms/lamp/lit.png', width: 404, height: 96, x: 20, y: 74 },
  'organisms/wall#tall': { file: 'organisms/wall/tall.png', width: 822, height: 300, x: 20, y: 74 },
  'organisms/wall#spill': {
    file: 'organisms/wall/spill.png',
    width: 530,
    height: 300,
    x: 20,
    y: 74,
    widened: true
  }
}

describe('checkStates', () => {
  it('accepts states that name a manifest key, red or not', () => {
    expect(
      checkStates(
        [
          { key: 'atoms/lamp#lit' },
          { key: 'organisms/wall#tall', red: 'not rebuilt yet' },
          { key: 'organisms/wall#spill' }
        ],
        manifest
      )
    ).toEqual([])
  })

  it('names a key the manifest lacks and a duplicate', () => {
    expect(
      checkStates(
        [
          { key: 'atoms/lamp#dark' },
          { key: 'atoms/lamp#lit' },
          { key: 'atoms/lamp#lit' },
          { key: 'atoms/lamp#lit' }
        ],
        manifest
      )
    ).toEqual(['atoms/lamp#dark is not in the manifest', 'atoms/lamp#lit is listed more than once'])
  })

  it('wants a red state to say why it is red', () => {
    expect(checkStates([{ key: 'atoms/lamp#lit', red: '' }], manifest)).toEqual([
      'atoms/lamp#lit is marked red without a reason'
    ])
  })

  it('names a field it does not read, so a width chosen in states.json cannot linger', () => {
    // The stage width is the manifest's alone; a cell written beside it would be a second source.
    expect(checkStates([{ key: 'atoms/lamp#lit', cell: 'standard' }], manifest)).toEqual([
      'atoms/lamp#lit has a field states.json does not use: cell'
    ])
  })
})

describe('stageWidth', () => {
  it("is the manifest row's width, or max-content (null) for a stage the capture widened", () => {
    expect(stageWidth(manifest['atoms/lamp#lit'])).toBe(404)
    expect(stageWidth(manifest['organisms/wall#tall'])).toBe(822)
    expect(stageWidth(manifest['organisms/wall#spill'])).toBeNull()
  })
})

describe('componentOf', () => {
  it('is the state key before its #', () => {
    expect(componentOf('organisms/wall#tall')).toBe('organisms/wall')
  })
})

const COMPONENTS = `
<a id="atoms-lamp"></a>

### Lamp

**UI kit framing** · rules that only frame the states.

| Selector | Declarations |
| --- | --- |
| \`.dm-lamp--other\` | width: 1px |

<a id="organisms-wall"></a>

### Wall

<a id="dm-ui-wall"></a>

**UI kit framing** · rules that only frame the states.

| Selector | Declarations |
| --- | --- |
| \`.dm-wall--static\` | height: 280px; width: 50px |

**Width** · measured.

### Next

**UI kit framing** · a later section's.

| Selector | Declarations |
| --- | --- |
| \`.dm-next\` | height: 9px |
`

describe('framingFor', () => {
  it("reads the component's own UI kit framing table, and no other section's", () => {
    expect(framingFor(COMPONENTS, 'organisms/wall')).toEqual([
      { selector: '.dm-wall--static', declarations: 'height: 280px; width: 50px' }
    ])
  })

  it('is empty for a component without framing rules', () => {
    expect(framingFor('<a id="atoms-bare"></a>\n\n### Bare\n\nText.\n', 'atoms/bare')).toEqual([])
  })

  it('fails for a component the docs do not describe', () => {
    expect(() => framingFor(COMPONENTS, 'atoms/ghost')).toThrow(/atoms\/ghost/)
  })
})

const ANATOMY = `
**Tall** · [reference image](reference/organisms/wall/tall.png), 822 × 300px, wide cell

\`\`\`text
div.dm-wall.m-mat.dm-wall--static [aria-label=Wall]
  span.dm-wall__brick
\`\`\`
`

describe('anatomyRoot', () => {
  it("is the first line of the state's element tree, found by its reference image", () => {
    expect(anatomyRoot(ANATOMY, 'organisms/wall/tall.png')).toBe(
      'div.dm-wall.m-mat.dm-wall--static [aria-label=Wall]'
    )
  })

  it('fails when no tree names that image', () => {
    expect(() => anatomyRoot(ANATOMY, 'organisms/wall/short.png')).toThrow(/short\.png/)
  })
})

describe('checkFraming', () => {
  const root = 'div.dm-wall.m-mat.dm-wall--static [aria-label=Wall]'

  it('accepts framing rules on classes the root carries', () => {
    expect(checkFraming([{ selector: '.dm-wall--static', declarations: 'x: 1' }], root)).toBeNull()
  })

  it('refuses a framing rule for an element other than the root, which the harness cannot place', () => {
    expect(checkFraming([{ selector: '.dm-wall__frame', declarations: 'x: 1' }], root)).toMatch(
      /\.dm-wall__frame/
    )
  })
})

describe('accept', () => {
  const pass = { pass: true, percent: 0, reasons: [] }

  it('adds guess notes and anything drawn outside the stage to the pixel verdict', () => {
    expect(accept(pass, { notes: 0, escaped: 0, outside: 0 })).toEqual(pass)
    expect(accept(pass, { notes: 2, escaped: 1, outside: 3 })).toEqual({
      pass: false,
      percent: 0,
      reasons: [
        '2 guess notes (.dm-note) on the build',
        '1 element drawn outside the stage',
        '3 elements added to the page outside the stage'
      ]
    })
  })
})

describe('expectation', () => {
  const pass = { pass: true, percent: 0.2, reasons: [] }
  const fail = { pass: false, percent: 12.5, reasons: ['differing pixels are not under 1%'] }

  it('holds a green state to the verdict', () => {
    expect(expectation({ key: 'k' }, pass).ok).toBe(true)
    const e = expectation({ key: 'k' }, fail)
    expect(e.ok).toBe(false)
    expect(e.message).toContain('differing pixels are not under 1%')
  })

  it('lets a red state fail, reporting why, and fails it once it passes so it must flip', () => {
    const red = { key: 'k', red: 'not rebuilt yet' }
    const still = expectation(red, fail)
    expect(still.ok).toBe(true)
    expect(still.message).toContain('12.5')
    const flipped = expectation(red, pass)
    expect(flipped.ok).toBe(false)
    expect(flipped.message).toMatch(/passes.*remove "red"/)
  })
})

// APPENDED for #635: the specimen captions, read from the anatomy at run time (the design lead's
// ruling on the tokens-port questions) so no caption is committed here. Stand-in text only.
const TEXTS = `
**Row** · [reference image](reference/foundations/lamp/row.png), 404 × 100px, standard cell

\`\`\`text
div [style="display: grid; gap: 4px"]
  div.kit-plate.m-mat.m-wood [data-x="a]b"]
    span.t-meta "lamp one"
  span.t-meta.t-faint
  p.t-talk (innerHTML "Lamp <strong>two</strong> \\"lit\\"")
  span.t-meta
    "Next: "
    b "Brass"
  i.t-meta "same" ×2
\`\`\`

**Other** · [reference image](reference/foundations/lamp/other.png), 404 × 96px, standard cell

\`\`\`text
span.t-meta "not this one"
\`\`\`
`

describe('anatomyTexts', () => {
  it("lists every text of the state's tree in DOM order, HTML content kept as HTML", () => {
    expect(anatomyTexts(TEXTS, 'foundations/lamp/row.png')).toEqual([
      { text: 'lamp one' },
      { html: 'Lamp <strong>two</strong> "lit"' },
      { text: 'Next: ' },
      { text: 'Brass' },
      { text: 'same' },
      { text: 'same' }
    ])
  })

  it('stops at the end of its own tree', () => {
    expect(anatomyTexts(TEXTS, 'foundations/lamp/other.png')).toEqual([{ text: 'not this one' }])
  })

  it('fails when no tree names that image', () => {
    expect(() => anatomyTexts(TEXTS, 'foundations/lamp/none.png')).toThrow(/none\.png/)
  })
})

// APPENDED for #635: the attributes a state's tree prints (a placeholder, a value, an accessible
// name), read at run time like its texts, so a form control's design text is never committed.
const ATTRIBUTES = `
**Pair** · [reference image](reference/atoms/lamp/pair.png), 404 × 96px, standard cell

\`\`\`text
div [style="width: 240px; display: grid"]
  label.lamp.m-mat.is-hover
    input [type=text placeholder="Wick length" aria-label="Wick length"]
  label.lamp.m-mat
    input [type=search placeholder value=ai- disabled]
    button.lamp__clear [title="Clear" hidden]
  select [aria-label=Mode] shows "Oil"
    option [value="Last used"] "Last used"
  p.lamp__hint "Say "yes" first."
  i.lamp__dot [data-n=1] ×2
\`\`\`

**Other** · [reference image](reference/atoms/lamp/other.png), 404 × 96px, standard cell

\`\`\`text
input [value=not-this-one]
\`\`\`
`

describe('anatomyAttributes', () => {
  it("lists every element of the state's tree with its attributes, in DOM order", () => {
    expect(anatomyAttributes(ATTRIBUTES, 'atoms/lamp/pair.png')).toEqual([
      { element: 'div', attributes: { style: 'width: 240px; display: grid' } },
      { element: 'label.lamp.m-mat.is-hover', attributes: {} },
      {
        element: 'input',
        attributes: { type: 'text', placeholder: 'Wick length', 'aria-label': 'Wick length' }
      },
      { element: 'label.lamp.m-mat', attributes: {} },
      // A bare name is an attribute present with no value, as `placeholder` and `disabled` are.
      {
        element: 'input',
        attributes: { type: 'search', placeholder: '', value: 'ai-', disabled: '' }
      },
      { element: 'button.lamp__clear', attributes: { title: 'Clear', hidden: '' } },
      { element: 'select', attributes: { 'aria-label': 'Mode' } },
      { element: 'option', attributes: { value: 'Last used' } },
      { element: 'p.lamp__hint', attributes: {} },
      { element: 'i.lamp__dot', attributes: { 'data-n': '1' } },
      { element: 'i.lamp__dot', attributes: { 'data-n': '1' } }
    ])
  })

  it('stops at the end of its own tree', () => {
    expect(anatomyAttributes(ATTRIBUTES, 'atoms/lamp/other.png')).toEqual([
      { element: 'input', attributes: { value: 'not-this-one' } }
    ])
  })

  it('fails when no tree names that image', () => {
    expect(() => anatomyAttributes(ATTRIBUTES, 'atoms/lamp/none.png')).toThrow(/none\.png/)
  })
})
