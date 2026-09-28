import { describe, expect, it } from 'vitest'
import { DEFAULT_TYPOGRAPHY_PREFERENCES, TYPE_PRESET_FACES } from '../domain/types'
import {
  createTypographyPreferenceStore,
  migrateLegacyTypography,
  serializeTypographyPreferences,
  type TypographyPreferenceFsLike
} from './typographyPreference'

/** The same in-memory shape the pin, edge and audio preference tests use. */
function fakeFs(initial?: string): TypographyPreferenceFsLike & { files: Map<string, string> } {
  const files = new Map<string, string>()
  if (initial !== undefined) files.set('/typography.json', initial)
  return {
    files,
    readFile: (path) => {
      const held = files.get(path)
      if (held === undefined) return Promise.reject(new Error(`ENOENT ${path}`))
      return Promise.resolve(held)
    },
    writeFile: (path, data) => {
      files.set(path, data)
      return Promise.resolve()
    },
    rename: (from, to) => {
      const held = files.get(from)
      if (held === undefined) return Promise.reject(new Error(`ENOENT ${from}`))
      files.delete(from)
      files.set(to, held)
      return Promise.resolve()
    }
  }
}

const FILE = '/typography-v2.json'
const LEGACY = '/typography-v1.json'

/** A store over the fake fs, with every warning it gave kept for the test to read. */
function storeOver(fs: ReturnType<typeof fakeFs>, withLegacy = true) {
  const warnings: string[] = []
  const store = createTypographyPreferenceStore({
    filePath: FILE,
    ...(withLegacy ? { legacyFilePath: LEGACY } : {}),
    fs,
    onWarn: (message) => warnings.push(message)
  })
  return { store, warnings }
}

/** A fake fs holding these files, counting every write so a migration's writes can be told. */
function filesOf(files: Record<string, string>) {
  const fs = fakeFs()
  for (const [path, data] of Object.entries(files)) fs.files.set(path, data)
  const writes: string[] = []
  const writeFile = fs.writeFile
  fs.writeFile = (path, data, encoding) => {
    writes.push(path)
    return writeFile(path, data, encoding)
  }
  return Object.assign(fs, { writes })
}

const CUSTOM = {
  style: 'custom',
  faces: { display: 'tiny5', label: 'roboto', meta: 'arial', talk: 'pixelify-sans' }
} as const

describe('serializeTypographyPreferences', () => {
  // AMENDED (#635): was "writes the two fields, newline-terminated like the other markers", on the
  // two-face document.
  it('writes the style and the four faces, newline-terminated like the other markers', () => {
    expect(serializeTypographyPreferences(CUSTOM)).toBe(
      '{"style":"custom","faces":{"display":"tiny5","label":"roboto","meta":"arial","talk":"pixelify-sans"}}\n'
    )
  })

  // AMENDED (#635): the same round trip, on the new document.
  it('round-trips through the shared parser, so what is written can be read', async () => {
    const { store } = storeOver(filesOf({}))
    await store.save(CUSTOM)
    expect(await store.load()).toEqual(CUSTOM)
  })
})

describe('createTypographyPreferenceStore', () => {
  it('answers with the documented defaults on a first run, with no file to read', async () => {
    const fs = filesOf({})
    const { store } = storeOver(fs)
    expect(await store.load()).toEqual(DEFAULT_TYPOGRAPHY_PREFERENCES)
    // Nothing was chosen, so there is nothing to write down.
    expect(fs.writes).toEqual([])
  })

  // AMENDED (#635): was the two-face document read back.
  it('reads back what a previous run stored', async () => {
    const { store } = storeOver(filesOf({ [FILE]: JSON.stringify(CUSTOM) }))
    expect(await store.load()).toEqual(CUSTOM)
  })

  // AMENDED (#635): it still never blocks startup, and now also says so by name rather than
  // starting on the defaults quietly (the config-layering rule).
  it('treats a corrupt file exactly like a missing one, never blocking startup, and warns by name', async () => {
    const fs = filesOf({ [FILE]: '{ this is not json' })
    const { store, warnings } = storeOver(fs, false)
    expect(await store.load()).toEqual(DEFAULT_TYPOGRAPHY_PREFERENCES)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(FILE)
    // The bytes stay where they are for a person to read: only a real choice overwrites them.
    expect(fs.writes).toEqual([])
    expect(fs.files.get(FILE)).toBe('{ this is not json')
  })

  // AMENDED (#635): was "keeps the field it can read out of a partly broken document".
  it('keeps the faces it can read out of a partly broken document', async () => {
    const { store } = storeOver(
      filesOf({ [FILE]: '{"style":"custom","faces":{"display":"arial","label":"wingdings"}}' })
    )
    expect(await store.load()).toEqual({
      style: 'custom',
      faces: { ...DEFAULT_TYPOGRAPHY_PREFERENCES.faces, display: 'arial' }
    })
  })

  // AMENDED (#635): was "reads a hand-edited Tiny5 messaging face as the default, keeping the
  // interface choice".
  it('reads a hand-edited Tiny5 message face as the default, keeping the other roles', async () => {
    // The exclusion is a rule about the document, not about the Settings UI: this file is one a
    // person can open, and Tiny5 has one display weight.
    const { store } = storeOver(
      filesOf({
        [FILE]:
          '{"style":"custom","faces":{"display":"roboto","label":"roboto","meta":"roboto","talk":"tiny5"}}'
      })
    )
    expect(await store.load()).toEqual({
      style: 'custom',
      faces: { display: 'roboto', label: 'roboto', meta: 'roboto', talk: 'pixelify-sans' }
    })
  })

  it('treats any other read failure the same way, because a preference is not worth failing over', async () => {
    const store = createTypographyPreferenceStore({
      filePath: FILE,
      legacyFilePath: LEGACY,
      fs: {
        readFile: () => Promise.reject(new Error('EACCES')),
        writeFile: () => Promise.resolve(),
        rename: () => Promise.resolve()
      },
      onWarn: () => {}
    })
    expect(await store.load()).toEqual(DEFAULT_TYPOGRAPHY_PREFERENCES)
  })

  it('writes to a sibling temp file and renames it on, so a crash cannot tear the document', async () => {
    const fs = filesOf({})
    const { store } = storeOver(fs)
    await store.save(DEFAULT_TYPOGRAPHY_PREFERENCES)
    // The temp file is gone and only the final path is left: the rename moved it.
    expect([...fs.files.keys()]).toEqual([FILE])
    expect(fs.writes).toEqual([FILE + '.tmp'])
  })

  // AMENDED (#635): was the two-face version, a Tiny5 messaging face written as Pixelify Sans.
  it('refuses to persist a face the next startup would have to correct', async () => {
    // The one writer under our control cannot produce a file that reads back as something else —
    // the same discipline the audio store holds.
    const fs = filesOf({})
    const { store } = storeOver(fs)
    await store.save({
      style: 'custom',
      faces: { display: 'arial', label: 'arial', meta: 'tiny5', talk: 'tiny5' }
    } as unknown as Parameters<typeof store.save>[0])
    expect(JSON.parse(fs.files.get(FILE)!)).toEqual({
      style: 'custom',
      faces: { display: 'arial', label: 'arial', meta: 'pixelify-sans', talk: 'pixelify-sans' }
    })
  })
})

/*
 * The one-time migration of #370's two stored faces to a font style (#635), exactly as handoff.md
 * ("Typography preference migration") tabulates it: a pair that is exactly a preset becomes that
 * preset; any other pair becomes Custom — Titles Jacquard 12, Labels the old Interface face (Labels
 * offers every face Interface did), Small text the old Interface face where Small text offers it
 * and Pixelify Sans otherwise, Messages the old Messaging face. Every one of the twelve pairs the
 * old document could hold is written out rather than computed, so the table and the code cannot
 * agree by sharing a mistake.
 */
describe('migrateLegacyTypography', () => {
  const custom = (label: string, meta: string, talk: string) => ({
    style: 'custom',
    faces: { display: 'jacquard-12', label, meta, talk }
  })
  const preset = (style: 'dwarfai' | 'pixel-clean' | 'readable') => ({
    style,
    faces: TYPE_PRESET_FACES[style]
  })

  it.each([
    ['tiny5', 'pixelify-sans', preset('dwarfai')],
    ['pixelify-sans', 'pixelify-sans', preset('pixel-clean')],
    ['roboto', 'roboto', preset('readable')],
    ['tiny5', 'roboto', custom('tiny5', 'pixelify-sans', 'roboto')],
    ['tiny5', 'arial', custom('tiny5', 'pixelify-sans', 'arial')],
    ['pixelify-sans', 'roboto', custom('pixelify-sans', 'pixelify-sans', 'roboto')],
    ['pixelify-sans', 'arial', custom('pixelify-sans', 'pixelify-sans', 'arial')],
    ['roboto', 'pixelify-sans', custom('roboto', 'roboto', 'pixelify-sans')],
    ['roboto', 'arial', custom('roboto', 'roboto', 'arial')],
    ['arial', 'pixelify-sans', custom('arial', 'arial', 'pixelify-sans')],
    ['arial', 'roboto', custom('arial', 'arial', 'roboto')],
    ['arial', 'arial', custom('arial', 'arial', 'arial')]
  ])('moves Interface %s with Messaging %s to the style handoff.md names', (i, m, expected) => {
    expect(migrateLegacyTypography({ interfaceFont: i, messagingFont: m })).toEqual(expected)
  })

  it('reads the old document as #370 did, field by field, before mapping it', () => {
    // A Tiny5 message face was never drawn (it read as Pixelify Sans), and an unknown face read as
    // the default: the migration keeps what the person actually saw, not what the file spelled.
    expect(migrateLegacyTypography({ interfaceFont: 'roboto', messagingFont: 'tiny5' })).toEqual(
      custom('roboto', 'roboto', 'pixelify-sans')
    )
    expect(migrateLegacyTypography({ interfaceFont: 'arial', messagingFont: 'wingdings' })).toEqual(
      custom('arial', 'arial', 'pixelify-sans')
    )
    expect(migrateLegacyTypography({ interfaceFont: 'papyrus', messagingFont: 'roboto' })).toEqual(
      custom('tiny5', 'pixelify-sans', 'roboto')
    )
  })

  it('reads a document with neither face as the defaults #370 painted, which is DwarfAI', () => {
    expect(migrateLegacyTypography({})).toEqual(preset('dwarfai'))
  })
})

describe('createTypographyPreferenceStore — migrating the #370 document once', () => {
  const OLD = '{"interfaceFont":"roboto","messagingFont":"arial"}'
  const MIGRATED = {
    style: 'custom',
    faces: { display: 'jacquard-12', label: 'roboto', meta: 'roboto', talk: 'arial' }
  }

  it('answers with the old choice in the new model when only the old document exists', async () => {
    const { store } = storeOver(filesOf({ [LEGACY]: OLD }))
    expect(await store.load()).toEqual(MIGRATED)
  })

  it('writes the migrated document once, atomically, and leaves the old one untouched', async () => {
    const fs = filesOf({ [LEGACY]: OLD })
    const { store } = storeOver(fs)
    await store.load()
    expect(fs.writes).toEqual([FILE + '.tmp'])
    expect(JSON.parse(fs.files.get(FILE)!)).toEqual(MIGRATED)
    // The old document stays as it was: an older build reads it still, and nothing is lost.
    expect(fs.files.get(LEGACY)).toBe(OLD)
    expect(fs.files.has(FILE + '.tmp')).toBe(false)
  })

  it('is idempotent: a second start reads the new document and writes nothing', async () => {
    const fs = filesOf({ [LEGACY]: OLD })
    const { store } = storeOver(fs)
    const first = await store.load()
    const second = await store.load()
    expect(second).toEqual(first)
    expect(fs.writes).toEqual([FILE + '.tmp'])
    // A fresh store over the same disk, as the next launch has, writes nothing either.
    const next = storeOver(fs)
    expect(await next.store.load()).toEqual(first)
    expect(fs.writes).toEqual([FILE + '.tmp'])
  })

  it('migrates once when both windows ask at the same start', async () => {
    // The shell and the message panel each read the choice as they mount; two migrations racing
    // through one temp file would tear the rename.
    const fs = filesOf({ [LEGACY]: OLD })
    const { store, warnings } = storeOver(fs)
    const [a, b] = await Promise.all([store.load(), store.load()])
    expect(a).toEqual(MIGRATED)
    expect(b).toEqual(MIGRATED)
    expect(fs.writes).toEqual([FILE + '.tmp'])
    expect(warnings).toEqual([])
  })

  it('never reads the old document again once the new one holds a choice', async () => {
    const fs = filesOf({ [LEGACY]: OLD, [FILE]: '{"style":"readable"}' })
    const { store } = storeOver(fs)
    expect(await store.load()).toEqual({ style: 'readable', faces: TYPE_PRESET_FACES.readable })
    expect(fs.writes).toEqual([])
  })

  it('still answers with the migrated choice when writing it down fails, and says so', async () => {
    const fs = filesOf({ [LEGACY]: OLD })
    fs.rename = () => Promise.reject(new Error('EPERM'))
    const { store, warnings } = storeOver(fs)
    expect(await store.load()).toEqual(MIGRATED)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(FILE)
    // The old document is still there, so the next start migrates it again.
    expect(fs.files.get(LEGACY)).toBe(OLD)
  })

  it('warns by name and starts on the defaults when the old document is corrupt, writing nothing', async () => {
    const fs = filesOf({ [LEGACY]: '{ not json' })
    const { store, warnings } = storeOver(fs)
    expect(await store.load()).toEqual(DEFAULT_TYPOGRAPHY_PREFERENCES)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(LEGACY)
    expect(fs.writes).toEqual([])
  })

  it('reads an old document that is not an object as no choice, writing nothing', async () => {
    const fs = filesOf({ [LEGACY]: '["roboto"]' })
    const { store } = storeOver(fs)
    expect(await store.load()).toEqual(DEFAULT_TYPOGRAPHY_PREFERENCES)
    expect(fs.writes).toEqual([])
  })

  it('recovers the old choice when the new document is corrupt, rather than the defaults', async () => {
    // The new document is the later choice, and it is gone; the old one is the best the disk still
    // holds. Nothing is written: the corrupt bytes stay for a person to read, and the warning names
    // them.
    const fs = filesOf({ [LEGACY]: OLD, [FILE]: '{ torn' })
    const { store, warnings } = storeOver(fs)
    expect(await store.load()).toEqual(MIGRATED)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(FILE)
    expect(fs.writes).toEqual([])
  })

  it('migrates nothing and writes nothing when no old document path is given', async () => {
    const fs = filesOf({ [LEGACY]: OLD })
    const { store } = storeOver(fs, false)
    expect(await store.load()).toEqual(DEFAULT_TYPOGRAPHY_PREFERENCES)
    expect(fs.writes).toEqual([])
  })
})
