import { readFile, rename, writeFile } from 'node:fs/promises'
import { DEFAULT_NOTIFICATIONS_ENABLED } from '../domain/types'

/**
 * The persisted Notifications switch (#316): whether the OS notification
 * centre may be used at all.
 *
 * Storage mirrors the pin, edge, shortcut and audio preferences
 * (src/main/shell/pinPreference.ts and its siblings): one tiny JSON document
 * under userData, rewritten atomically through a sibling temp file plus a
 * rename, with an injected fs so the tests need no real disk and Electron is
 * never imported here — main/index.ts owns the userData path, which keeps this
 * module unit-testable without an app instance.
 *
 * It lives beside the notifier rather than in `shell/` with the other four
 * because a directory is a SUBJECT (see src/README.md): those four are about
 * the app as a desktop window, and this one is about notifications.
 *
 * Why a preference store and not a key in the three-layer config: this is
 * something a person switches in the app, not something an operator configures,
 * so it has no business being settable from `.env` and it must be writable at
 * runtime. See the `config-layering` skill for which of the two a new setting
 * belongs to. The half of that rule this file does implement is the asymmetry:
 * a malformed DOCUMENT degrades to the default, because corruption is
 * indistinguishable from a file that was never written, and a preference is
 * never worth failing startup over.
 */

/** Sibling suffix for the atomic write; same directory keeps rename on one volume. */
const TEMP_SUFFIX = '.tmp'

export interface NotificationPreferenceFsLike {
  readFile: (path: string, encoding: 'utf8') => Promise<string>
  writeFile: (path: string, data: string, encoding: 'utf8') => Promise<void>
  rename: (from: string, to: string) => Promise<void>
}

const realFs: NotificationPreferenceFsLike = { readFile, writeFile, rename }

/**
 * Pure: stored bytes -> the switch. Anything that is not exactly
 * `{ "enabled": <boolean> }` falls back to the default — a broken file must
 * behave like a missing one, and a truthy non-boolean must never read as a
 * choice somebody made.
 */
export function parseNotificationsEnabled(raw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return DEFAULT_NOTIFICATIONS_ENABLED
    }
    const enabled = (parsed as Record<string, unknown>).enabled
    return typeof enabled === 'boolean' ? enabled : DEFAULT_NOTIFICATIONS_ENABLED
  } catch {
    return DEFAULT_NOTIFICATIONS_ENABLED
  }
}

/** Pure inverse of parseNotificationsEnabled; newline-terminated like the other markers. */
export function serializeNotificationsEnabled(enabled: boolean): string {
  return `${JSON.stringify({ enabled })}\n`
}

export interface NotificationPreferenceStore {
  /** The stored switch, or on when there is none (or it is unreadable). */
  load: () => Promise<boolean>
  /** Persist atomically. Rejections are the caller's to log — the toggle already happened. */
  save: (enabled: boolean) => Promise<void>
}

export interface NotificationPreferenceStoreOptions {
  /** Full path of the preference file (under userData in production). */
  filePath: string
  /** Injected for tests; defaults to the real filesystem. */
  fs?: NotificationPreferenceFsLike
}

export function createNotificationPreferenceStore(
  options: NotificationPreferenceStoreOptions
): NotificationPreferenceStore {
  const fs = options.fs ?? realFs

  async function load(): Promise<boolean> {
    try {
      return parseNotificationsEnabled(await fs.readFile(options.filePath, 'utf8'))
    } catch {
      // Missing file is the common first-run case; any other read failure
      // (permissions, transient IO) is treated the same way.
      return DEFAULT_NOTIFICATIONS_ENABLED
    }
  }

  async function save(enabled: boolean): Promise<void> {
    const tempPath = `${options.filePath}${TEMP_SUFFIX}`
    await fs.writeFile(tempPath, serializeNotificationsEnabled(enabled), 'utf8')
    await fs.rename(tempPath, options.filePath)
  }

  return { load, save }
}
