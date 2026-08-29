import { isOurHookCommand } from './hookCommand'

/**
 * Pure read-modify-write logic for a Claude Code settings.json.
 *
 * This is the one place in the app that edits a file the user did not create
 * and cannot easily reconstruct, so every function here is total and pure: it
 * never mutates its input, it preserves every key it does not own (including
 * ones this app has never heard of), and it refuses — loudly — rather than
 * guessing whenever the existing shape is not one it can merge into safely.
 *
 * The documented settings shape is:
 *   hooks -> EventName -> [ { matcher?, hooks: [ { type, command, timeout? } ] } ]
 */

export type JsonObject = Record<string, unknown>

export interface HookEntrySpec {
  /** Events to install, in the order they should appear in a fresh file. */
  events: readonly string[]
  command: string
  /** Per-hook timeout in seconds; omitted from the entry when undefined. */
  timeoutS?: number
}

export interface JsonFormat {
  indent: string
  eol: '\n' | '\r\n'
  trailingNewline: boolean
}

const DEFAULT_FORMAT: JsonFormat = { indent: '  ', eol: '\n', trailingNewline: true }

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * One matcher group with our entries removed. `drop` is a separate flag rather
 * than a null group, because `null` is a perfectly possible foreign value in
 * that array and must survive verbatim.
 */
interface PrunedGroup {
  group: unknown
  removed: number
  drop: boolean
}

/**
 * Strip our own hook entries out of one matcher group.
 *
 * Anything that is not a well-formed group is returned verbatim: a shape this
 * app does not understand belongs to somebody else, and rewriting it would be
 * exactly the corruption this module exists to avoid.
 */
function pruneGroup(group: unknown): PrunedGroup {
  if (!isJsonObject(group) || !Array.isArray(group.hooks)) {
    return { group, removed: 0, drop: false }
  }
  const kept = group.hooks.filter(
    (entry) => !(isJsonObject(entry) && isOurHookCommand(entry.command))
  )
  const removed = group.hooks.length - kept.length
  if (removed === 0) return { group, removed: 0, drop: false }
  // A group that held nothing but our entry disappears with it, so uninstall
  // leaves no empty scaffolding behind.
  if (kept.length === 0) return { group, removed, drop: true }
  return { group: { ...group, hooks: kept }, removed, drop: false }
}

/** Every group of one event with our entries removed, plus how many were removed. */
function pruneEventGroups(groups: readonly unknown[]): { groups: unknown[]; removed: number } {
  let removed = 0
  const next: unknown[] = []
  for (const group of groups) {
    const pruned = pruneGroup(group)
    removed += pruned.removed
    if (!pruned.drop) next.push(pruned.group)
  }
  return { groups: next, removed }
}

function ourGroup(spec: HookEntrySpec): JsonObject {
  return {
    // Documented as "match everything" for the events that filter on a source
    // or reason, and accepted as a no-op by the events that take no matcher.
    matcher: '',
    hooks: [
      {
        type: 'command',
        command: spec.command,
        ...(spec.timeoutS === undefined ? {} : { timeout: spec.timeoutS })
      }
    ]
  }
}

/**
 * Add (or refresh) our hook entries, returning a new settings object.
 *
 * Re-running this is a replace, never a duplicate: our previous entry for each
 * event is pruned first, whatever port or token it was written with. Foreign
 * entries keep their position and their content. Throws when the existing
 * `hooks` value, or a targeted event's value, is not the documented shape —
 * the caller must surface that instead of overwriting a file it cannot read.
 */
export function installHookEntries(settings: JsonObject, spec: HookEntrySpec): JsonObject {
  const existingHooks = settings.hooks
  if (existingHooks !== undefined && !isJsonObject(existingHooks)) {
    throw new Error(
      '[hooks] Refusing to edit settings.json: its "hooks" value is not an object. ' +
        'Fix or remove it by hand and try again.'
    )
  }

  const hooks: JsonObject = { ...(existingHooks ?? {}) }
  for (const event of spec.events) {
    const existing = hooks[event]
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new Error(
        `[hooks] Refusing to edit settings.json: hooks."${event}" is not an array. ` +
          'Fix or remove it by hand and try again.'
      )
    }
    const pruned = pruneEventGroups(existing ?? [])
    hooks[event] = [...pruned.groups, ourGroup(spec)]
  }
  return { ...settings, hooks }
}

/**
 * Remove every entry this app installed, returning a new settings object — or
 * the original object unchanged when there was nothing of ours to remove.
 *
 * Cleanup is scoped to what we actually took out: an event whose array we
 * emptied is dropped, and `hooks` itself is dropped once every event is gone,
 * but an event array the user left empty on their own is preserved exactly as
 * found. Uninstall therefore leaves the file as if the app had never run.
 */
export function removeHookEntries(settings: JsonObject): JsonObject {
  const existingHooks = settings.hooks
  if (!isJsonObject(existingHooks)) return settings

  const hooks: JsonObject = {}
  let removed = 0
  for (const [event, value] of Object.entries(existingHooks)) {
    if (!Array.isArray(value)) {
      hooks[event] = value
      continue
    }
    const pruned = pruneEventGroups(value)
    if (pruned.removed === 0) {
      hooks[event] = value
      continue
    }
    removed += pruned.removed
    if (pruned.groups.length > 0) hooks[event] = pruned.groups
  }
  if (removed === 0) return settings

  const next: JsonObject = { ...settings }
  if (Object.keys(hooks).length === 0) {
    delete next.hooks
  } else {
    next.hooks = hooks
  }
  return next
}

/** Whether this settings object still carries any entry of ours. */
export function containsOurHooks(settings: JsonObject): boolean {
  const hooks = settings.hooks
  if (!isJsonObject(hooks)) return false
  for (const value of Object.values(hooks)) {
    if (!Array.isArray(value)) continue
    for (const group of value) {
      if (!isJsonObject(group) || !Array.isArray(group.hooks)) continue
      for (const entry of group.hooks) {
        if (isJsonObject(entry) && isOurHookCommand(entry.command)) return true
      }
    }
  }
  return false
}

/**
 * Parse a settings.json body into a plain object.
 *
 * An empty file counts as empty settings (that is what a first install writes
 * into). Everything else that is not a JSON object throws: Claude Code itself
 * rejects comments and trailing commas here, so a file this cannot read is one
 * the user must be told about, never one to silently replace.
 */
export function parseSettingsObject(text: string): JsonObject {
  if (text.trim() === '') return {}
  const parsed: unknown = JSON.parse(text)
  if (!isJsonObject(parsed)) {
    throw new Error('[hooks] settings.json does not contain a JSON object')
  }
  return parsed
}

/**
 * Read back the formatting of an existing settings.json so a rewrite changes
 * only the hooks we own. Without this, a merge would reformat the whole file
 * and bury our two-line addition in a hundred-line diff.
 */
export function detectJsonFormat(text: string): JsonFormat {
  if (text.trim() === '') return { ...DEFAULT_FORMAT }
  const eol: '\n' | '\r\n' = text.includes('\r\n') ? '\r\n' : '\n'
  const indentMatch = /\n([ \t]+)\S/.exec(text.replace(/\r\n/g, '\n'))
  return {
    indent: indentMatch?.[1] ?? DEFAULT_FORMAT.indent,
    eol,
    trailingNewline: text.endsWith('\n')
  }
}

/** Serialize settings back with the formatting detectJsonFormat found. */
export function stringifySettings(settings: JsonObject, format: JsonFormat): string {
  const body = JSON.stringify(settings, null, format.indent)
  const withEol = format.eol === '\r\n' ? body.replace(/\n/g, '\r\n') : body
  return format.trailingNewline ? `${withEol}${format.eol}` : withEol
}
