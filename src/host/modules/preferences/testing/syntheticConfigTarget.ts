// A synthetic config target for the config writer contract (16 §7.6): a line-based `key=value`
// file standing in for a real tool's config, so the engine's rules are proven before the real
// targets exist (`claude-hooks` ISSUE-220, `opencode-plugin` ISSUE-227). Never imported by
// production code (R14).
//
// Format: each line is blank, a `#` comment or `key=value`; anything else is malformed. DwarfAI's
// slot is the key `dwarfai.hook`: its entry is `dwarfai.hook=dwarfai-managed:<token>` (the exact
// ownership probe is the `dwarfai-managed:` prefix), and the key holding any other value is a
// foreign entry DwarfAI must never touch. `dwarfai.legacy-hook=<anything>` is the old app's entry
// (the legacy probe). Every other line is foreign content, kept byte for byte, CRLF included.
import type { ConfigTargetAdapter } from '../adapters/external-config/configTargetAdapter'
import type { ChannelToken, ConfigTarget } from '../ports/externalConfigWriter'

const SLOT = 'dwarfai.hook='
const OWNED = `${SLOT}dwarfai-managed:`
const LEGACY = 'dwarfai.legacy-hook='

/** One line of the file: its text (a trailing `\r` included) and its `\n` terminator, if any. */
interface Line {
  text: string
  end: '\n' | ''
}

export interface SyntheticDocument {
  lines: Line[]
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function linesOf(text: string): Line[] {
  const lines: Line[] = []
  for (const match of text.matchAll(/([^\n]*)(\n)|([^\n]+)$/g)) {
    lines.push(
      match[2] === undefined
        ? { text: match[3] ?? '', end: '' }
        : { text: match[1] ?? '', end: '\n' }
    )
  }
  return lines
}

const body = (line: Line): string => line.text.replace(/\r$/, '')
const isOwned = (line: Line): boolean => body(line).startsWith(OWNED)
const isLegacy = (line: Line): boolean => body(line).startsWith(LEGACY)
const isWellFormed = (line: Line): boolean => {
  const text = body(line).trim()
  return text === '' || text.startsWith('#') || /^[^\s=]+=/.test(text)
}

/** The entry DwarfAI writes for `token`. */
export const syntheticEntry = (token: string): string => `${OWNED}${token}`

/** The old app's entry, as a fixture line. */
export const syntheticLegacyEntry = (value: string): string => `${LEGACY}${value}`

function joined(lines: readonly Line[]): string {
  return lines.map((line) => line.text + line.end).join('')
}

/** Removes `index`; a removed last line with no terminator takes the newline before it along. */
function without(lines: readonly Line[], index: number): Line[] {
  const next = lines.filter((_, at) => at !== index)
  const removed = lines[index]
  const previous = next[index - 1]
  if (removed !== undefined && removed.end === '' && index === next.length && previous) {
    next[index - 1] = { text: previous.text, end: '' }
  }
  return next
}

export function syntheticConfigTarget(
  target: ConfigTarget,
  path: string
): ConfigTargetAdapter<SyntheticDocument> {
  return {
    target,
    path,
    ownedMarker: OWNED,
    read(bytes) {
      const lines = bytes === null ? [] : linesOf(decoder.decode(bytes))
      return lines.every(isWellFormed)
        ? { ok: true, value: { lines } }
        : { ok: false, error: 'malformed' }
    },
    probeOwned(doc) {
      const slot = doc.lines.find((line) => body(line).startsWith(SLOT))
      if (slot === undefined) return 'absent'
      return isOwned(slot) ? 'owned' : 'foreign'
    },
    probeLegacy(doc) {
      return doc.lines.some(isLegacy)
    },
    render(doc, token: ChannelToken) {
      const lines = [...doc.lines]
      const entry = syntheticEntry(token)
      const at = lines.findIndex((line) => isOwned(line) || isLegacy(line))
      const existing = lines[at]
      if (existing !== undefined) {
        // Replaced in place, its own line ending kept.
        lines[at] = { text: entry + (existing.text.endsWith('\r') ? '\r' : ''), end: existing.end }
      } else {
        const last = lines.at(-1)
        if (last === undefined || last.end === '\n') lines.push({ text: entry, end: '\n' })
        else {
          lines[lines.length - 1] = { text: last.text, end: '\n' }
          lines.push({ text: entry, end: '' })
        }
      }
      return encoder.encode(joined(lines))
    },
    removeOwned(doc) {
      let lines = doc.lines
      for (let at = lines.length - 1; at >= 0; at -= 1) {
        const line = lines[at]
        if (line !== undefined && (isOwned(line) || isLegacy(line))) lines = without(lines, at)
      }
      const text = joined(lines)
      return text === '' ? null : encoder.encode(text)
    }
  }
}
