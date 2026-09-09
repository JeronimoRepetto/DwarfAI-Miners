import { describe, expect, it } from 'vitest'
import { DEFAULT_AUDIO_PREFERENCES } from '../domain/types'
import {
  createAudioPreferenceStore,
  serializeAudioPreferences,
  type AudioPreferenceFsLike
} from './audioPreference'

/** The same in-memory shape the pin and edge preference tests use. */
function fakeFs(initial?: string): AudioPreferenceFsLike & { files: Map<string, string> } {
  const files = new Map<string, string>()
  if (initial !== undefined) files.set('/audio.json', initial)
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

describe('serializeAudioPreferences', () => {
  it('writes the four fields, newline-terminated like the other markers', () => {
    expect(
      serializeAudioPreferences({
        musicAtStartup: false,
        musicVolume: 0.5,
        ambienceVolume: 0.25,
        voiceVolume: 1
      })
    ).toBe('{"musicAtStartup":false,"musicVolume":0.5,"ambienceVolume":0.25,"voiceVolume":1}\n')
  })

  it('round-trips through the shared parser, so what is written can be read', () => {
    const store = createAudioPreferenceStore({ filePath: '/audio.json', fs: fakeFs() })
    const chosen = {
      musicAtStartup: false,
      musicVolume: 0.3,
      ambienceVolume: 0.6,
      voiceVolume: 0.9
    }
    return store
      .save(chosen)
      .then(() => store.load())
      .then((read) => expect(read).toEqual(chosen))
  })
})

describe('createAudioPreferenceStore', () => {
  it('answers with the documented defaults on a first run, with no file to read', async () => {
    const store = createAudioPreferenceStore({ filePath: '/audio.json', fs: fakeFs() })
    expect(await store.load()).toEqual(DEFAULT_AUDIO_PREFERENCES)
  })

  it('reads back what a previous run stored', async () => {
    const store = createAudioPreferenceStore({
      filePath: '/audio.json',
      fs: fakeFs(
        '{"musicAtStartup":false,"musicVolume":0.2,"ambienceVolume":0.4,"voiceVolume":0.6}'
      )
    })
    expect(await store.load()).toEqual({
      musicAtStartup: false,
      musicVolume: 0.2,
      ambienceVolume: 0.4,
      voiceVolume: 0.6
    })
  })

  it('treats a corrupt file exactly like a missing one, never blocking startup', async () => {
    const store = createAudioPreferenceStore({
      filePath: '/audio.json',
      fs: fakeFs('{ this is not json')
    })
    expect(await store.load()).toEqual(DEFAULT_AUDIO_PREFERENCES)
  })

  it('keeps the fields it can read out of a partly broken document', async () => {
    const store = createAudioPreferenceStore({
      filePath: '/audio.json',
      fs: fakeFs('{"musicAtStartup":"yes","musicVolume":0.2}')
    })
    expect(await store.load()).toEqual({ ...DEFAULT_AUDIO_PREFERENCES, musicVolume: 0.2 })
  })

  it('treats any other read failure the same way, because a preference is not worth failing over', async () => {
    const store = createAudioPreferenceStore({
      filePath: '/audio.json',
      fs: {
        readFile: () => Promise.reject(new Error('EACCES')),
        writeFile: () => Promise.resolve(),
        rename: () => Promise.resolve()
      }
    })
    expect(await store.load()).toEqual(DEFAULT_AUDIO_PREFERENCES)
  })

  it('writes to a sibling temp file and renames it on, so a crash cannot tear the document', async () => {
    const fs = fakeFs()
    const store = createAudioPreferenceStore({ filePath: '/audio.json', fs })
    await store.save(DEFAULT_AUDIO_PREFERENCES)
    // The temp file is gone and only the final path is left: the rename moved it.
    expect([...fs.files.keys()]).toEqual(['/audio.json'])
  })

  it('refuses to persist a volume the next startup would have to clamp', async () => {
    // The one writer under our control cannot produce a file that reads back
    // as something else — the same discipline the config file writer holds.
    const fs = fakeFs()
    const store = createAudioPreferenceStore({ filePath: '/audio.json', fs })
    await store.save({ ...DEFAULT_AUDIO_PREFERENCES, musicVolume: 4, ambienceVolume: -1 })
    expect(await store.load()).toEqual({
      ...DEFAULT_AUDIO_PREFERENCES,
      musicVolume: 1,
      ambienceVolume: 0
    })
  })
})
