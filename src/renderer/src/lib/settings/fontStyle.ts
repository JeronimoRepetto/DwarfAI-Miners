import {
  TYPE_PRESET_FACES,
  type FontStyle,
  type TypeFace,
  type TypeRole,
  type TypographyPreferences
} from '../../types'

/**
 * Settings › Appearance (#635): the Font style list — the three presets and Custom, one row each
 * that previews its own title, label and message faces (PO ruling 2026-09-25) — and, under Custom,
 * one select per role (screens/settings.md, As built; foundations.md, Presets and Custom).
 *
 * What a press means is decided here from the choice in force, and answered as the whole document
 * main stores: a preset is exactly its faces, Custom opens on the faces of the style it leaves so
 * nothing on screen jumps, and a role's face changes that role alone. The component only draws;
 * the copy is the design's, word for word.
 */

export interface FontStyleOption {
  id: FontStyle
  label: string
  note: string
}

/** In the order Settings lists them. */
export const FONT_STYLE_OPTIONS: readonly FontStyleOption[] = [
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
]

/**
 * The three faces a row previews — its title, label and message faces, in that order: a preset's
 * own, and for Custom the faces in force.
 */
export function fontStyleSample(
  style: FontStyle,
  current: TypographyPreferences
): [TypeFace, TypeFace, TypeFace] {
  const faces = style === 'custom' ? current.faces : TYPE_PRESET_FACES[style]
  return [faces.display, faces.label, faces.talk]
}

/** The whole choice a press on a Font style row asks for. */
export function pickFontStyle(
  current: TypographyPreferences,
  style: FontStyle
): TypographyPreferences {
  return style === 'custom'
    ? { style, faces: { ...current.faces } }
    : { style, faces: { ...TYPE_PRESET_FACES[style] } }
}

/** The whole choice a Custom role's select asks for: that role's face, the others kept. */
export function pickRoleFace(
  current: TypographyPreferences,
  role: TypeRole,
  face: TypeFace
): TypographyPreferences {
  return { style: 'custom', faces: { ...current.faces, [role]: face } }
}

export interface RoleRow {
  role: TypeRole
  label: string
  help: string
}

/** Custom's rows, in the order Titles, Labels, Small text, Messages. */
export const ROLE_ROWS: readonly RoleRow[] = [
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
]

const STEP: Readonly<Record<string, 1 | -1>> = {
  ArrowDown: 1,
  ArrowRight: 1,
  ArrowUp: -1,
  ArrowLeft: -1
}

/**
 * Where an arrow key moves the Font style radiogroup from `style`, wrapping at both ends; undefined
 * for any other key (components.md, Settings, Accessibility: moved with arrow keys).
 */
export function steppedFontStyle(style: FontStyle, key: string): FontStyle | undefined {
  const step = STEP[key]
  if (step === undefined) return undefined
  const ids = FONT_STYLE_OPTIONS.map((option) => option.id)
  return ids[(ids.indexOf(style) + step + ids.length) % ids.length]
}
