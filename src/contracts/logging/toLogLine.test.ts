import { describe, expect, it } from 'vitest'
import type { LogRecord } from './logRecord'
import { redactStack } from './redact'
import { REDACTED } from './redactSecrets'
import { toLogLine } from './toLogLine'

// Fixture-shaped fakes only: placeholder homes, fake ids, a fake key.
const FAKE_SK_KEY = 'sk-proj-FAKE1234FAKE1234FAKE1234FAKE1234FAKE1234'
const DWARF_ID = '0192f0c1-7a2e-7c3d-9f00-5b1a2c3d4e5f'

const base: LogRecord = {
  ts: '2026-10-02T09:14:03.120Z',
  level: 'warn',
  proc: 'host',
  pid: 18344,
  appVersion: '0.20.0',
  event: 'launch.failed',
  subsystem: 'launching'
}

function line(r: LogRecord): string {
  const out = toLogLine(r)
  if (typeof out !== 'string') throw new Error(`expected a line, got ${JSON.stringify(out)}`)
  return out
}

function parsed(r: LogRecord): Record<string, unknown> {
  return JSON.parse(line(r)) as Record<string, unknown>
}

/** Builds a record that the type system would refuse, as a caller bypassing it at runtime could. */
function untyped(extra: Record<string, unknown>): LogRecord {
  return { ...base, ...extra } as unknown as LogRecord
}

describe('toLogLine (ADR-026 items 3–5)', () => {
  it('[ADR-026, NFR-SEC-12] a record with a field outside LogRecord is refused as field-not-allowed', () => {
    for (const key of ['prompt', 'customName', 'token', 'params', '__proto__']) {
      // Through JSON, as a record decoded from outside would arrive: `__proto__` stays an own key.
      const record = JSON.parse(JSON.stringify({ ...base, [key]: 'x' })) as LogRecord
      expect(Object.keys(record), key).toContain(key)
      expect(toLogLine(record), key).toEqual({ refused: 'field-not-allowed' })
    }
  })

  it('[ADR-026, NFR-SEC-12] a record carrying a sensitive payload is refused as sensitive', () => {
    const payloads: Record<string, Record<string, unknown>> = {
      'an object in msg': { msg: { text: 'a secret message' } },
      'an array in errCode': { errCode: ['a', 'b'] },
      'a free-text value in an id field': { dwarfId: 'Thorin Oakenshield' },
      'a string in a number field': { bytes: 'forty' },
      'a value outside a declared union': { role: 'admin' }
    }
    for (const [what, extra] of Object.entries(payloads)) {
      expect(toLogLine(untyped(extra)), what).toEqual({ refused: 'sensitive' })
    }
  })

  it('[ADR-026] msg and errCode are home-replaced, secret-redacted and truncated to 300 characters', () => {
    const cases: [string, string][] = [
      ['open C:\\Users\\alice\\AppData\\x.json failed', 'open ~\\AppData\\x.json failed'],
      ['open c:/users/Alice Smith/x.json failed', 'open ~/x.json failed'],
      ['read /home/bob/.config/app failed', 'read ~/.config/app failed'],
      ['read /Users/carol/Library/app failed', 'read ~/Library/app failed'],
      [`auth ${FAKE_SK_KEY} refused`, `auth ${REDACTED} refused`]
    ]
    for (const [input, expected] of cases) {
      expect(parsed({ ...base, msg: input, errCode: input }), input).toMatchObject({
        msg: expected,
        errCode: expected
      })
    }

    const long = parsed({ ...base, msg: 'm'.repeat(500), errCode: 'z'.repeat(301) })
    expect(long.msg).toBe('m'.repeat(300))
    expect(long.errCode).toBe('z'.repeat(300))

    // Redaction runs before truncation: a key straddling character 300 must not leave its prefix.
    const straddling = parsed({ ...base, msg: `${'x'.repeat(285)} ${FAKE_SK_KEY}` })
    expect(straddling.msg).toBe(`${'x'.repeat(285)} ${REDACTED}`)
    expect(String(straddling.msg)).not.toContain('sk-')
  })

  it('[ADR-026] stack keeps at most 10 DwarfAI frames, relative paths and 2 000 characters; node_modules frames become <dependency>', () => {
    const appRoot = 'C:\\Users\\alice\\AppData\\Local\\Programs\\dwarfai\\resources\\app.asar'
    const raw = [
      'Error: launch failed for Thorin Canarybeard at C:\\Users\\alice\\work',
      '    at spawnDriver (C:\\Users\\alice\\AppData\\Local\\Programs\\dwarfai\\resources\\app.asar\\out\\main\\index.js:10:5)',
      '    at Object.<anonymous> (C:\\Users\\alice\\AppData\\Local\\Programs\\dwarfai\\resources\\app.asar\\node_modules\\zod\\lib\\index.js:1:1)',
      '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
      '    at userScript (D:\\work\\secret-mine\\index.js:3:9)',
      ...Array.from(
        { length: 12 },
        (_, i) =>
          `    at async step${i} (C:\\Users\\alice\\AppData\\Local\\Programs\\dwarfai\\resources\\app.asar\\out\\main\\index.js:${i + 20}:1)`
      )
    ].join('\n')

    const relative = redactStack(raw, appRoot)
    const stack = String(parsed({ ...base, level: 'error', stack: relative }).stack)
    const frames = stack.split('\n')

    expect(frames).toHaveLength(10)
    expect(frames[0]).toBe('    at spawnDriver (out/main/index.js:10:5)')
    expect(frames[1]).toBe('    at <dependency>')
    expect(frames[2]).toBe('    at async step0 (out/main/index.js:20:1)')
    expect(stack).not.toMatch(/node:internal|secret-mine|alice|Canarybeard|Error:/)

    // A stack that still carries absolute paths (no app root applied) keeps no absolute frame.
    expect(String(parsed({ ...base, stack: raw }).stack)).not.toMatch(/alice|secret-mine|[A-Z]:\\/)

    const wide = Array.from(
      { length: 10 },
      (_, i) => `    at ${'g'.repeat(190)}${i} (out/main/index.js:${i}:1)`
    ).join('\n')
    expect(wide.length).toBeGreaterThan(2000)
    const bounded = String(parsed({ ...base, stack: wide }).stack)
    expect(bounded.length).toBeLessThanOrEqual(2000)
    expect(bounded.split('\n').length).toBeGreaterThan(0)
    expect(bounded.split('\n').length).toBeLessThan(10)
    expect(wide.startsWith(bounded)).toBe(true)
  })

  it('[ADR-026] the output is exactly one JSON object and one \\n line end on every OS', () => {
    const out = line({ ...base, dwarfId: DWARF_ID, msg: 'first\r\nsecond\nthird\rfourth' })
    expect(out.endsWith('\n')).toBe(true)
    expect(out.split('\n')).toHaveLength(2)
    expect(out).not.toContain('\r')
    const value: unknown = JSON.parse(out)
    expect(value).toEqual({
      ...base,
      dwarfId: DWARF_ID,
      msg: 'first\r\nsecond\nthird\rfourth'
    })
    expect(Object.keys(value as object)).toEqual([
      'ts',
      'level',
      'proc',
      'pid',
      'appVersion',
      'event',
      'subsystem',
      'dwarfId',
      'msg'
    ])
  })
})
