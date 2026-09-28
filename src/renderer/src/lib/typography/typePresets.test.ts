import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TYPE_PRESET,
  TYPE_PRESETS,
  TYPE_ROLE_PROPERTIES,
  crispSize,
  resolveTypePreset,
  resolveTypography
} from './typePresets'

/**
 * The three type presets, as data, and the one pure step from a preset to the custom properties
 * that paint it (#635). Choosing a preset repoints the four role tokens and the sizes its faces
 * are sharp at; nothing here touches the document, so what it answers can be pinned here and
 * applied by whoever owns the page.
 */
describe('TYPE_PRESETS', () => {
  it('offers DwarfAI, Pixel clean and Readable, in that order', () => {
    expect(TYPE_PRESETS.map((preset) => preset.id)).toEqual(['dwarfai', 'pixel-clean', 'readable'])
  })

  it('defaults to DwarfAI', () => {
    expect(DEFAULT_TYPE_PRESET).toBe('dwarfai')
  })

  it.each([
    [
      'dwarfai',
      { display: 'jacquard-12', label: 'tiny5', meta: 'pixelify-sans', talk: 'pixelify-sans' }
    ],
    [
      'pixel-clean',
      {
        display: 'pixelify-sans',
        label: 'pixelify-sans',
        meta: 'pixelify-sans',
        talk: 'pixelify-sans'
      }
    ],
    ['readable', { display: 'roboto', label: 'roboto', meta: 'roboto', talk: 'roboto' }]
  ] as const)('gives %s its face in each of the four roles', (id, faces) => {
    expect(TYPE_PRESETS.find((preset) => preset.id === id)?.faces).toEqual(faces)
  })

  // Blackletter is a titles face and nothing else; it cannot be read at label size.
  it('never puts Jacquard 12 outside the titles role', () => {
    for (const preset of TYPE_PRESETS) {
      expect([preset.faces.label, preset.faces.meta, preset.faces.talk]).not.toContain(
        'jacquard-12'
      )
    }
  })

  // Tiny5 blurs below label size and cannot draw bold, so it never sets small text or messages.
  it('never puts Tiny5 in small text or messages', () => {
    for (const preset of TYPE_PRESETS) {
      expect(preset.faces.meta).not.toBe('tiny5')
      expect(preset.faces.talk).not.toBe('tiny5')
    }
  })
})

describe('resolveTypePreset', () => {
  it('names the four role tokens', () => {
    expect(TYPE_ROLE_PROPERTIES).toEqual({
      display: '--f-display',
      label: '--f-label',
      meta: '--f-meta',
      talk: '--f-talk'
    })
  })

  it('resolves DwarfAI to its faces, by reference, and the sizes they are sharp at', () => {
    expect(resolveTypePreset('dwarfai')).toEqual({
      '--f-display': 'var(--font-family-jacquard-12)',
      '--f-label': 'var(--font-family-tiny5)',
      '--f-meta': 'var(--font-family-pixelify-sans)',
      '--f-talk': 'var(--font-family-pixelify-sans)',
      '--fs-title': '21px',
      '--fs-headline': '21px',
      '--fs-section': '16px',
      '--fs-meta': '12px',
      '--fs-body': '14px'
    })
  })

  it.each([
    ['pixel-clean', 'pixelify-sans'],
    ['readable', 'roboto']
  ] as const)('resolves %s to one face in every role, at the same sizes', (id, face) => {
    const resolved = resolveTypePreset(id)
    for (const property of Object.values(TYPE_ROLE_PROPERTIES)) {
      expect(resolved[property]).toBe(`var(--font-family-${face})`)
    }
    expect(resolved['--fs-title']).toBe('21px')
    expect(resolved['--fs-headline']).toBe('21px')
    expect(resolved['--fs-section']).toBe('16px')
    expect(resolved['--fs-meta']).toBe('12px')
    expect(resolved['--fs-body']).toBe('14px')
  })

  it('answers a fresh record each time, so a caller cannot edit the preset through it', () => {
    const first = resolveTypePreset('dwarfai')
    first['--f-display'] = 'changed'
    expect(resolveTypePreset('dwarfai')['--f-display']).toBe('var(--font-family-jacquard-12)')
  })
})

/*
 * The stylesheet is what paints before anything applies a preset, so its role and size tokens are
 * the default preset spelled in CSS; and every face a preset names needs a stack there, or the
 * role resolves to nothing and the browser drops the declaration without a word.
 */
describe('the presets against design-tokens.css', () => {
  const css = readFileSync(join(import.meta.dirname, '../../assets/design-tokens.css'), 'utf8')
  const rootValue = (name: string): string | undefined =>
    new RegExp(`(?:^|[\\s;{])${name}\\s*:\\s*([^;]+);`).exec(css)?.[1]?.trim()

  it('declares the default preset as the stylesheet’s own role and size tokens', () => {
    for (const [property, value] of Object.entries(resolveTypePreset(DEFAULT_TYPE_PRESET))) {
      expect([property, rootValue(property)]).toEqual([property, value])
    }
  })

  it('declares a stack with a fallback for every face a preset names', () => {
    const faces = new Set(TYPE_PRESETS.flatMap((preset) => Object.values(preset.faces)))
    for (const face of faces) {
      const stack = rootValue(`--font-family-${face}`)
      expect(stack, face).toBeTruthy()
      expect(stack!.split(',').length, face).toBeGreaterThan(1)
    }
  })
})

/*
 * The crisp-size rule (foundations.md, The crisp-size rule), which Custom applies role by role
 * (#635): a pixel face is sharp only at whole multiples of its em grid, so each step snaps to the
 * nearest one and keeps rising until the x-height reaches 7 screen pixels. Vector faces are sharp
 * at any size. The table below is the design's, cell for cell.
 */
describe('crispSize', () => {
  it.each([
    ['tiny5', 12, 16],
    ['tiny5', 14, 16],
    ['tiny5', 16, 16],
    ['tiny5', 21, 24],
    ['tiny5', 26, 24],
    ['jacquard-12', 12, 21],
    ['jacquard-12', 14, 21],
    ['jacquard-12', 16, 21],
    ['jacquard-12', 21, 21],
    ['jacquard-12', 26, 21]
  ] as const)('snaps %s asked at %ipx to %ipx', (face, asked, sharp) => {
    expect(crispSize(face, asked)).toBe(sharp)
  })

  it.each(['pixelify-sans', 'roboto', 'arial'] as const)(
    'leaves %s at the size asked, since a vector face is sharp at any size',
    (face) => {
      for (const asked of [12, 14, 16, 21, 26]) expect(crispSize(face, asked)).toBe(asked)
    }
  )

  it('gives every preset the sizes its own faces are sharp at, so the presets obey the rule', () => {
    for (const preset of TYPE_PRESETS) {
      expect(preset.sizes.title).toBe(crispSize(preset.faces.display, 21))
      expect(preset.sizes.headline).toBe(crispSize(preset.faces.display, 21))
      expect(preset.sizes.section).toBe(crispSize(preset.faces.label, 16))
      expect(preset.sizes.meta).toBe(crispSize(preset.faces.meta, 12))
      expect(preset.sizes.body).toBe(crispSize(preset.faces.talk, 14))
    }
  })
})

/*
 * What a stored choice paints (#635): a preset resolves as the preset does, and Custom repoints each
 * role to its own face with crisp sizes on ("Custom sets one role at a time, also with crisp sizes
 * on", foundations.md, How a role gets its face).
 */
describe('resolveTypography', () => {
  it.each(['dwarfai', 'pixel-clean', 'readable'] as const)(
    'paints the %s style exactly as its preset resolves',
    (style) => {
      const faces = TYPE_PRESETS.find((preset) => preset.id === style)!.faces
      expect(resolveTypography({ style, faces: { ...faces } })).toEqual(resolveTypePreset(style))
    }
  )

  it('paints Custom in its own faces, each step at the size its face is sharp at', () => {
    expect(
      resolveTypography({
        style: 'custom',
        faces: { display: 'tiny5', label: 'roboto', meta: 'arial', talk: 'pixelify-sans' }
      })
    ).toEqual({
      '--f-display': 'var(--font-family-tiny5)',
      '--f-label': 'var(--font-family-roboto)',
      '--f-meta': 'var(--font-family-arial)',
      '--f-talk': 'var(--font-family-pixelify-sans)',
      '--fs-title': '24px',
      '--fs-headline': '24px',
      '--fs-section': '16px',
      '--fs-meta': '12px',
      '--fs-body': '14px'
    })
  })
})
