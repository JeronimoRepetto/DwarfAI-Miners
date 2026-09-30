import { readFile, rename, writeFile } from 'node:fs/promises'
import {
  TYPE_PRESET_FACES,
  TYPE_PRESET_IDS,
  isTypeFaceFor,
  parseTypographyPreferences,
  type TypographyPreferences
} from '../domain/types'

/**
 * The persisted Typography settings (#370, #635): the font style Settings › Appearance picked,
 * and the face each type role is drawn in.
 *
 * Storage deliberately mirrors the pin, edge, shortcut and audio preferences
 * (src/main/shell/audioPreference.ts and its siblings): one tiny JSON document under userData,
 * rewritten atomically through a sibling temp file plus a rename, with an injected fs so the tests
 * need no real disk and Electron is never imported here — the wiring in src/main/index.ts owns
 * the userData paths, keeping this module unit-testable without an app instance.
 *
 * It is in `shell/` with those four rather than in a directory of its own because it is the same
 * subject they are: a preference somebody sets in the app about how the app itself presents. Main
 * never reads a face — it only stores one and hands it back.
 *
 * Why a preference store and not a key in the three-layer config: a font is something a person
 * picks in Settings, not something an operator configures, so it has no business being settable
 * from `.env` and it must be writable at runtime. See the `config-layering` skill.
 *
 * The PARSER is shared with the preload and the renderer rather than written here — it is
 * `parseTypographyPreferences` in `shared/contracts.ts`, because all three read the same document
 * and a second reading of it would be a second answer that could disagree.
 *
 * ## The one-time migration (#635)
 *
 * #370 stored two faces, Interface and Messaging, in its own document. The type presets replace
 * them, and handoff.md ("Typography preference migration", design lead ruling 2026-09-25) says how
 * each pair moves: `migrateLegacyTypography` below. The new model lives in a NEW document beside
 * the old one rather than over it, and that is the whole safety of the migration:
 *
 * - the old document is never written, so a person's #370 choice is never lost, whatever happens
 *   to the new file, and an older build still reads what it wrote;
 * - "migrated" is simply "the new document exists", so the migration is idempotent by
 *   construction — a second start reads the new document and writes nothing;
 * - a start with neither document writes nothing either, since nothing was chosen.
 *
 * Nothing here fails startup. A corrupt document is the shape half of the `config-layering` rule —
 * indistinguishable from one never written — but it is never degraded QUIETLY: `onWarn` names the
 * file, and the corrupt bytes are left where they are for a person to read.
 */

/** Sibling suffix for the atomic write; same directory keeps rename on one volume. */
const TEMP_SUFFIX = '.tmp'

export interface TypographyPreferenceFsLike {
  readFile: (path: string, encoding: 'utf8') => Promise<string>
  writeFile: (path: string, data: string, encoding: 'utf8') => Promise<void>
  rename: (from: string, to: string) => Promise<void>
}

const realFs: TypographyPreferenceFsLike = { readFile, writeFile, rename }

/**
 * Pure inverse of `parseTypographyPreferences`, newline-terminated like the other markers — and it
 * PARSES what it was handed on the way out, so the one writer under our control cannot produce a
 * file the next startup would have to correct. A stored Tiny5 message face that reads back as
 * Pixelify Sans is a document that lies about the choice it records.
 */
export function serializeTypographyPreferences(preferences: TypographyPreferences): string {
  const clean = parseTypographyPreferences(preferences)
  return `${JSON.stringify(clean)}\n`
}

/*
 * #370's vocabulary, kept only to read its document: the Interface faces, and the Messaging faces,
 * the same list minus Tiny5 (a single-weight pixel face cannot draw bold or carry a paragraph). It
 * is no longer a wire shape, so it lives here and not in contracts.ts.
 */
const LEGACY_INTERFACE_FONTS = ['tiny5', 'pixelify-sans', 'roboto', 'arial'] as const
const LEGACY_MESSAGING_FONTS = ['pixelify-sans', 'roboto', 'arial'] as const
type LegacyInterfaceFont = (typeof LEGACY_INTERFACE_FONTS)[number]
type LegacyMessagingFont = (typeof LEGACY_MESSAGING_FONTS)[number]

/**
 * The #370 document to its style and faces, once (handoff.md, "Typography preference migration").
 *
 * The old document is first read exactly as #370 read it — field by field, a face it could not
 * draw reading as its default (Tiny5, Pixelify Sans) — so the migration keeps what the person
 * actually SAW, not what the file happened to spell. Then:
 *
 * | Interface     | Messaging     | Becomes     |
 * | ------------- | ------------- | ----------- |
 * | Tiny5         | Pixelify Sans | DwarfAI     |
 * | Pixelify Sans | Pixelify Sans | Pixel clean |
 * | Roboto        | Roboto        | Readable    |
 * | any other pair               || Custom      |
 *
 * Custom keeps each old face in the roles that allow it: Titles Jacquard 12; Labels the old
 * Interface face, which Labels always offers; Small text the old Interface face where Small text
 * offers it, else Pixelify Sans (a Tiny5 interface); Messages the old Messaging face, which
 * Messages always offers.
 */
export function migrateLegacyTypography(document: Record<string, unknown>): TypographyPreferences {
  const interfaceFont: LegacyInterfaceFont = LEGACY_INTERFACE_FONTS.includes(
    document.interfaceFont as LegacyInterfaceFont
  )
    ? (document.interfaceFont as LegacyInterfaceFont)
    : 'tiny5'
  const messagingFont: LegacyMessagingFont = LEGACY_MESSAGING_FONTS.includes(
    document.messagingFont as LegacyMessagingFont
  )
    ? (document.messagingFont as LegacyMessagingFont)
    : 'pixelify-sans'
  const preset = TYPE_PRESET_IDS.find(
    (id) => LEGACY_PAIRS[id][0] === interfaceFont && LEGACY_PAIRS[id][1] === messagingFont
  )
  if (preset !== undefined) return { style: preset, faces: { ...TYPE_PRESET_FACES[preset] } }
  return {
    style: 'custom',
    faces: {
      display: 'jacquard-12',
      label: interfaceFont,
      meta: isTypeFaceFor('meta', interfaceFont) ? interfaceFont : 'pixelify-sans',
      talk: messagingFont
    }
  }
}

/** The one pair each preset is, as the table names them; every other pair becomes Custom. */
const LEGACY_PAIRS: Readonly<
  Record<(typeof TYPE_PRESET_IDS)[number], readonly [LegacyInterfaceFont, LegacyMessagingFont]>
> = {
  dwarfai: ['tiny5', 'pixelify-sans'],
  'pixel-clean': ['pixelify-sans', 'pixelify-sans'],
  readable: ['roboto', 'roboto']
}

export interface TypographyPreferenceStore {
  /** The stored choice, migrated from #370's document once, or the documented defaults. */
  load: () => Promise<TypographyPreferences>
  /** Persist atomically. Rejections are the caller's to log — the change already happened. */
  save: (preferences: TypographyPreferences) => Promise<void>
}

export interface TypographyPreferenceStoreOptions {
  /** Full path of the preference file (under userData in production). */
  filePath: string
  /** Full path of #370's document, read once when `filePath` holds nothing. */
  legacyFilePath?: string
  /** Injected for tests; defaults to the real filesystem. */
  fs?: TypographyPreferenceFsLike
  /** Where a discarded or unwritable document is reported; defaults to console.warn. */
  onWarn?: (message: string) => void
}

/** What reading one file found: nothing there, bytes that are not JSON, or a parsed value. */
type Read = { kind: 'absent' } | { kind: 'corrupt' } | { kind: 'read'; value: unknown }

export function createTypographyPreferenceStore(
  options: TypographyPreferenceStoreOptions
): TypographyPreferenceStore {
  const fs = options.fs ?? realFs
  const warn = options.onWarn ?? ((message: string) => console.warn(message))

  async function read(path: string): Promise<Read> {
    let raw: string
    try {
      raw = await fs.readFile(path, 'utf8')
    } catch {
      // Missing file is the common first-run case; any other read failure (permissions, transient
      // IO) is treated the same way because a preference is never worth failing startup over.
      return { kind: 'absent' }
    }
    try {
      return { kind: 'read', value: JSON.parse(raw) }
    } catch {
      return { kind: 'corrupt' }
    }
  }

  async function save(preferences: TypographyPreferences): Promise<void> {
    const tempPath = `${options.filePath}${TEMP_SUFFIX}`
    await fs.writeFile(tempPath, serializeTypographyPreferences(preferences), 'utf8')
    await fs.rename(tempPath, options.filePath)
  }

  /** #370's choice in the new model, or undefined when its document holds none. */
  async function legacy(): Promise<TypographyPreferences | undefined> {
    if (options.legacyFilePath === undefined) return undefined
    const found = await read(options.legacyFilePath)
    if (found.kind === 'corrupt') {
      warn(
        `[typography] ${options.legacyFilePath} is not readable JSON; the typography choice it held could not be migrated, so the default style is used.`
      )
      return undefined
    }
    const value = found.kind === 'read' ? found.value : undefined
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    return migrateLegacyTypography(value as Record<string, unknown>)
  }

  async function load(): Promise<TypographyPreferences> {
    const found = await read(options.filePath)
    if (found.kind === 'read') return parseTypographyPreferences(found.value)
    if (found.kind === 'corrupt') {
      const recovered = await legacy()
      warn(
        `[typography] ${options.filePath} is not readable JSON; ` +
          (recovered === undefined
            ? 'the default style is used until a style is chosen again.'
            : 'the choice migrated from the previous typography document is used until a style is chosen again.')
      )
      return recovered ?? parseTypographyPreferences(undefined)
    }
    // One migration per store: the shell and the message panel each ask as they mount, and two
    // migrations racing through one temp file would tear the rename. Forgotten once it settles, so
    // a later load reads whatever the disk holds by then.
    migrating ??= migrate().finally(() => {
      migrating = undefined
    })
    return migrating
  }

  let migrating: Promise<TypographyPreferences> | undefined

  async function migrate(): Promise<TypographyPreferences> {
    const migrated = await legacy()
    if (migrated === undefined) return parseTypographyPreferences(undefined)
    try {
      await save(migrated)
    } catch (error) {
      warn(
        `[typography] Could not write the migrated typography choice to ${options.filePath} (${String(error)}); the next start migrates it again.`
      )
    }
    return migrated
  }

  return { load, save }
}
