import { readFile, rename, writeFile } from 'node:fs/promises'
import { parseAudioPreferences, type AudioPreferences } from '../domain/types'

/**
 * The persisted Audio settings (#174, over #173's two channels): whether music
 * starts on launch, and the three volumes.
 *
 * Storage deliberately mirrors the pin, edge and shortcut preferences
 * (src/main/shell/pinPreference.ts and its siblings): one tiny JSON document
 * under userData, rewritten atomically through a sibling temp file plus a
 * rename, with an injected fs so the tests need no real disk and Electron is
 * never imported here — the wiring in src/main/index.ts owns the userData
 * path, keeping this module unit-testable without an app instance.
 *
 * The one thing it does NOT do, and the reason it is this store rather than a
 * key in the three-layer config: a volume is a preference somebody sets in the
 * app, not a value an operator configures, so it has no business being
 * settable from `.env` and it must be writable at runtime. See the
 * `config-layering` skill on which of the two a new setting belongs to.
 *
 * The PARSER is shared with the preload and the renderer rather than written
 * here — it is `parseAudioPreferences` in `shared/contracts.ts`, because all
 * three read the same document and a second reading of it would be a second
 * answer that could disagree. That is also why this file has no defaults of
 * its own.
 */

/** Sibling suffix for the atomic write; same directory keeps rename on one volume. */
const TEMP_SUFFIX = '.tmp'

export interface AudioPreferenceFsLike {
  readFile: (path: string, encoding: 'utf8') => Promise<string>
  writeFile: (path: string, data: string, encoding: 'utf8') => Promise<void>
  rename: (from: string, to: string) => Promise<void>
}

const realFs: AudioPreferenceFsLike = { readFile, writeFile, rename }

/**
 * Pure inverse of `parseAudioPreferences`, newline-terminated like the other
 * markers — and it PARSES what it was handed on the way out, so the one writer
 * under our control cannot produce a file the next startup would have to
 * correct. A stored 4 that reads back as 1 is a document that lies about the
 * choice it records.
 */
export function serializeAudioPreferences(preferences: AudioPreferences): string {
  const clean = parseAudioPreferences(preferences)
  return `${JSON.stringify(clean)}\n`
}

export interface AudioPreferenceStore {
  /** The stored settings, or the documented defaults when there are none. */
  load: () => Promise<AudioPreferences>
  /** Persist atomically. Rejections are the caller's to log — the change already happened. */
  save: (preferences: AudioPreferences) => Promise<void>
}

export interface AudioPreferenceStoreOptions {
  /** Full path of the preference file (under userData in production). */
  filePath: string
  /** Injected for tests; defaults to the real filesystem. */
  fs?: AudioPreferenceFsLike
}

export function createAudioPreferenceStore(
  options: AudioPreferenceStoreOptions
): AudioPreferenceStore {
  const fs = options.fs ?? realFs

  async function load(): Promise<AudioPreferences> {
    let raw: string
    try {
      raw = await fs.readFile(options.filePath, 'utf8')
    } catch {
      // Missing file is the common first-run case; any other read failure
      // (permissions, transient IO) is treated the same way because a
      // preference is never worth failing startup over.
      return parseAudioPreferences(undefined)
    }
    try {
      return parseAudioPreferences(JSON.parse(raw))
    } catch {
      // Unparseable bytes are corruption, indistinguishable from a file that
      // was never written — the shape half of the `config-layering` rule.
      return parseAudioPreferences(undefined)
    }
  }

  async function save(preferences: AudioPreferences): Promise<void> {
    const tempPath = `${options.filePath}${TEMP_SUFFIX}`
    await fs.writeFile(tempPath, serializeAudioPreferences(preferences), 'utf8')
    await fs.rename(tempPath, options.filePath)
  }

  return { load, save }
}
