import { join } from 'node:path'
import {
  containsOurHooks,
  detectJsonFormat,
  installHookEntries,
  parseSettingsObject,
  removeHookEntries,
  stringifySettings
} from './claudeSettings'
import type { HookFsLike } from './hookFs'
import { CLAUDE_HOOK_EVENTS } from './hookPayload'

/** The Claude Code settings file, relative to a Claude config root. */
export const SETTINGS_FILE = 'settings.json'

/**
 * Suffix of the pristine copy taken before this app modifies a settings.json
 * for the first time. It is never overwritten afterwards, so it always holds
 * the file as it looked before DwarfAI-Miners ever touched it.
 */
export const BACKUP_SUFFIX = '.dwarfai-backup'

/** The events installed into settings.json — see hookPayload for why these five. */
export const INSTALLED_HOOK_EVENTS = CLAUDE_HOOK_EVENTS

/** Seconds Claude Code allows one hook command; curl's own -m 2 is the real bound. */
const HOOK_TIMEOUT_S = 5

export interface HookInstallReport {
  root: string
  settingsPath: string
  /** Whether this root's settings.json was actually rewritten. */
  changed: boolean
  /** Whether this call created the one-time pristine backup. */
  backedUp: boolean
  /** Why this root was left alone, when something went wrong. */
  error?: string
}

export interface InstallOptions {
  fs: HookFsLike
  /** Absolute Claude config roots; a root that does not exist is skipped. */
  roots: readonly string[]
  command: string
  timeoutS?: number
}

export interface UninstallOptions {
  fs: HookFsLike
  roots: readonly string[]
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Copy the file to its `.dwarfai-backup` sibling, but only the first time.
 *
 * Later installs deliberately leave the original backup in place: its value is
 * being the state before this app existed, which a refreshed copy (already
 * containing our hooks) would destroy.
 */
async function backupOnce(fs: HookFsLike, settingsPath: string): Promise<boolean> {
  const backupPath = `${settingsPath}${BACKUP_SUFFIX}`
  if (await fs.exists(backupPath)) return false
  await fs.copyFile(settingsPath, backupPath)
  return true
}

/**
 * Apply one pure settings transform to one root, read-modify-write.
 *
 * Nothing is written unless the transform actually changed the serialized
 * bytes, which is what makes both install and uninstall idempotent, and what
 * keeps a no-op call from consuming the one-time backup. Any failure is
 * reported for that root alone: the other Claude root must still get its
 * hooks, and a file this cannot parse must be left exactly as found.
 */
async function applyToRoot(
  fs: HookFsLike,
  root: string,
  transform: (text: string) => string,
  options: { createMissing: boolean }
): Promise<HookInstallReport> {
  const settingsPath = join(root, SETTINGS_FILE)
  const report: HookInstallReport = { root, settingsPath, changed: false, backedUp: false }
  try {
    const original = await fs.readText(settingsPath)
    if (original === null && !options.createMissing) return report

    const before = original ?? ''
    const after = transform(before)
    if (after === before) return report

    // A file that did not exist has nothing worth preserving, so the one-time
    // backup is reserved for real user content.
    if (original !== null) report.backedUp = await backupOnce(fs, settingsPath)
    await fs.writeText(settingsPath, after)
    report.changed = true
    return report
  } catch (error) {
    return { ...report, changed: false, error: messageOf(error) }
  }
}

/** Roots that actually exist on this machine, in the configured order. */
async function presentRoots(fs: HookFsLike, roots: readonly string[]): Promise<string[]> {
  const present: string[] = []
  for (const root of roots) {
    if (await fs.exists(root)) present.push(root)
  }
  return present
}

/**
 * Install this app's hook entries into every Claude config root present.
 *
 * Re-running replaces our own entries rather than duplicating them, and never
 * touches a hook belonging to any other tool. A root whose settings.json is
 * missing gets one created; a root that does not exist at all is skipped, so
 * enabling the toggle never conjures a Claude account that is not there.
 */
export async function installClaudeHooks(options: InstallOptions): Promise<HookInstallReport[]> {
  const spec = {
    events: INSTALLED_HOOK_EVENTS,
    command: options.command,
    timeoutS: options.timeoutS ?? HOOK_TIMEOUT_S
  }
  const reports: HookInstallReport[] = []
  for (const root of await presentRoots(options.fs, options.roots)) {
    reports.push(
      await applyToRoot(
        options.fs,
        root,
        (text) =>
          stringifySettings(
            installHookEntries(parseSettingsObject(text), spec),
            detectJsonFormat(text)
          ),
        { createMissing: true }
      )
    )
  }
  return reports
}

/**
 * Remove every entry this app installed, from every Claude config root.
 *
 * A settings.json that never carried our hooks is left byte-identical, and one
 * that did is restored to what it was, minus our additions — including
 * dropping the `hooks` key entirely when it existed only for us.
 */
export async function uninstallClaudeHooks(
  options: UninstallOptions
): Promise<HookInstallReport[]> {
  const reports: HookInstallReport[] = []
  for (const root of await presentRoots(options.fs, options.roots)) {
    reports.push(
      await applyToRoot(
        options.fs,
        root,
        (text) => {
          const settings = parseSettingsObject(text)
          if (!containsOurHooks(settings)) return text
          return stringifySettings(removeHookEntries(settings), detectJsonFormat(text))
        },
        { createMissing: false }
      )
    )
  }
  return reports
}
