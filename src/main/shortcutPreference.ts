import { readFile, rename, writeFile } from 'node:fs/promises'
import { DEFAULT_TOGGLE_ACCELERATOR, validateAccelerator } from '../shared/accelerator'

/**
 * The persisted global panel-toggle shortcut, see #17.
 *
 * Storage deliberately mirrors the pin preference (src/main/pinPreference.ts):
 * one tiny JSON document under userData, rewritten atomically through a sibling
 * temp file plus a rename, with an injected fs so the tests need no real disk
 * and Electron never imported here — the wiring in src/main/index.ts owns the
 * userData path, keeping this module unit-testable without an app instance.
 *
 * The one rule this store adds on top of that pattern: a stored string is only
 * honored if it is still an accelerator we would be willing to claim globally.
 * The file is plain JSON in a directory the user can open, so it WILL be
 * hand-edited eventually; a bare "P" in there must not turn into a machine-wide
 * claim on the P key, and a malformed string must not reach
 * `globalShortcut.register`, which throws on one.
 */

/** Sibling suffix for the atomic write; same directory keeps rename on one volume. */
const TEMP_SUFFIX = '.tmp'

export interface ShortcutPreferenceFsLike {
  readFile: (path: string, encoding: 'utf8') => Promise<string>
  writeFile: (path: string, data: string, encoding: 'utf8') => Promise<void>
  rename: (from: string, to: string) => Promise<void>
}

const realFs: ShortcutPreferenceFsLike = { readFile, writeFile, rename }

/**
 * Pure: stored bytes -> accelerator. Anything that is not exactly
 * `{ "accelerator": "<a shortcut we would register>" }` falls back to the
 * documented default, because a broken preference must behave like a missing
 * one and never block startup. A valid-but-differently-spelled value is
 * canonicalized rather than rejected, so hand-editing the file still works.
 */
export function parseStoredAccelerator(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return DEFAULT_TOGGLE_ACCELERATOR
    }
    const accelerator = (parsed as Record<string, unknown>).accelerator
    if (typeof accelerator !== 'string') return DEFAULT_TOGGLE_ACCELERATOR
    const validated = validateAccelerator(accelerator)
    return validated.ok ? validated.accelerator : DEFAULT_TOGGLE_ACCELERATOR
  } catch {
    return DEFAULT_TOGGLE_ACCELERATOR
  }
}

/** Pure inverse of parseStoredAccelerator; newline-terminated like the other markers. */
export function serializeStoredAccelerator(accelerator: string): string {
  return `${JSON.stringify({ accelerator })}\n`
}

export interface ShortcutPreferenceStore {
  /** The stored accelerator, or the documented default when there is none (or it is unusable). */
  load: () => Promise<string>
  /**
   * Persist atomically, in canonical spelling. Rejects rather than writing a
   * value load() would silently discard; callers log the rejection, since the
   * live re-registration it accompanies has already happened either way.
   */
  save: (accelerator: string) => Promise<void>
}

export interface ShortcutPreferenceStoreOptions {
  /** Full path of the preference file (under userData in production). */
  filePath: string
  /** Injected for tests; defaults to the real filesystem. */
  fs?: ShortcutPreferenceFsLike
}

export function createShortcutPreferenceStore(
  options: ShortcutPreferenceStoreOptions
): ShortcutPreferenceStore {
  const fs = options.fs ?? realFs

  async function load(): Promise<string> {
    try {
      return parseStoredAccelerator(await fs.readFile(options.filePath, 'utf8'))
    } catch {
      // Missing file is the common first-run case; any other read failure
      // (permissions, transient IO) is treated the same way because a
      // preference is never worth failing startup over.
      return DEFAULT_TOGGLE_ACCELERATOR
    }
  }

  async function save(accelerator: string): Promise<void> {
    const validated = validateAccelerator(accelerator)
    if (!validated.ok) {
      // Refusing loudly beats writing a file that load() would quietly replace
      // with the default on the next launch — that would look like the user's
      // choice evaporating for no reason.
      throw new Error(`Refusing to persist an unusable shortcut: ${validated.reason}`)
    }
    const tempPath = `${options.filePath}${TEMP_SUFFIX}`
    await fs.writeFile(tempPath, serializeStoredAccelerator(validated.accelerator), 'utf8')
    await fs.rename(tempPath, options.filePath)
  }

  return { load, save }
}
