// The values of the persisted UI preference stores (ADR-024 item 1): each store's defaults, the one stored form of a
// value (what a setter stores and answers, ADR-024 item 9), and the one-time reading of the older two-choice
// typography preference (US-SET-003.AC07). Pure: no I/O, no clock.
import type {
  TypographyPreferences,
  UiPreferenceStoreKey,
  UiPreferenceStoreMap
} from '../ports/uiPreferenceStore'

type TypeFace = TypographyPreferences['faces']['display']
type TypeRole = keyof TypographyPreferences['faces']
type TypePresetId = Exclude<TypographyPreferences['style'], 'custom'>

/** The faces of each preset (US-SET-003; the design's Presets and Custom). */
export const TYPE_PRESET_FACES: Readonly<
  Record<TypePresetId, Readonly<TypographyPreferences['faces']>>
> = {
  dwarfai: { display: 'jacquard-12', label: 'tiny5', meta: 'pixelify-sans', talk: 'pixelify-sans' },
  'pixel-clean': {
    display: 'pixelify-sans',
    label: 'pixelify-sans',
    meta: 'pixelify-sans',
    talk: 'pixelify-sans'
  },
  readable: { display: 'roboto', label: 'roboto', meta: 'roboto', talk: 'roboto' }
}

/** The faces each role offers under Custom: blackletter only for Titles, Tiny5 never for Small text or Messages. */
export const TYPE_ROLE_FACES: Readonly<Record<TypeRole, readonly TypeFace[]>> = {
  display: ['jacquard-12', 'tiny5', 'pixelify-sans', 'roboto', 'arial'],
  label: ['tiny5', 'pixelify-sans', 'roboto', 'arial'],
  meta: ['pixelify-sans', 'roboto', 'arial'],
  talk: ['pixelify-sans', 'roboto', 'arial']
}

/** What each store holds before anything was stored, or after its file was unusable (FM-053). */
export const UI_PREFERENCE_DEFAULTS: Readonly<UiPreferenceStoreMap> = {
  audio: {
    musicAtStartup: true,
    musicVolume: 0.1,
    ambienceVolume: 1,
    voiceVolume: 0.7,
    notificationSounds: true
  },
  typography: { style: 'dwarfai', faces: { ...TYPE_PRESET_FACES.dwarfai } },
  // US-SHELL-006.AC02: a first launch opens the Map page with no mine.
  launchView: { area: 'map', mineId: null },
  dockSide: 'right',
  alwaysOnTop: true,
  shortcut: null
}

/** A fresh copy of a store's defaults, so a caller that edits it cannot edit the defaults. */
export function defaultsOf<K extends UiPreferenceStoreKey>(key: K): UiPreferenceStoreMap[K] {
  return structuredClone(UI_PREFERENCE_DEFAULTS[key])
}

/** A volume as stored: a fraction in 0..1 (a slider cannot mean more than all of it, or less than none). */
function storedVolume(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/**
 * Typography as stored: a preset is drawn in its own faces, whatever faces came with it (US-SET-003.AC02); under
 * Custom each role keeps its face when the role offers it, else the DwarfAI face of that role.
 */
function storedTypography(value: TypographyPreferences): TypographyPreferences {
  if (value.style !== 'custom') {
    return { style: value.style, faces: { ...TYPE_PRESET_FACES[value.style] } }
  }
  const faces = { ...TYPE_PRESET_FACES.dwarfai }
  for (const role of Object.keys(faces) as TypeRole[]) {
    if (TYPE_ROLE_FACES[role].includes(value.faces[role])) faces[role] = value.faces[role]
  }
  return { style: 'custom', faces }
}

type StoredForms = {
  readonly [K in UiPreferenceStoreKey]: (v: UiPreferenceStoreMap[K]) => UiPreferenceStoreMap[K]
}

const STORED_FORMS: StoredForms = {
  audio: (v) => ({
    musicAtStartup: v.musicAtStartup,
    musicVolume: storedVolume(v.musicVolume),
    ambienceVolume: storedVolume(v.ambienceVolume),
    voiceVolume: storedVolume(v.voiceVolume),
    notificationSounds: v.notificationSounds
  }),
  typography: storedTypography,
  // An empty mine id names no mine.
  launchView: (v) => ({ area: v.area, mineId: v.mineId === '' ? null : v.mineId }),
  dockSide: (v) => v,
  alwaysOnTop: (v) => v,
  shortcut: (v) => v
}

/** The one stored form of `value` for `key`: what a setter stores and answers (ADR-024 item 9). */
export function storedFormOf<K extends UiPreferenceStoreKey>(
  key: K,
  value: UiPreferenceStoreMap[K]
): UiPreferenceStoreMap[K] {
  return (STORED_FORMS[key] as (v: UiPreferenceStoreMap[K]) => UiPreferenceStoreMap[K])(value)
}

/** The faces of the older two-choice preference: Interface, and Messaging (which never offered Tiny5). */
const OLDER_INTERFACE_FACES: readonly TypeFace[] = ['tiny5', 'pixelify-sans', 'roboto', 'arial']
const OLDER_MESSAGING_FACES: readonly TypeFace[] = ['pixelify-sans', 'roboto', 'arial']

/** The one pair each preset is; every other pair becomes Custom (US-SET-003.AC07). */
const OLDER_PAIRS: Readonly<Record<TypePresetId, readonly [TypeFace, TypeFace]>> = {
  dwarfai: ['tiny5', 'pixelify-sans'],
  'pixel-clean': ['pixelify-sans', 'pixelify-sans'],
  readable: ['roboto', 'roboto']
}

/**
 * The older two-choice typography preference (Interface and Messaging faces) in the preset model (US-SET-003.AC07).
 * Each face is first read as the older build read it, a face it could not draw reading as its default there (Tiny5,
 * Pixelify Sans), so the person keeps what they saw. Tiny5 + Pixelify Sans is DwarfAI, Pixelify Sans + Pixelify Sans
 * is Pixel clean, Roboto + Roboto is Readable; any other pair is Custom: Titles Jacquard 12, Labels the old Interface
 * face, Small text the old Interface face where it is offered (else Pixelify Sans), Messages the old Messaging face.
 */
export function migrateTwoChoiceTypography(document: unknown): TypographyPreferences {
  const record =
    typeof document === 'object' && document !== null && !Array.isArray(document)
      ? (document as Record<string, unknown>)
      : {}
  const interfaceFace = OLDER_INTERFACE_FACES.find((f) => f === record.interfaceFont) ?? 'tiny5'
  const messagingFace =
    OLDER_MESSAGING_FACES.find((f) => f === record.messagingFont) ?? 'pixelify-sans'
  const preset = (Object.keys(OLDER_PAIRS) as TypePresetId[]).find(
    (id) => OLDER_PAIRS[id][0] === interfaceFace && OLDER_PAIRS[id][1] === messagingFace
  )
  if (preset !== undefined) return { style: preset, faces: { ...TYPE_PRESET_FACES[preset] } }
  return {
    style: 'custom',
    faces: {
      display: 'jacquard-12',
      label: interfaceFace,
      meta: TYPE_ROLE_FACES.meta.includes(interfaceFace) ? interfaceFace : 'pixelify-sans',
      talk: messagingFace
    }
  }
}
