import {
  TYPE_PRESET_FACES,
  TYPE_ROLES,
  type TypeFace,
  type TypePresetId,
  type TypeRole,
  type TypeRoleFaces,
  type TypographyPreferences
} from '../../types'

/**
 * The type presets Settings offers, as data, and the pure step from a stored choice to the custom
 * properties that paint it (#635).
 *
 * Type is four roles, and a component names a role and a size token, never a face. A preset is
 * therefore only an answer for each role plus the sizes its faces are sharp at: a pixel face is
 * crisp at whole multiples of its em grid, and choosing a preset or a Custom face turns that
 * snapping on, which is why the sizes travel with the faces instead of staying in the stylesheet.
 *
 * Nothing here touches the document or the stored preference. `useTypography` applies the record;
 * the preset faces themselves are contracts.ts's, because main's one-time migration reads them too.
 */

export type { TypeFace, TypePresetId, TypeRole }

export type TypeStep = 'title' | 'headline' | 'section' | 'meta' | 'body'

export interface TypePreset {
  id: TypePresetId
  faces: Readonly<TypeRoleFaces>
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
 * The size each step asks for (foundations.md, The resulting scale), and the role whose face draws
 * it: titles and headlines are the Titles role, a section is a Label, meta is Small text and the
 * body is what is said.
 */
const ASKED: Readonly<Record<TypeStep, number>> = {
  title: 21,
  headline: 21,
  section: 16,
  meta: 12,
  body: 14
}
const STEP_ROLE: Readonly<Record<TypeStep, TypeRole>> = {
  title: 'display',
  headline: 'display',
  section: 'label',
  meta: 'meta',
  body: 'talk'
}

/*
 * Each pixel face's em grid and x-height, in font units (foundations.md, Every face the type lab
 * knows). A face absent here is a vector face, sharp at any size.
 */
const PIXEL_GRID: Readonly<Partial<Record<TypeFace, { em: number; xHeight: number }>>> = {
  tiny5: { em: 8, xHeight: 4 },
  'jacquard-12': { em: 21, xHeight: 8 }
}

/** The smallest x-height, in screen pixels, a snapped face may draw at. */
const MIN_X_HEIGHT_PX = 7

/**
 * The size a face is sharp at, nearest to the one asked (foundations.md, The crisp-size rule): a
 * whole multiple of its em grid, raised until its x-height reaches 7 screen pixels. Tiny5 asked at
 * 21 is 24; Jacquard 12 asked at anything up to 26 is 21; a vector face keeps the size asked.
 */
export function crispSize(face: TypeFace, asked: number): number {
  const grid = PIXEL_GRID[face]
  if (grid === undefined) return asked
  let multiple = Math.max(1, Math.round(asked / grid.em))
  while (multiple * grid.xHeight < MIN_X_HEIGHT_PX) multiple += 1
  return multiple * grid.em
}

function sharpSizes(faces: Readonly<TypeRoleFaces>): Record<TypeStep, number> {
  const sizes = {} as Record<TypeStep, number>
  for (const step of Object.keys(ASKED) as TypeStep[]) {
    sizes[step] = crispSize(faces[STEP_ROLE[step]], ASKED[step])
  }
  return sizes
}

/** In the order Settings lists them. Every preset lands on the scale's own sizes. */
export const TYPE_PRESETS: readonly TypePreset[] = (
  Object.keys(TYPE_PRESET_FACES) as TypePresetId[]
).map((id) => ({ id, faces: TYPE_PRESET_FACES[id], sizes: sharpSizes(TYPE_PRESET_FACES[id]) }))

/** What paints before anything applies a preset; design-tokens.css spells the same values. */
export const DEFAULT_TYPE_PRESET: TypePresetId = 'dwarfai'

/**
 * The custom properties a set of faces paints with, at the sizes they are sharp at.
 *
 * A face is answered as a `var()` reference to its `--font-family-*` stack rather than the stack
 * itself, so each stack stays declared once in design-tokens.css. A fresh record every call, so a
 * caller that edits what it got cannot edit a preset.
 */
function resolveFaces(faces: Readonly<TypeRoleFaces>): Record<string, string> {
  const resolved: Record<string, string> = {}
  for (const role of TYPE_ROLES) {
    resolved[TYPE_ROLE_PROPERTIES[role]] = `var(--font-family-${faces[role]})`
  }
  const sizes = sharpSizes(faces)
  for (const step of Object.keys(STEP_PROPERTIES) as TypeStep[]) {
    resolved[STEP_PROPERTIES[step]] = `${sizes[step]}px`
  }
  return resolved
}

/** The custom properties one preset sets on the document root. */
export function resolveTypePreset(id: TypePresetId): Record<string, string> {
  const preset = TYPE_PRESETS.find((candidate) => candidate.id === id)
  if (preset === undefined) throw new Error(`Unknown type preset: ${id}`)
  return resolveFaces(preset.faces)
}

/**
 * The custom properties a stored choice sets on the document root: a preset's own, or Custom's
 * faces role by role, with crisp sizes on either way.
 */
export function resolveTypography(preferences: TypographyPreferences): Record<string, string> {
  return preferences.style === 'custom'
    ? resolveFaces(preferences.faces)
    : resolveTypePreset(preferences.style)
}
