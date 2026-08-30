import { describe, expect, it } from 'vitest'
import { claudeCoalFromTail, codexCoalFromRollout } from './coalScan'

/** One assistant line as Claude writes it, trimmed to the fields we read. */
function assistantLine(
  usage: Record<string, number>,
  timestamp: string,
  cwd = 'C:\\Users\\j\\Desktop\\Proj'
): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', model: 'claude-fable-5', usage },
    timestamp,
    cwd,
    sessionId: 'sess-1'
  })
}

function userLine(timestamp: string, cwd = 'C:\\Users\\j\\Desktop\\Proj'): string {
  return JSON.stringify({ type: 'user', message: { role: 'user' }, timestamp, cwd })
}

describe('claudeCoalFromTail', () => {
  it('reads the cwd and the last usage block from a transcript tail', () => {
    const tail = [
      userLine('2026-01-01T10:00:00.000Z'),
      assistantLine(
        {
          input_tokens: 2,
          output_tokens: 100,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 68
        },
        '2026-01-01T10:00:01.000Z'
      )
    ].join('\n')

    expect(claudeCoalFromTail(tail)).toEqual({
      cwd: 'C:\\Users\\j\\Desktop\\Proj',
      tokens: 200,
      lastRecordAt: Date.parse('2026-01-01T10:00:01.000Z')
    })
  })

  it('sums exactly the four usage fields the live provider sums', () => {
    const tail = assistantLine(
      {
        input_tokens: 1,
        output_tokens: 2,
        cache_creation_input_tokens: 4,
        cache_read_input_tokens: 8,
        // Not part of the total: a detail breakdown already counted above.
        output_tokens_details: 999
      } as unknown as Record<string, number>,
      '2026-01-01T10:00:00.000Z'
    )
    expect(claudeCoalFromTail(tail)?.tokens).toBe(15)
  })

  it('takes the LAST usage block rather than summing every turn', () => {
    // Claude resends the whole conversation each turn, so its usage figures
    // overlap; summing them would multiply the same tokens by the turn count.
    const tail = [
      assistantLine({ input_tokens: 0, output_tokens: 100 }, '2026-01-01T10:00:00.000Z'),
      assistantLine({ input_tokens: 0, output_tokens: 400 }, '2026-01-01T10:00:05.000Z')
    ].join('\n')
    expect(claudeCoalFromTail(tail)?.tokens).toBe(400)
  })

  it('drops the partial first line a byte-bounded tail leaves behind', () => {
    const whole = assistantLine({ output_tokens: 500 }, '2026-01-01T10:00:00.000Z')
    const tail = `sage":{"output_tokens":99}},"type":"assistant"}\n${whole}`
    expect(claudeCoalFromTail(tail)?.tokens).toBe(500)
  })

  it('reports the newest record timestamp, even when it is not the usage line', () => {
    const tail = [
      assistantLine({ output_tokens: 500 }, '2026-01-01T10:00:00.000Z'),
      userLine('2026-01-01T11:00:00.000Z')
    ].join('\n')
    expect(claudeCoalFromTail(tail)?.lastRecordAt).toBe(Date.parse('2026-01-01T11:00:00.000Z'))
  })

  it('returns null when no usage was recorded at all', () => {
    expect(claudeCoalFromTail(userLine('2026-01-01T10:00:00.000Z'))).toBeNull()
  })

  it('returns null when the tail carries no cwd to credit a project with', () => {
    // The project directory name is a lossy encoding with no decoder, so a
    // transcript with no cwd field cannot be attributed to any mine.
    const line = JSON.stringify({
      type: 'assistant',
      message: { usage: { output_tokens: 10 } },
      timestamp: '2026-01-01T10:00:00.000Z'
    })
    expect(claudeCoalFromTail(line)).toBeNull()
  })

  it('survives junk and empty lines without throwing', () => {
    const tail = [
      '',
      'not json at all',
      '{}',
      assistantLine({ output_tokens: 7 }, '2026-01-01T10:00:00.000Z'),
      ''
    ].join('\n')
    expect(claudeCoalFromTail(tail)?.tokens).toBe(7)
  })

  it('returns null for an empty tail', () => {
    expect(claudeCoalFromTail('')).toBeNull()
  })

  it('ignores a usage block whose numbers are not numbers', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { usage: { output_tokens: 'lots' } },
      timestamp: '2026-01-01T10:00:00.000Z',
      cwd: 'C:\\P'
    })
    expect(claudeCoalFromTail(line)).toBeNull()
  })
})

/** One Codex rollout record: every line is {timestamp, type, payload}. */
function record(type: string, payload: unknown, timestamp: string): string {
  return JSON.stringify({ timestamp, type, payload })
}

function tokenCount(total: number, timestamp: string): string {
  return record(
    'event_msg',
    { type: 'token_count', info: { total_token_usage: { total_tokens: total } } },
    timestamp
  )
}

describe('codexCoalFromRollout', () => {
  it('reads the cwd from the session_meta head and the total from the tail', () => {
    const head = record(
      'session_meta',
      { id: 'thread-1', cwd: '/home/j/proj' },
      '2026-01-01T10:00:00.000Z'
    )
    const tail = tokenCount(12_345, '2026-01-01T10:05:00.000Z')

    expect(codexCoalFromRollout(head, tail)).toEqual({
      cwd: '/home/j/proj',
      tokens: 12_345,
      lastRecordAt: Date.parse('2026-01-01T10:05:00.000Z')
    })
  })

  it('takes the LAST token_count, which is the running total for the session', () => {
    const head = record('session_meta', { cwd: '/p' }, '2026-01-01T10:00:00.000Z')
    const tail = [
      tokenCount(100, '2026-01-01T10:01:00.000Z'),
      tokenCount(900, '2026-01-01T10:02:00.000Z')
    ].join('\n')
    expect(codexCoalFromRollout(head, tail)?.tokens).toBe(900)
  })

  it('ignores event_msg records that are not token counts', () => {
    const head = record('session_meta', { cwd: '/p' }, '2026-01-01T10:00:00.000Z')
    const tail = [
      tokenCount(500, '2026-01-01T10:01:00.000Z'),
      record('event_msg', { type: 'task_complete' }, '2026-01-01T10:02:00.000Z')
    ].join('\n')
    const result = codexCoalFromRollout(head, tail)
    expect(result?.tokens).toBe(500)
    expect(result?.lastRecordAt).toBe(Date.parse('2026-01-01T10:02:00.000Z'))
  })

  it('returns null when the rollout never recorded a token count', () => {
    const head = record('session_meta', { cwd: '/p' }, '2026-01-01T10:00:00.000Z')
    const tail = record('event_msg', { type: 'task_started' }, '2026-01-01T10:01:00.000Z')
    expect(codexCoalFromRollout(head, tail)).toBeNull()
  })

  it('returns null when the head carries no session_meta cwd', () => {
    const head = record('event_msg', { type: 'task_started' }, '2026-01-01T10:00:00.000Z')
    expect(codexCoalFromRollout(head, tokenCount(10, '2026-01-01T10:01:00.000Z'))).toBeNull()
  })

  it('survives a truncated head and a partial leading tail line', () => {
    const head = `${record('session_meta', { cwd: '/p' }, '2026-01-01T10:00:00.000Z')}\n{"timestamp":"2026`
    const tail = `_usage":{"total_tokens":11}}}\n${tokenCount(77, '2026-01-01T10:09:00.000Z')}`
    expect(codexCoalFromRollout(head, tail)?.tokens).toBe(77)
  })

  it('finds the token count when head and tail are the same short file', () => {
    // A small rollout is read whole twice; the same record must not be
    // mistaken for two sessions or double-counted.
    const whole = [
      record('session_meta', { cwd: '/p' }, '2026-01-01T10:00:00.000Z'),
      tokenCount(42, '2026-01-01T10:01:00.000Z')
    ].join('\n')
    expect(codexCoalFromRollout(whole, whole)?.tokens).toBe(42)
  })

  it('ignores a total that is not a number', () => {
    const head = record('session_meta', { cwd: '/p' }, '2026-01-01T10:00:00.000Z')
    const tail = record(
      'event_msg',
      { type: 'token_count', info: { total_token_usage: { total_tokens: 'many' } } },
      '2026-01-01T10:01:00.000Z'
    )
    expect(codexCoalFromRollout(head, tail)).toBeNull()
  })
})
