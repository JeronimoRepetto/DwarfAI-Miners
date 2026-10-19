import { describe, expect, it } from 'vitest'
import { BYTE_ORDER_MARK, hasByteOrderMark, parseJsonText, stripByteOrderMark } from './jsonText'

/**
 * #555. A Windows editor writes `EF BB BF` at the head of a UTF-8 file and
 * `JSON.parse` is not allowed to skip it, so a settings file Notepad saved
 * throws on a character nobody can see. Every reader of a JSON document this
 * app takes off DISK goes through here; the parsers over stdout, HTTP bodies
 * and SQLite columns deliberately do not, because those bytes never came from
 * a text editor.
 *
 * Pure over the text, so no host needs a BOM'd file on disk to run this.
 */
describe('byte order mark', () => {
  const OBJECT = '{"model":"x"}'

  it('is the three bytes a UTF-8 editor writes, as one code point', () => {
    // U+FEFF decoded from EF BB BF. Spelled here so a reader can see what the
    // rest of the file is talking about rather than trusting an escape.
    expect(BYTE_ORDER_MARK).toBe('﻿')
    expect(Buffer.from(BYTE_ORDER_MARK, 'utf8')).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
  })

  it('recognises a mark only at the very start', () => {
    expect(hasByteOrderMark(`${BYTE_ORDER_MARK}${OBJECT}`)).toBe(true)
    expect(hasByteOrderMark(OBJECT)).toBe(false)
    // Mid-document U+FEFF is a zero-width no-break space inside real content,
    // not an encoding mark, and removing it would corrupt somebody's string.
    expect(hasByteOrderMark(`{"a":"x${BYTE_ORDER_MARK}y"}`)).toBe(false)
  })

  it('strips only the leading mark and leaves everything else alone', () => {
    expect(stripByteOrderMark(`${BYTE_ORDER_MARK}${OBJECT}`)).toBe(OBJECT)
    expect(stripByteOrderMark(OBJECT)).toBe(OBJECT)
    expect(stripByteOrderMark('')).toBe('')
    const inner = `{"a":"x${BYTE_ORDER_MARK}y"}`
    expect(stripByteOrderMark(inner)).toBe(inner)
  })

  it('strips one mark, not a run of them', () => {
    // Two marks is a corrupt file, not a doubly-marked one. Eating both would
    // turn bytes nobody can explain into a parse that silently succeeded.
    expect(stripByteOrderMark(`${BYTE_ORDER_MARK}${BYTE_ORDER_MARK}${OBJECT}`)).toBe(
      `${BYTE_ORDER_MARK}${OBJECT}`
    )
  })
})

describe('parseJsonText', () => {
  it('parses an ordinary document exactly as JSON.parse would', () => {
    expect(parseJsonText('{"model":"x"}')).toEqual({ model: 'x' })
    expect(parseJsonText('[1,2]')).toEqual([1, 2])
    expect(parseJsonText('null')).toBeNull()
  })

  it('parses a document a Windows editor marked', () => {
    expect(parseJsonText(`${BYTE_ORDER_MARK}{"model":"x"}`)).toEqual({ model: 'x' })
  })

  it('still throws for text that is genuinely not JSON, marked or not', () => {
    // Tolerating an encoding mark must not become tolerating corruption: every
    // caller's own "this file is unreadable" branch depends on this throwing.
    expect(() => parseJsonText('not json at all')).toThrow()
    expect(() => parseJsonText(`${BYTE_ORDER_MARK}not json at all`)).toThrow()
    expect(() => parseJsonText(`${BYTE_ORDER_MARK}`)).toThrow()
  })
})
