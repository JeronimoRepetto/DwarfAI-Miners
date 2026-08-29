import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  extractCodexFeed,
  parseCodexRolloutContext,
  parseCodexRolloutHead,
  parseCodexRolloutTail
} from './parse'

const FIXTURES = join(import.meta.dirname, '..', '__fixtures__', 'codex')
const rollout = readFileSync(join(FIXTURES, 'rollout.jsonl'), 'utf8')
const rolloutLines = rollout.split('\n').filter(Boolean)

/** The same rollout cut right after task_started: a turn is still open. */
const busyRollout = rolloutLines.slice(0, rolloutLines.length - 1).join('\n') + '\n'

describe('parseCodexRolloutHead', () => {
  it('reads session id and cwd from the session_meta first line', () => {
    expect(parseCodexRolloutHead(rollout)).toEqual({
      sessionId: '01a048b5-5f35-7312-ab78-38db464920de',
      cwd: 'C:\\Users\\jeron\\Desktop\\Sample-Project'
    })
  })

  it('reads a spawned worker parent and nickname only from the documented thread_spawn shape', () => {
    const spawned = JSON.stringify({
      type: 'session_meta',
      payload: {
        id: 'child',
        cwd: 'C:\\work',
        source: {
          subagent: {
            thread_spawn: { parent_thread_id: 'parent', agent_nickname: 'Parser worker' }
          }
        }
      }
    })

    expect(parseCodexRolloutHead(spawned)).toEqual({
      sessionId: 'child',
      cwd: 'C:\\work',
      parentSessionId: 'parent',
      agentName: 'Parser worker'
    })
  })

  it('returns null when no session_meta is present', () => {
    expect(parseCodexRolloutHead('')).toBeNull()
    expect(parseCodexRolloutHead('{"type":"event_msg","payload":{}}\n')).toBeNull()
  })
})

describe('parseCodexRolloutTail', () => {
  it('reads model and effort from the latest turn_context', () => {
    const info = parseCodexRolloutTail(rollout)
    expect(info.model).toBe('gpt-5.6-sol')
    expect(info.effort).toBe('high')
  })

  it('reports idle when the last turn completed', () => {
    expect(parseCodexRolloutTail(rollout).busy).toBe(false)
  })

  it('reports busy when a task_started has no matching task_complete', () => {
    expect(parseCodexRolloutTail(busyRollout).busy).toBe(true)
  })

  it('matches completion by turn id, not by mere presence', () => {
    const started = JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-2' }
    })
    const completedOther = JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn-1' }
    })
    expect(parseCodexRolloutTail(started + '\n' + completedOther + '\n').busy).toBe(true)
  })

  it('reads the latest assistant message text', () => {
    expect(parseCodexRolloutTail(rollout).lastMessage).toBe('Latest codex reply placeholder.')
  })

  it('falls back to response_item output_text when no agent_message event exists', () => {
    const withoutAgentMsg = rolloutLines
      .filter((line) => !line.includes('"agent_message"') && !line.includes('"task_complete"'))
      .join('\n')
    expect(parseCodexRolloutTail(withoutAgentMsg).lastMessage).toBe('Placeholder text block.')
  })

  it('survives a partial first line from the tail read', () => {
    const partial = '"payload":{"type":"task_started","turn' + '\n' + rollout
    expect(parseCodexRolloutTail(partial)).toEqual(parseCodexRolloutTail(rollout))
  })
})

describe('parseCodexRolloutContext', () => {
  it('keeps the latest model and effort from a rollout fragment', () => {
    const first = JSON.stringify({
      type: 'turn_context',
      payload: { model: 'gpt-5.6-luna', effort: 'medium' }
    })
    const latest = JSON.stringify({
      type: 'turn_context',
      payload: { model: 'gpt-5.6-terra', effort: 'high' }
    })

    expect(parseCodexRolloutContext(first + '\n' + latest + '\n')).toEqual({
      model: 'gpt-5.6-terra',
      effort: 'high'
    })
  })
})

describe('extractCodexFeed', () => {
  // agent_message events duplicate the response_item text of the same reply,
  // so the feed uses user_message events + assistant response_items only.
  it('returns user and assistant messages in order without duplicates', () => {
    expect(extractCodexFeed(rollout, 20).map((m) => [m.role, m.text])).toEqual([
      ['user', 'Placeholder plain message.'],
      ['assistant', 'Placeholder text block.']
    ])
  })

  it('keeps only the last N messages', () => {
    expect(extractCodexFeed(rollout, 1).map((m) => m.text)).toEqual(['Placeholder text block.'])
  })
})
