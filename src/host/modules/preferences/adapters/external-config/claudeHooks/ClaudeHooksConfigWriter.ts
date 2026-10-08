// The `claude-hooks` target of the one config writer (ADR-016 items 5–7; 16 §7.1, §7.5): DwarfAI's
// own hook entry in Claude Code's `~/.claude/settings.json`. The engine (`configWriterEngine.ts`)
// owns the file I/O, the backup, the atomic write, the read-back and the ledger; this adapter only
// parses and renders bytes.
//
// Evaluated candidate: the legacy `src/main/hooks/hookInstaller.ts` and `claudeSettings.ts` (found
// tree) — replaced. They parse with `JSON.parse` and write the whole document back with
// `JSON.stringify` in a detected indent, so every foreign byte whose layout differs from that
// (spacing, key order inside one line, `1.0`, `é`) is rewritten, which ADR-016 item 6.1 forbids
// ("foreign entries are kept as their exact original bytes"); they identify their entry by a loose
// substring, and keep a single `.dwarfai-backup` (ADR-016 item 6.3 wins). Kept: the documented
// shape (`hooks` → event → matcher groups → handlers), a group of DwarfAI's own per event with
// `matcher: ""`, the 5-second timeout, and the rule that a shape DwarfAI cannot merge into is never
// rewritten.
//
// How the bytes are kept: the text is read as spans (`jsonSpans.ts`) and only DwarfAI's own spans
// are spliced in or out. An insertion copies the separator and indentation of its neighbours (or,
// in an empty container, the file's own line ending and indent unit), and a removal takes out
// exactly what an insertion added, so install then revert gives the original bytes back. An entry
// is DwarfAI's only by the exact command prefix (`hookCommand.ts`); the old app's entry only by its
// exact command form, and it is never reported as DwarfAI's own (16 §7.1 "Old-app entries"): it is
// removed by `render` (replaced in the same write) and by `removeOwned`.
import type { ChannelToken } from '../../../ports/externalConfigWriter'
import type { ConfigTargetAdapter, OwnershipProbe } from '../configTargetAdapter'
import {
  buildHookCommand,
  HOOK_TIMEOUT_S,
  INSTALLED_CLAUDE_HOOK_EVENTS,
  isLegacyHookCommand,
  isOwnedHookCommand,
  ownedCommandPrefix
} from './hookCommand'
import {
  hasDuplicateKeys,
  memberOf,
  readJson,
  type JsonArray,
  type JsonNode,
  type JsonObject
} from './jsonSpans'

export interface ClaudeHooksConfigWriterOptions {
  /** `~/.claude/settings.json`, absolute (16 §7.1). */
  path: string
  /** The OS Claude Code runs the hook command on (`curl` or `curl.exe`). */
  platform: NodeJS.Platform
  /** The persisted ingress port at the moment of the write (ADR-016 item 3; S14.10 rewrites). */
  ingressPort: () => number
}

/** The file's text as read; `null` when it does not exist. */
export interface ClaudeSettingsDocument {
  readonly text: string | null
}

/** The file DwarfAI writes when there is none: an empty object, then DwarfAI's entry in it. */
const NEW_FILE = '{}\n'
/** The indent unit when the file shows none. */
const DEFAULT_UNIT = '  '

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const encoder = new TextEncoder()

/** The file's own conventions, read once per edit. */
interface Layout {
  eol: string
  unit: string
  /** A file written on one line gets compact insertions. */
  oneLine: boolean
}

function layoutOf(text: string): Layout {
  return {
    eol: text.includes('\r\n') ? '\r\n' : '\n',
    unit: /\n([ \t]+)\S/.exec(text.replace(/\r\n/g, '\n'))?.[1] ?? DEFAULT_UNIT,
    oneLine: !text.includes('\n')
  }
}

const splice = (text: string, from: number, to: number, insert: string): string =>
  text.slice(0, from) + insert + text.slice(to)

type Container = JsonObject | JsonArray

const itemsOf = (container: Container): ReadonlyArray<{ start: number; end: number }> =>
  container.kind === 'object' ? container.members : container.elements

/** `{` … `}` nesting depth of each container DwarfAI edits (the file's object is 0). */
const DEPTH = { root: 0, hooks: 1, event: 2, handlers: 4 } as const

/**
 * Removes item `index` of `container` with its separator: the inverse of `insertInto`. A container
 * left empty by it keeps the whitespace it had before, unless that is exactly what an insertion
 * into an empty container adds.
 */
function removeFrom(
  text: string,
  container: Container,
  index: number,
  depth: number,
  layout: Layout
): string {
  const items = itemsOf(container)
  const item = items[index]
  if (item === undefined) return text
  const next = items[index + 1]
  const previous = items[index - 1]
  if (next !== undefined) return splice(text, item.start, next.start, '')
  if (previous !== undefined) return splice(text, previous.end, item.end, '')
  const removed = splice(text, container.start + 1, item.end, '')
  const innerEnd = container.end - 1 - (item.end - container.start - 1)
  const rest = removed.slice(container.start + 1, innerEnd)
  return rest === closingBreak(depth, layout)
    ? splice(removed, container.start + 1, innerEnd, '')
    : removed
}

/** The line break and indent before a container's closing bracket. */
const closingBreak = (depth: number, layout: Layout): string =>
  layout.oneLine ? '' : layout.eol + layout.unit.repeat(depth)

/** Appends `value` (under `key` in an object) as the last item of `container`. */
function insertInto(
  text: string,
  container: Container,
  depth: number,
  key: string | null,
  value: unknown,
  layout: Layout
): string {
  const items = itemsOf(container)
  const last = items.at(-1)
  const lastMember = container.kind === 'object' ? container.members.at(-1) : undefined
  const colon =
    lastMember !== undefined
      ? text.slice(lastMember.keyEnd, lastMember.value.start)
      : layout.oneLine
        ? ':'
        : ': '
  const render = (lead: string): string => {
    const base = lead.slice(lead.lastIndexOf('\n') + 1)
    const json = lead.includes('\n')
      ? JSON.stringify(value, null, layout.unit).replace(/\n/g, layout.eol + base)
      : JSON.stringify(value)
    return (key === null ? '' : JSON.stringify(key) + colon) + json
  }
  if (last === undefined) {
    const inner = text.slice(container.start + 1, container.end - 1)
    const lead = layout.oneLine ? '' : layout.eol + layout.unit.repeat(depth + 1)
    const close = inner === '' ? closingBreak(depth, layout) : ''
    return splice(text, container.start + 1, container.start + 1, lead + render(lead) + close)
  }
  // The neighbours' own separator: what sits between the last item and the one before it.
  const before = items.at(-2)?.end ?? container.start
  const gap = text.slice(before, last.start)
  const lead = items.length > 1 ? gap.slice(gap.indexOf(',') + 1) : gap.slice(1)
  return splice(text, last.end, last.end, `,${lead}${render(lead)}`)
}

/** The parsed file and its `hooks` object, when the text is a JSON object. */
function rootOf(text: string): JsonObject | null {
  const root = readJson(text)
  return root?.kind === 'object' ? root : null
}

const commandOf = (handler: JsonNode): string | null => {
  const command = memberOf(handler, 'command')?.value
  return command?.kind === 'string' ? command.value : null
}

export class ClaudeHooksConfigWriter implements ConfigTargetAdapter<ClaudeSettingsDocument> {
  readonly target = 'claude-hooks' as const
  readonly path: string
  readonly ownedMarker: string

  constructor(private readonly options: ClaudeHooksConfigWriterOptions) {
    this.path = options.path
    this.ownedMarker = ownedCommandPrefix(options.platform)
  }

  read(
    bytes: Uint8Array | null
  ): { ok: true; value: ClaudeSettingsDocument } | { ok: false; error: 'malformed' } {
    if (bytes === null) return { ok: true, value: { text: null } }
    let text: string
    try {
      text = decoder.decode(bytes)
    } catch {
      return { ok: false, error: 'malformed' }
    }
    // 13 FM-127: not one JSON object (Claude Code takes no comments or trailing commas), or a key
    // DwarfAI would edit given twice (which one Claude Code reads is not DwarfAI's to guess).
    const root = rootOf(text)
    if (root === null || hasDuplicateKeys(root)) return { ok: false, error: 'malformed' }
    const hooks = memberOf(root, 'hooks')?.value
    if (hooks?.kind === 'object' && hasDuplicateKeys(hooks))
      return { ok: false, error: 'malformed' }
    return { ok: true, value: { text } }
  }

  probeOwned(doc: ClaudeSettingsDocument): OwnershipProbe {
    if (doc.text === null) return 'absent'
    const hooks = memberOf(rootOf(doc.text) ?? undefined, 'hooks')?.value
    if (hooks === undefined) return 'absent'
    // A shape DwarfAI cannot merge into holds the slot: it is never rewritten.
    if (hooks.kind !== 'object') return 'foreign'
    for (const event of INSTALLED_CLAUDE_HOOK_EVENTS) {
      const groups = memberOf(hooks, event)?.value
      if (groups !== undefined && groups.kind !== 'array') return 'foreign'
    }
    return this.someHandler(doc.text, (command) =>
      isOwnedHookCommand(command, this.options.platform)
    )
      ? 'owned'
      : 'absent'
  }

  probeLegacy(doc: ClaudeSettingsDocument): boolean {
    return doc.text !== null && this.someHandler(doc.text, isLegacyHookCommand)
  }

  render(doc: ClaudeSettingsDocument, token: ChannelToken): Uint8Array {
    // The hex check runs before anything is rendered (ADR-016 item 1).
    const command = buildHookCommand({
      port: this.options.ingressPort(),
      token,
      platform: this.options.platform
    })
    const group = { matcher: '', hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_S }] }
    let text = this.withoutEntries(doc.text ?? NEW_FILE)
    const layout = layoutOf(text)
    for (const event of INSTALLED_CLAUDE_HOOK_EVENTS) {
      const root = rootOf(text)
      if (root === null) throw new Error('claude-hooks: an edit left settings.json unreadable')
      const hooks = memberOf(root, 'hooks')?.value
      const groups = hooks === undefined ? undefined : memberOf(hooks, event)?.value
      if (hooks?.kind !== 'object') {
        text = insertInto(text, root, DEPTH.root, 'hooks', { [event]: [group] }, layout)
      } else if (groups?.kind !== 'array') {
        text = insertInto(text, hooks, DEPTH.hooks, event, [group], layout)
      } else {
        text = insertInto(text, groups, DEPTH.event, null, group, layout)
      }
    }
    return encoder.encode(text)
  }

  /**
   * DwarfAI's and the old app's entries removed, foreign bytes identical. The file is kept even when
   * DwarfAI created it: whether a `{}` was there before is not on record, and a file of the
   * person's is never deleted.
   */
  removeOwned(doc: ClaudeSettingsDocument): Uint8Array | null {
    return doc.text === null ? null : encoder.encode(this.withoutEntries(doc.text))
  }

  private isEntry(command: string): boolean {
    return isOwnedHookCommand(command, this.options.platform) || isLegacyHookCommand(command)
  }

  /** Every handler under `hooks`, whatever the event; `test` sees each one's command. */
  private someHandler(text: string, test: (command: string) => boolean): boolean {
    const hooks = memberOf(rootOf(text) ?? undefined, 'hooks')?.value
    if (hooks?.kind !== 'object') return false
    return hooks.members.some(({ value: groups }) =>
      groups.kind !== 'array'
        ? false
        : groups.elements.some((group) => {
            const handlers = memberOf(group, 'hooks')?.value
            return (
              handlers?.kind === 'array' &&
              handlers.elements.some((handler) => {
                const command = commandOf(handler)
                return command !== null && test(command)
              })
            )
          })
    )
  }

  /** Removes DwarfAI's and the old app's handlers one at a time, then what they leave empty. */
  private withoutEntries(original: string): string {
    const layout = layoutOf(original)
    let text = original
    for (;;) {
      const next = this.removeOneEntry(text, layout)
      if (next === null) return text
      text = next
    }
  }

  /**
   * The text without the first DwarfAI or old-app handler; `null` when there is none. A group made
   * only of such handlers goes with them, and so do the event array and the `hooks` object they
   * were the last item of; a group shared with a foreign handler keeps the foreign one.
   */
  private removeOneEntry(text: string, layout: Layout): string | null {
    const root = rootOf(text)
    const hooksMember = memberOf(root ?? undefined, 'hooks')
    if (root === null || hooksMember === undefined || hooksMember.value.kind !== 'object') {
      return null
    }
    const hooks = hooksMember.value
    for (const [eventIndex, { value: groups }] of hooks.members.entries()) {
      if (groups.kind !== 'array') continue
      for (const [groupIndex, group] of groups.elements.entries()) {
        const handlers = memberOf(group, 'hooks')?.value
        if (handlers?.kind !== 'array') continue
        const isEntry = (handler: JsonNode): boolean => {
          const command = commandOf(handler)
          return command !== null && this.isEntry(command)
        }
        const at = handlers.elements.findIndex(isEntry)
        if (at === -1) continue
        if (!handlers.elements.every(isEntry)) {
          return removeFrom(text, handlers, at, DEPTH.handlers, layout)
        }
        if (groups.elements.length > 1) {
          return removeFrom(text, groups, groupIndex, DEPTH.event, layout)
        }
        if (hooks.members.length > 1) {
          return removeFrom(text, hooks, eventIndex, DEPTH.hooks, layout)
        }
        return removeFrom(text, root, root.members.indexOf(hooksMember), DEPTH.root, layout)
      }
    }
    return null
  }
}
