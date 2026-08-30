import { readFile, rename, writeFile } from 'node:fs/promises'

/**
 * The persisted always-on-top ("pin") preference, see #35.
 *
 * Storage mirrors the autostart marker pattern (src/main/autostart.ts): one
 * tiny file under userData, injected fs for tests, and Electron deliberately
 * never imported here — the wiring in src/main/index.ts owns the userData
 * path, so this module stays unit-testable without an app instance.
 *
 * Unlike the autostart marker (whose mere existence is the signal), the pin
 * preference is a VALUE that changes over time, so it is a JSON document
 * rewritten atomically: the new content lands in a sibling temp file first and
 * is renamed onto the final path, so a crash mid-write can only ever leave the
 * previous intact file (or a stray temp file) behind, never a torn one.
 */

/** The panel has always floated above other windows; that stays the default. */
export const DEFAULT_PINNED = true

/** Sibling suffix for the atomic write; same directory keeps rename on one volume. */
const TEMP_SUFFIX = '.tmp'

export interface PinPreferenceFsLike {
  readFile: (path: string, encoding: 'utf8') => Promise<string>
  writeFile: (path: string, data: string, encoding: 'utf8') => Promise<void>
  rename: (from: string, to: string) => Promise<void>
}

const realFs: PinPreferenceFsLike = { readFile, writeFile, rename }

/**
 * Pure: stored bytes -> preference. Anything that is not exactly
 * `{ "pinned": <boolean> }` (corrupt JSON, wrong shape, a truthy non-boolean)
 * falls back to the default — a broken file must behave like a missing one,
 * never block startup, and never let a stray truthy value read as a choice.
 */
export function parsePinnedPreference(raw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return DEFAULT_PINNED
    }
    const pinned = (parsed as Record<string, unknown>).pinned
    return typeof pinned === 'boolean' ? pinned : DEFAULT_PINNED
  } catch {
    return DEFAULT_PINNED
  }
}

/** Pure inverse of parsePinnedPreference; newline-terminated like the other markers. */
export function serializePinnedPreference(pinned: boolean): string {
  return `${JSON.stringify({ pinned })}\n`
}

export interface PinPreferenceStore {
  /** The stored preference, or the pinned default when there is none (or it is unreadable). */
  load: () => Promise<boolean>
  /** Persist atomically. Rejections are the caller's to log — the toggle itself already happened. */
  save: (pinned: boolean) => Promise<void>
}

export interface PinPreferenceStoreOptions {
  /** Full path of the preference file (under userData in production). */
  filePath: string
  /** Injected for tests; defaults to the real filesystem. */
  fs?: PinPreferenceFsLike
}

export function createPinPreferenceStore(options: PinPreferenceStoreOptions): PinPreferenceStore {
  const fs = options.fs ?? realFs

  async function load(): Promise<boolean> {
    try {
      return parsePinnedPreference(await fs.readFile(options.filePath, 'utf8'))
    } catch {
      // Missing file is the common first-run case; any other read failure
      // (permissions, transient IO) is treated the same way because a
      // preference is never worth failing startup over.
      return DEFAULT_PINNED
    }
  }

  async function save(pinned: boolean): Promise<void> {
    const tempPath = `${options.filePath}${TEMP_SUFFIX}`
    await fs.writeFile(tempPath, serializePinnedPreference(pinned), 'utf8')
    await fs.rename(tempPath, options.filePath)
  }

  return { load, save }
}
