import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Writes the old app's Claude hook entries into a Claude config root, byte for byte what the old app's installer
 * (`src/main/hooks/hookInstaller.ts` `installClaudeHooks` with `hookCommand.ts` `buildHookCommand`) leaves on disk for
 * a person upgrading (18 §4.5 T-46; ADR-016 items 5–7). Re-stated here rather than imported, so no e2e case reaches
 * into the legacy `src/main` tree (05 §5.1 R16) and the cut-5 deletions can remove it whole.
 *
 * The old installer's rule, for the settings files the cases seed (an LF file without a byte order mark, or none):
 * parse the file (an empty or missing one is `{}`), drop any earlier entry of its own from each of the five events and
 * append one matcher group `{ matcher: '', hooks: [{ type: 'command', command, timeout: 5 }] }`, then write it back
 * with the indent the file used (two spaces when none) and a trailing newline when the file had one (a new file does).
 * A file that existed and changed is first copied, once, to its `.dwarfai-backup` sibling (`hookInstaller.ts`
 * `backupOnce`).
 */
export interface OldAppHookOptions {
  /** The old app's loopback port (`config.hooksPort`). */
  readonly port: number
  /** The old app's per-install token (`hookToken.ts`: lowercase hex, 16 characters or more). */
  readonly token: string
  readonly platform: NodeJS.Platform
}

/** The marker that identifies an old-app entry (`hookCommand.ts` `HOOK_MARKER`). */
const OLD_APP_HOOK_MARKER = 'dwarfai-miners-hook'

/** The five events the old app installed, in its order (`hookPayload.ts` `CLAUDE_HOOK_EVENTS`). */
const OLD_APP_HOOK_EVENTS = ['SessionStart', 'Notification', 'Stop', 'SubagentStop', 'SessionEnd']

/** Seconds the old app gave one hook command (`hookInstaller.ts` `HOOK_TIMEOUT_S`). */
const OLD_APP_HOOK_TIMEOUT_S = 5

type JsonObject = Record<string, unknown>

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The old app's relay command (`hookCommand.ts` `buildHookCommand`): one curl POST to its loopback route. */
export function oldAppHookCommand({ port, token, platform }: OldAppHookOptions): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`bad port ${port}`)
  if (!/^[0-9a-f]{16,}$/.test(token)) throw new Error('the old token is lowercase hex, 16+ chars')
  return [
    platform === 'win32' ? 'curl.exe' : 'curl',
    '-s',
    '-m',
    '2',
    '-X',
    'POST',
    '-H',
    `x-dwarfai-token:${token}`,
    '-H',
    'Content-Type:application/json',
    '--noproxy',
    '127.0.0.1',
    '-d@-',
    `http://127.0.0.1:${port}/${OLD_APP_HOOK_MARKER}`
  ].join(' ')
}

function isOldAppEntry(entry: unknown): boolean {
  return (
    isJsonObject(entry) &&
    typeof entry.command === 'string' &&
    entry.command.includes(OLD_APP_HOOK_MARKER)
  )
}

/** One event's groups without old-app entries; a group left empty goes with them. */
function withoutOldAppEntries(groups: readonly unknown[]): unknown[] {
  return groups.flatMap((group) => {
    if (!isJsonObject(group) || !Array.isArray(group.hooks)) return [group]
    const kept = group.hooks.filter((entry) => !isOldAppEntry(entry))
    if (kept.length === group.hooks.length) return [group]
    return kept.length === 0 ? [] : [{ ...group, hooks: kept }]
  })
}

/**
 * Installs the old app's entries into `<claudeConfigDir>/settings.json`, as the old installer did. Answers whether the
 * file was rewritten (its `HookInstallReport.changed`); a file it cannot merge into throws.
 */
export function installOldAppClaudeHooks(
  claudeConfigDir: string,
  options: OldAppHookOptions
): boolean {
  const settingsPath = path.join(claudeConfigDir, 'settings.json')
  const existed = existsSync(settingsPath)
  const text = existed ? readFileSync(settingsPath, 'utf8') : ''
  if (text.includes('\r\n') || text.startsWith('﻿')) {
    throw new Error(
      'this helper re-states the old installer for LF files without a byte order mark only'
    )
  }
  const settings: unknown = text.trim() === '' ? {} : JSON.parse(text)
  if (!isJsonObject(settings)) throw new Error('settings.json does not hold a JSON object')
  const existingHooks = settings.hooks ?? {}
  if (!isJsonObject(existingHooks)) throw new Error('settings.json "hooks" is not an object')

  const command = oldAppHookCommand(options)
  const hooks: JsonObject = { ...existingHooks }
  for (const event of OLD_APP_HOOK_EVENTS) {
    const existing = hooks[event] ?? []
    if (!Array.isArray(existing)) throw new Error(`settings.json hooks.${event} is not an array`)
    hooks[event] = [
      ...withoutOldAppEntries(existing),
      { matcher: '', hooks: [{ type: 'command', command, timeout: OLD_APP_HOOK_TIMEOUT_S }] }
    ]
  }

  const indent = text.trim() === '' ? '  ' : (/\n([ \t]+)\S/.exec(text)?.[1] ?? '  ')
  const trailingNewline = text.trim() === '' || text.endsWith('\n')
  const body = JSON.stringify({ ...settings, hooks }, null, indent)
  const after = trailingNewline ? `${body}\n` : body
  if (after === text) return false
  const backupPath = `${settingsPath}.dwarfai-backup`
  if (existed && !existsSync(backupPath)) copyFileSync(settingsPath, backupPath)
  writeFileSync(settingsPath, after)
  return true
}
