import { readFile, rename, writeFile } from 'node:fs/promises'
import { parseTypographyPreferences, type TypographyPreferences } from '../domain/types'

/**
 * The persisted Typography settings (#370): which face the interface is drawn
 * in, and which face carries what the crew says.
 *
 * Storage deliberately mirrors the pin, edge, shortcut and audio preferences
 * (src/main/shell/audioPreference.ts and its siblings): one tiny JSON document
 * under userData, rewritten atomically through a sibling temp file plus a
 * rename, with an injected fs so the tests need no real disk and Electron is
 * never imported here — the wiring in src/main/index.ts owns the userData path,
 * keeping this module unit-testable without an app instance.
 *
 * It is in `shell/` with those four rather than in a directory of its own
 * because it is the same subject they are: a preference somebody sets in the
 * app about how the app itself presents. Main never reads a face — it only
 * stores one and hands it back — so there is no typography subject on this
 * side for a directory to be named after.
 *
 * Why a preference store and not a key in the three-layer config: a font is
 * something a person picks in Settings, not something an operator configures,
 * so it has no business being settable from `.env` and it must be writable at
 * runtime. See the `config-layering` skill.
 *
 * The PARSER is shared with the preload and the renderer rather than written
 * here — it is `parseTypographyPreferences` in `shared/contracts.ts`, because
 * all three read the same document and a second reading of it would be a
 * second answer that could disagree. That is also why this file has no
 * defaults of its own, and why the Tiny5-for-messaging exclusion is not
 * restated here.
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
 * Pure inverse of `parseTypographyPreferences`, newline-terminated like the
 * other markers — and it PARSES what it was handed on the way out, so the one
 * writer under our control cannot produce a file the next startup would have
 * to correct. A stored `tiny5` messaging face that reads back as Pixelify Sans
 * is a document that lies about the choice it records.
 */
export function serializeTypographyPreferences(preferences: TypographyPreferences): string {
  const clean = parseTypographyPreferences(preferences)
  return `${JSON.stringify(clean)}\n`
}

export interface TypographyPreferenceStore {
  /** The stored faces, or the documented defaults when there are none. */
  load: () => Promise<TypographyPreferences>
  /** Persist atomically. Rejections are the caller's to log — the change already happened. */
  save: (preferences: TypographyPreferences) => Promise<void>
}

export interface TypographyPreferenceStoreOptions {
  /** Full path of the preference file (under userData in production). */
  filePath: string
  /** Injected for tests; defaults to the real filesystem. */
  fs?: TypographyPreferenceFsLike
}

export function createTypographyPreferenceStore(
  options: TypographyPreferenceStoreOptions
): TypographyPreferenceStore {
  const fs = options.fs ?? realFs

  async function load(): Promise<TypographyPreferences> {
    let raw: string
    try {
      raw = await fs.readFile(options.filePath, 'utf8')
    } catch {
      // Missing file is the common first-run case; any other read failure
      // (permissions, transient IO) is treated the same way because a
      // preference is never worth failing startup over.
      return parseTypographyPreferences(undefined)
    }
    try {
      return parseTypographyPreferences(JSON.parse(raw))
    } catch {
      // Unparseable bytes are corruption, indistinguishable from a file that
      // was never written — the shape half of the `config-layering` rule.
      return parseTypographyPreferences(undefined)
    }
  }

  async function save(preferences: TypographyPreferences): Promise<void> {
    const tempPath = `${options.filePath}${TEMP_SUFFIX}`
    await fs.writeFile(tempPath, serializeTypographyPreferences(preferences), 'utf8')
    await fs.rename(tempPath, options.filePath)
  }

  return { load, save }
}
