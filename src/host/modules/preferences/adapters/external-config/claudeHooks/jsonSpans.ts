// A JSON document read as spans of its own text (ADR-016 item 6.1: parse preserving unknown
// content). `JSON.parse` decides whether the text is JSON at all; this reader then walks the same
// text and records where each value, member and element starts and ends, so an edit splices only
// the bytes DwarfAI owns and every other byte stays exactly as it was: its spacing, key order,
// number spelling, escapes and line endings included.

export type JsonNode = JsonObject | JsonArray | JsonString | JsonScalar

interface Span {
  /** Offset of the first character. */
  start: number
  /** Offset just past the last character. */
  end: number
}

export interface JsonObject extends Span {
  kind: 'object'
  members: JsonMember[]
}

export interface JsonArray extends Span {
  kind: 'array'
  elements: JsonNode[]
}

export interface JsonString extends Span {
  kind: 'string'
  value: string
}

export interface JsonScalar extends Span {
  kind: 'scalar'
}

/** One `"key": value` member; its span runs from the key's opening quote to the value's end. */
export interface JsonMember extends Span {
  key: string
  /** Offset just past the key's closing quote: `keyEnd..value.start` is the member's colon. */
  keyEnd: number
  value: JsonNode
}

const WHITESPACE = new Set([' ', '\t', '\n', '\r'])

/**
 * The spans of `text`, or `null` when it is not one JSON value. A leading byte order mark is
 * skipped (a Windows editor may save one; `JSON.parse` refuses it).
 */
export function readJson(text: string): JsonNode | null {
  const from = text.startsWith('﻿') ? 1 : 0
  try {
    JSON.parse(text.slice(from))
  } catch {
    return null
  }
  let at = from

  const skip = (): void => {
    while (at < text.length && WHITESPACE.has(text.charAt(at))) at += 1
  }

  const string = (): JsonString => {
    const start = at
    at += 1
    while (text.charAt(at) !== '"') at += text.charAt(at) === '\\' ? 2 : 1
    at += 1
    return { kind: 'string', start, end: at, value: JSON.parse(text.slice(start, at)) as string }
  }

  const value = (): JsonNode => {
    skip()
    const start = at
    const head = text.charAt(at)
    if (head === '"') return string()
    if (head === '{') {
      at += 1
      const members: JsonMember[] = []
      skip()
      while (text.charAt(at) !== '}') {
        const key = string()
        skip()
        at += 1 // ':'
        const member = value()
        members.push({
          key: key.value,
          start: key.start,
          keyEnd: key.end,
          end: member.end,
          value: member
        })
        skip()
        if (text.charAt(at) === ',') at += 1
        skip()
      }
      at += 1
      return { kind: 'object', start, end: at, members }
    }
    if (head === '[') {
      at += 1
      const elements: JsonNode[] = []
      skip()
      while (text.charAt(at) !== ']') {
        elements.push(value())
        skip()
        if (text.charAt(at) === ',') at += 1
        skip()
      }
      at += 1
      return { kind: 'array', start, end: at, elements }
    }
    // A number, true, false or null: it runs to the next delimiter.
    while (at < text.length && !/[\s,\]}]/.test(text.charAt(at))) at += 1
    return { kind: 'scalar', start, end: at }
  }

  return value()
}

/** The member `key` of `node`, when `node` is an object holding it. */
export function memberOf(node: JsonNode | undefined, key: string): JsonMember | undefined {
  return node?.kind === 'object' ? node.members.find((member) => member.key === key) : undefined
}

/** Whether some key appears twice in `node`'s own members. */
export function hasDuplicateKeys(node: JsonObject): boolean {
  return new Set(node.members.map((member) => member.key)).size !== node.members.length
}
