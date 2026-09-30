import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TYPOGRAPHY_PREFERENCES,
  TYPE_PRESET_FACES,
  type TypographyPreferences
} from '../../types'
import {
  FONT_STYLE_OPTIONS,
  ROLE_ROWS,
  fontStyleSample,
  pickFontStyle,
  pickRoleFace,
  steppedFontStyle
} from './fontStyle'

/**
 * Settings › Appearance › Font style (#635): the three presets and Custom as a vertical list, and
 * Custom's one row per role (screens/settings.md, As built; foundations.md, Presets and Custom).
 * What a press means is decided here, from the choice in force, so the component only draws.
 */
const CUSTOM: TypographyPreferences = {
  style: 'custom',
  faces: { display: 'tiny5', label: 'roboto', meta: 'arial', talk: 'pixelify-sans' }
}

describe('FONT_STYLE_OPTIONS', () => {
  it('lists DwarfAI, Pixel clean, Readable and Custom, in that order, with their own lines', () => {
    expect(FONT_STYLE_OPTIONS).toEqual([
      {
        id: 'dwarfai',
        label: 'DwarfAI',
        note: 'Blackletter titles, pixel labels, Pixelify for reading.'
      },
      {
        id: 'pixel-clean',
        label: 'Pixel clean',
        note: 'Pixelify Sans throughout: pixel style, no blackletter.'
      },
      { id: 'readable', label: 'Readable', note: 'Roboto throughout, for comfort and low vision.' },
      {
        id: 'custom',
        label: 'Custom',
        note: 'Pick a face for each role. Sizes stay sharp on their own.'
      }
    ])
  })
})

describe('fontStyleSample', () => {
  it('previews a preset in its own title, label and message faces', () => {
    expect(fontStyleSample('dwarfai', CUSTOM)).toEqual(['jacquard-12', 'tiny5', 'pixelify-sans'])
    expect(fontStyleSample('readable', CUSTOM)).toEqual(['roboto', 'roboto', 'roboto'])
  })

  it('previews Custom in the faces in force, whatever style is picked', () => {
    expect(fontStyleSample('custom', CUSTOM)).toEqual(['tiny5', 'roboto', 'pixelify-sans'])
    expect(fontStyleSample('custom', DEFAULT_TYPOGRAPHY_PREFERENCES)).toEqual([
      'jacquard-12',
      'tiny5',
      'pixelify-sans'
    ])
  })
})

describe('pickFontStyle', () => {
  it('turns a preset into exactly its faces', () => {
    expect(pickFontStyle(CUSTOM, 'pixel-clean')).toEqual({
      style: 'pixel-clean',
      faces: TYPE_PRESET_FACES['pixel-clean']
    })
  })

  it('opens Custom on the faces the style it leaves was drawn in, so nothing jumps', () => {
    expect(pickFontStyle(DEFAULT_TYPOGRAPHY_PREFERENCES, 'custom')).toEqual({
      style: 'custom',
      faces: DEFAULT_TYPOGRAPHY_PREFERENCES.faces
    })
  })

  it('never shares a face record with what it was handed', () => {
    const picked = pickFontStyle(DEFAULT_TYPOGRAPHY_PREFERENCES, 'custom')
    picked.faces.label = 'arial'
    expect(DEFAULT_TYPOGRAPHY_PREFERENCES.faces.label).toBe('tiny5')
  })
})

describe('pickRoleFace', () => {
  it('changes one role under Custom and leaves the other three where they were', () => {
    expect(pickRoleFace(CUSTOM, 'talk', 'roboto')).toEqual({
      style: 'custom',
      faces: { ...CUSTOM.faces, talk: 'roboto' }
    })
  })
})

describe('ROLE_ROWS', () => {
  it('names each role, in the order Titles, Labels, Small text, Messages, with its help line', () => {
    expect(ROLE_ROWS).toEqual([
      {
        role: 'display',
        label: 'Titles',
        help: 'Titles and mine names. Blackletter is offered here only.'
      },
      {
        role: 'label',
        label: 'Labels',
        help: 'Section labels and list headings at 16px. Tiny5 stops here: below this size it blurs.'
      },
      { role: 'meta', label: 'Small text', help: 'Numbers, hints and metadata.' },
      {
        role: 'talk',
        label: 'Messages',
        help: 'What dwarfs and you say. Needs bold and paragraphs, so pixel display faces are not offered.'
      }
    ])
  })
})

describe('steppedFontStyle', () => {
  it.each([
    ['dwarfai', 'ArrowDown', 'pixel-clean'],
    ['dwarfai', 'ArrowRight', 'pixel-clean'],
    ['custom', 'ArrowDown', 'dwarfai'],
    ['dwarfai', 'ArrowUp', 'custom'],
    ['readable', 'ArrowLeft', 'pixel-clean']
  ] as const)('moves from %s on %s to %s, wrapping at both ends', (from, key, to) => {
    expect(steppedFontStyle(from, key)).toBe(to)
  })

  it('answers nothing for a key the radiogroup does not move on', () => {
    expect(steppedFontStyle('dwarfai', 'Enter')).toBeUndefined()
  })
})
