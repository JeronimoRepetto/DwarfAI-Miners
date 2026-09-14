import { describe, expect, it } from 'vitest'
import { DEFAULT_TYPOGRAPHY_PREFERENCES } from '../domain/types'
import {
  createTypographyPreferenceStore,
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

describe('serializeTypographyPreferences', () => {
  it('writes the two fields, newline-terminated like the other markers', () => {
    expect(
      serializeTypographyPreferences({ interfaceFont: 'roboto', messagingFont: 'arial' })
    ).toBe('{"interfaceFont":"roboto","messagingFont":"arial"}\n')
  })

  it('round-trips through the shared parser, so what is written can be read', () => {
    const store = createTypographyPreferenceStore({ filePath: '/typography.json', fs: fakeFs() })
    const chosen = { interfaceFont: 'arial', messagingFont: 'roboto' } as const
    return store
      .save(chosen)
      .then(() => store.load())
      .then((read) => expect(read).toEqual(chosen))
  })
})

describe('createTypographyPreferenceStore', () => {
  it('answers with the documented defaults on a first run, with no file to read', async () => {
    const store = createTypographyPreferenceStore({ filePath: '/typography.json', fs: fakeFs() })
    expect(await store.load()).toEqual(DEFAULT_TYPOGRAPHY_PREFERENCES)
  })

  it('reads back what a previous run stored', async () => {
    const store = createTypographyPreferenceStore({
      filePath: '/typography.json',
      fs: fakeFs('{"interfaceFont":"pixelify-sans","messagingFont":"roboto"}')
    })
    expect(await store.load()).toEqual({
      interfaceFont: 'pixelify-sans',
      messagingFont: 'roboto'
    })
  })

  it('treats a corrupt file exactly like a missing one, never blocking startup', async () => {
    const store = createTypographyPreferenceStore({
      filePath: '/typography.json',
      fs: fakeFs('{ this is not json')
    })
    expect(await store.load()).toEqual(DEFAULT_TYPOGRAPHY_PREFERENCES)
  })

  it('keeps the field it can read out of a partly broken document', async () => {
    const store = createTypographyPreferenceStore({
      filePath: '/typography.json',
      fs: fakeFs('{"interfaceFont":"arial","messagingFont":"wingdings"}')
    })
    expect(await store.load()).toEqual({
      ...DEFAULT_TYPOGRAPHY_PREFERENCES,
      interfaceFont: 'arial'
    })
  })

  it('reads a hand-edited Tiny5 messaging face as the default, keeping the interface choice', async () => {
    // The exclusion is a rule about the document, not about the Settings UI:
    // this file is one a person can open, and Tiny5 has one display weight.
    const store = createTypographyPreferenceStore({
      filePath: '/typography.json',
      fs: fakeFs('{"interfaceFont":"roboto","messagingFont":"tiny5"}')
    })
    expect(await store.load()).toEqual({
      interfaceFont: 'roboto',
      messagingFont: DEFAULT_TYPOGRAPHY_PREFERENCES.messagingFont
    })
  })

  it('treats any other read failure the same way, because a preference is not worth failing over', async () => {
    const store = createTypographyPreferenceStore({
      filePath: '/typography.json',
      fs: {
        readFile: () => Promise.reject(new Error('EACCES')),
        writeFile: () => Promise.resolve(),
        rename: () => Promise.resolve()
      }
    })
    expect(await store.load()).toEqual(DEFAULT_TYPOGRAPHY_PREFERENCES)
  })

  it('writes to a sibling temp file and renames it on, so a crash cannot tear the document', async () => {
    const fs = fakeFs()
    const store = createTypographyPreferenceStore({ filePath: '/typography.json', fs })
    await store.save(DEFAULT_TYPOGRAPHY_PREFERENCES)
    // The temp file is gone and only the final path is left: the rename moved it.
    expect([...fs.files.keys()]).toEqual(['/typography.json'])
  })

  it('refuses to persist a face the next startup would have to correct', async () => {
    // The one writer under our control cannot produce a file that reads back
    // as something else — the same discipline the audio store holds.
    const fs = fakeFs()
    const store = createTypographyPreferenceStore({ filePath: '/typography.json', fs })
    await store.save({
      interfaceFont: 'arial',
      messagingFont: 'tiny5'
    } as unknown as Parameters<typeof store.save>[0])
    expect(fs.files.get('/typography.json')).toBe(
      '{"interfaceFont":"arial","messagingFont":"pixelify-sans"}\n'
    )
  })
})
