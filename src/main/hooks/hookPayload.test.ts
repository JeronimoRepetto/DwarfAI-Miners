import { describe, expect, it } from 'vitest'
import { CLAUDE_HOOK_EVENTS, parseClaudeHookPayload } from './hookPayload'

/**
 * Realistic Claude Code hook payloads. Field names come from the documented
 * contract (session_id / cwd / hook_event_name plus per-event extras), which
 * the installer's own hook entries are what makes arrive here.
 */
const sessionStart = JSON.stringify({
  session_id: '0198f2f0-9c1a-7b3e-8d21-6f4c2a1b9e77',
  transcript_path: 'C:\\Users\\jeron\\.claude\\projects\\C--repo\\0198f2f0.jsonl',
  cwd: 'C:\\Users\\jeron\\Desktop\\AI-Tools\\agent-name',
  permission_mode: 'default',
  hook_event_name: 'SessionStart',
  source: 'startup'
})

const stop = JSON.stringify({
  session_id: '0198f2f0-9c1a-7b3e-8d21-6f4c2a1b9e77',
  transcript_path: '/home/j/.claude/projects/-repo/0198f2f0.jsonl',
  cwd: '/home/j/repo',
  hook_event_name: 'Stop',
  stop_hook_active: false
})

describe('parseClaudeHookPayload', () => {
  it('reads a SessionStart payload', () => {
    expect(parseClaudeHookPayload(sessionStart)).toEqual({
      provider: 'claude',
      event: 'SessionStart',
      sessionId: '0198f2f0-9c1a-7b3e-8d21-6f4c2a1b9e77',
      cwd: 'C:\\Users\\jeron\\Desktop\\AI-Tools\\agent-name'
    })
  })

  it('reads a Stop payload', () => {
    expect(parseClaudeHookPayload(stop)).toEqual({
      provider: 'claude',
      event: 'Stop',
      sessionId: '0198f2f0-9c1a-7b3e-8d21-6f4c2a1b9e77',
      cwd: '/home/j/repo'
    })
  })

  it.each(CLAUDE_HOOK_EVENTS)('accepts the installed event %s', (event) => {
    const parsed = parseClaudeHookPayload(
      JSON.stringify({ session_id: 's1', cwd: '/w', hook_event_name: event })
    )
    expect(parsed?.event).toBe(event)
  })

  it('ignores an event this app never installs', () => {
    // PreToolUse fires on every tool call; accepting it would let any local
    // process drive an unbounded rescan rate through a single stale token.
    expect(
      parseClaudeHookPayload(
        JSON.stringify({ session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Bash' })
      )
    ).toBeNull()
  })

  it('keeps optional fields out of the result when they are absent or blank', () => {
    expect(parseClaudeHookPayload(JSON.stringify({ hook_event_name: 'Stop' }))).toEqual({
      provider: 'claude',
      event: 'Stop'
    })
    expect(
      parseClaudeHookPayload(
        JSON.stringify({ hook_event_name: 'Stop', session_id: '', cwd: '   ' })
      )
    ).toEqual({ provider: 'claude', event: 'Stop' })
  })

  it('ignores non-string optional fields instead of failing the whole event', () => {
    expect(
      parseClaudeHookPayload(
        JSON.stringify({ hook_event_name: 'Stop', session_id: 42, cwd: { a: 1 } })
      )
    ).toEqual({ provider: 'claude', event: 'Stop' })
  })

  it.each([
    ['malformed JSON', '{ not json'],
    ['an empty body', ''],
    ['whitespace only', '   \n '],
    ['a JSON array', '[{"hook_event_name":"Stop"}]'],
    ['a JSON string', '"Stop"'],
    ['a JSON number', '7'],
    ['null', 'null'],
    ['a missing event name', '{"session_id":"s1"}'],
    ['a non-string event name', '{"hook_event_name":5}'],
    ['an unknown event name', '{"hook_event_name":"Whatever"}']
  ])('rejects %s', (_label, body) => {
    expect(parseClaudeHookPayload(body)).toBeNull()
  })

  it('is not fooled by an event name on the prototype chain', () => {
    expect(parseClaudeHookPayload('{"__proto__":{"hook_event_name":"Stop"}}')).toBeNull()
  })
})
