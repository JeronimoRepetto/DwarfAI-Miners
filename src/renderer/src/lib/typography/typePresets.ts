import type { InterfaceFont } from '../../types'

/**
 * The type presets Settings will offer, as data, and the pure step from a preset to the custom
 * properties that paint it (#635).
 *
 * Type is four roles, and a component names a role and a size token, never a face. A preset is
 * therefore only an answer for each role plus the sizes its faces are sharp at: a pixel face is
 * crisp at whole multiples of its em grid, and choosing a preset turns that snapping on, which is
 * why the sizes travel with the faces instead of staying in the stylesheet.
 *
 * Nothing here touches the document or the stored preference. Whoever owns the page applies the
 * record; the preference that picks a preset, and its migration from today's Interface and
 * Messaging choices, are the Panel slice's.
 */

/** Every face a preset may put in a role: the offered faces, plus the titles-only blackletter. */
export type TypeFace = InterfaceFont | 'jacquard-12'

export type TypeRole = 'display' | 'label' | 'meta' | 'talk'

export type TypeStep = 'title' | 'headline' | 'section' | 'meta' | 'body'

export type TypePresetId = 'dwarfai' | 'pixel-clean' | 'readable'

export interface TypePreset {
  id: TypePresetId
  faces: Readonly<Record<TypeRole, TypeFace>>
  /** Each step's size in CSS pixels, as the preset's faces are sharp at. */
  sizes: Readonly<Record<TypeStep, number>>
}

/** The custom property each role is painted through. */
export const TYPE_ROLE_PROPERTIES: Readonly<Record<TypeRole, string>> = {
  display: '--f-display',
  label: '--f-label',
  meta: '--f-meta',
  talk: '--f-talk'
}

const STEP_PROPERTIES: Readonly<Record<TypeStep, string>> = {
  title: '--fs-title',
  headline: '--fs-headline',
  section: '--fs-section',
  meta: '--fs-meta',
  body: '--fs-body'
}

/*
 * Every preset lands on the same sizes: Jacquard 12 is sharp at 21px and Tiny5 at 16px, which is
 * where the scale already asks for them, and the vector faces are sharp at any size.
 */
const SHARP_SIZES: TypePreset['sizes'] = {
  title: 21,
  headline: 21,
  section: 16,
  meta: 12,
  body: 14
}

/** In the order Settings lists them. */
export const TYPE_PRESETS: readonly TypePreset[] = [
  {
    id: 'dwarfai',
    faces: { display: 'jacquard-12', label: 'tiny5', meta: 'pixelify-sans', talk: 'pixelify-sans' },
    sizes: SHARP_SIZES
  },
  {
    id: 'pixel-clean',
    faces: {
      display: 'pixelify-sans',
      label: 'pixelify-sans',
      meta: 'pixelify-sans',
      talk: 'pixelify-sans'
    },
    sizes: SHARP_SIZES
  },
  {
    id: 'readable',
    faces: { display: 'roboto', label: 'roboto', meta: 'roboto', talk: 'roboto' },
    sizes: SHARP_SIZES
  }
]

/** What paints before anything applies a preset; design-tokens.css spells the same values. */
export const DEFAULT_TYPE_PRESET: TypePresetId = 'dwarfai'

/**
 * The custom properties one preset sets on the document root.
 *
 * A face is answered as a `var()` reference to its `--font-family-*` stack rather than the stack
 * itself, so each stack stays declared once in design-tokens.css. A fresh record every call, so a
 * caller that edits what it got cannot edit the preset.
 */
export function resolveTypePreset(id: TypePresetId): Record<string, string> {
  const preset = TYPE_PRESETS.find((candidate) => candidate.id === id)
  if (preset === undefined) throw new Error(`Unknown type preset: ${id}`)
  const resolved: Record<string, string> = {}
  for (const role of Object.keys(TYPE_ROLE_PROPERTIES) as TypeRole[]) {
    resolved[TYPE_ROLE_PROPERTIES[role]] = `var(--font-family-${preset.faces[role]})`
  }
  for (const step of Object.keys(STEP_PROPERTIES) as TypeStep[]) {
    resolved[STEP_PROPERTIES[step]] = `${preset.sizes[step]}px`
  }
  return resolved
}
