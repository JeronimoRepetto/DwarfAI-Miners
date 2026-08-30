import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  claudeSessionDeliveryTarget,
  encodeClaudeProjectDir,
  extractClaudeFeed,
  parseClaudeSessionEntry,
  parseClaudeTranscriptTail
} from './parse'

const FIXTURES = join(import.meta.dirname, '..', '__fixtures__', 'claude')
const parentTranscript = readFileSync(join(FIXTURES, 'parent-transcript.jsonl'), 'utf8')
const subagentTranscript = readFileSync(join(FIXTURES, 'subagent-transcript.jsonl'), 'utf8')
const sessionEntryJson: unknown = JSON.parse(
  readFileSync(join(FIXTURES, 'session-entry.json'), 'utf8')
)

describe('encodeClaudeProjectDir', () => {
  it('replaces every non-alphanumeric character with a dash', () => {
    expect(encodeClaudeProjectDir('C:\\Users\\jeron\\Desktop\\AI-Tools')).toBe(
      'C--Users-jeron-Desktop-AI-Tools'
    )
  })

  it('encodes dots as dashes too (worktree paths)', () => {
    expect(
      encodeClaudeProjectDir('C:\\Users\\jeron\\Desktop\\Pokedex-RAG\\.claude-worktrees\\x-fce647')
    ).toBe('C--Users-jeron-Desktop-Pokedex-RAG--claude-worktrees-x-fce647')
  })
})

describe('parseClaudeSessionEntry', () => {
  it('parses a real sessions/<pid>.json registry entry', () => {
    expect(parseClaudeSessionEntry(sessionEntryJson)).toEqual({
      pid: 32896,
      sessionId: '5efdffdd-53df-4509-b30d-c9e56552a22e',
      cwd: 'C:\\Users\\jeron\\Desktop\\AI-Tools',
      status: 'busy',
      procStart: '134324755721362761',
      kind: 'interactive',
      name: 'ai-tools-70',
      startedAt: 1788001972417,
      updatedAt: 1788003794280
    })
  })

  it('keeps the session kind, which is what separates a TUI from a headless job', () => {
    expect(parseClaudeSessionEntry({ pid: 1, sessionId: 's', cwd: 'c', kind: 'bg' })?.kind).toBe(
      'bg'
    )
    expect(
      parseClaudeSessionEntry({ pid: 1, sessionId: 's', cwd: 'c', kind: 7 })?.kind
    ).toBeUndefined()
  })

  it('returns null for malformed entries', () => {
    expect(parseClaudeSessionEntry(null)).toBeNull()
    expect(parseClaudeSessionEntry('nope')).toBeNull()
    expect(parseClaudeSessionEntry({})).toBeNull()
    expect(parseClaudeSessionEntry({ pid: 'x', sessionId: 's', cwd: 'c' })).toBeNull()
    expect(parseClaudeSessionEntry({ pid: 1, sessionId: 's' })).toBeNull()
  })

  it('defaults an unknown status to idle', () => {
    const entry = parseClaudeSessionEntry({ pid: 1, sessionId: 's', cwd: 'c', status: 'weird' })
    expect(entry?.status).toBe('idle')
  })

  it('preserves waiting — the structured blocked-session signal (issue #34)', () => {
    // Real observed registry shape: {"status":"waiting","waitingFor":"dialog open"}.
    expect(
      parseClaudeSessionEntry({
        pid: 1,
        sessionId: 's',
        cwd: 'c',
        status: 'waiting',
        waitingFor: 'dialog open',
        procStart: '134324755721362761'
      })
    ).toMatchObject({
      status: 'waiting',
      waitingFor: 'dialog open',
      procStart: '134324755721362761'
    })
  })

  it('keeps waiting even when the registry names no waitingFor condition', () => {
    const entry = parseClaudeSessionEntry({ pid: 1, sessionId: 's', cwd: 'c', status: 'waiting' })
    expect(entry?.status).toBe('waiting')
    expect(entry?.waitingFor).toBeUndefined()
  })

  it('ignores a non-string waitingFor value', () => {
    const entry = parseClaudeSessionEntry({
      pid: 1,
      sessionId: 's',
      cwd: 'c',
      status: 'waiting',
      waitingFor: 7
    })
    expect(entry?.status).toBe('waiting')
    expect(entry?.waitingFor).toBeUndefined()
  })
})

describe('claudeSessionDeliveryTarget', () => {
  it('types into the console of an interactive session, keeping its relay address', () => {
    // The name is the same relay address a bg session uses. It rides along on
    // the terminal target so the runtime can fall back to the relay when the
    // console cannot be focused, instead of losing the message (issue #24).
    expect(
      claudeSessionDeliveryTarget({ pid: 4242, kind: 'interactive', name: 'ai-tools-70' })
    ).toEqual({ kind: 'terminal', pid: 4242, sessionName: 'ai-tools-70' })
  })

  it('offers a console-only target for an interactive session that never got a name', () => {
    const target = claudeSessionDeliveryTarget({ pid: 4242, kind: 'interactive' })
    expect(target).toEqual({ kind: 'terminal', pid: 4242 })
    // No name means no relay address at all — the fallback must not exist.
    expect(target !== null && 'sessionName' in target).toBe(false)
  })

  it('relays to a headless background job by its registry name', () => {
    expect(claudeSessionDeliveryTarget({ pid: 4242, kind: 'bg', name: 'ai-tools-70' })).toEqual({
      kind: 'claude-relay',
      sessionName: 'ai-tools-70'
    })
  })

  it('has no channel to a headless job that never got an addressable name', () => {
    expect(claudeSessionDeliveryTarget({ pid: 4242, kind: 'bg' })).toBeNull()
  })

  it('assumes a console for an older entry that records no kind at all', () => {
    // A named legacy entry is just as relay-addressable as a named interactive
    // one, so its target carries the same fallback address.
    expect(claudeSessionDeliveryTarget({ pid: 4242, name: 'ai-tools-70' })).toEqual({
      kind: 'terminal',
      pid: 4242,
      sessionName: 'ai-tools-70'
    })
  })
})

/** The `toolUseResult` line Claude writes the moment an Agent tool call starts. */
function launchLine(agentId: string): string {
  return (
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [] },
      toolUseResult: { isAsync: true, status: 'async_launched', agentId, description: 'd' }
    }) + '\n'
  )
}

/** The `<task-notification>` blob Claude enqueues when an agent stops. */
function notificationLine(agentId: string, status: string): string {
  return (
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content:
          `<task-notification>\n<task-id>${agentId}</task-id>\n` +
          `<status>${status}</status>\n</task-notification>`
      }
    }) + '\n'
  )
}

describe('parseClaudeTranscriptTail', () => {
  const info = parseClaudeTranscriptTail(parentTranscript)

  it('reports the latest assistant model and effort', () => {
    expect(info.model).toBe('claude-fable-5')
    expect(info.effort).toBe('xhigh')
  })

  it('reports the latest assistant text block, skipping tool_use-only lines', () => {
    expect(info.lastAssistantText).toBe('Latest assistant reply placeholder.')
  })

  it('lists only agents launched without a later completion notification', () => {
    expect(info.inFlightAgents).toEqual([
      {
        agentId: 'a34eaebecc3d57381',
        description: 'Placeholder agent task',
        resolvedModel: 'claude-fable-5'
      }
    ])
  })

  it('reports pendingBackgroundAgentCount from the latest system line', () => {
    expect(info.pendingBackgroundAgentCount).toBe(2)
  })

  it('reports the latest observed usage (input+output+cache) as tokensObserved', () => {
    // The last assistant line in the fixture carries input:2, output:517,
    // cache_creation:616, cache_read:116448 -> 2+517+616+116448 = 117583.
    expect(info.tokensObserved).toBe(117_583)
  })

  it('skips a partial first line produced by the tail read', () => {
    const partial = '"cwd":"C:\\\\x","message":{"content":[{"type"' + '\n' + parentTranscript
    expect(parseClaudeTranscriptTail(partial)).toEqual(info)
  })

  it('reports the agent ids that reached a terminal status', () => {
    expect(info.terminalAgentIds).toEqual(['a5d803981d4c3340f'])
  })

  it.each(['completed', 'failed', 'killed'])('treats a %s task-notification as terminal', (s) => {
    const parsed = parseClaudeTranscriptTail(launchLine('agentx') + notificationLine('agentx', s))
    expect(parsed.inFlightAgents).toEqual([])
    expect(parsed.terminalAgentIds).toEqual(['agentx'])
  })

  it('keeps an agent in flight while no notification has arrived', () => {
    const parsed = parseClaudeTranscriptTail(launchLine('agentx'))
    expect(parsed.inFlightAgents).toEqual([
      { agentId: 'agentx', description: 'd', resolvedModel: undefined }
    ])
    expect(parsed.terminalAgentIds).toEqual([])
  })

  it('ignores a status the notification format does not use', () => {
    const parsed = parseClaudeTranscriptTail(
      launchLine('agentx') + notificationLine('agentx', 'running')
    )
    expect(parsed.inFlightAgents).toHaveLength(1)
    expect(parsed.terminalAgentIds).toEqual([])
  })

  it('reports a terminal agent whose launch record already scrolled out of the tail', () => {
    // The 256KiB tail can hold the notification long after the launch is gone,
    // and the provider needs it to keep a completed agent from coming back.
    const parsed = parseClaudeTranscriptTail(notificationLine('agentx', 'completed'))
    expect(parsed.inFlightAgents).toEqual([])
    expect(parsed.terminalAgentIds).toEqual(['agentx'])
  })

  it('returns an empty result for empty input', () => {
    expect(parseClaudeTranscriptTail('')).toEqual({
      model: undefined,
      effort: undefined,
      lastAssistantText: undefined,
      inFlightAgents: [],
      terminalAgentIds: [],
      pendingBackgroundAgentCount: undefined,
      tokensObserved: undefined
    })
  })

  it('ignores an assistant line with no usage block', () => {
    const line =
      JSON.stringify({
        type: 'assistant',
        message: { model: 'm', role: 'assistant', content: [{ type: 'text', text: 'hi' }] }
      }) + '\n'
    expect(parseClaudeTranscriptTail(line).tokensObserved).toBeUndefined()
  })

  it('keeps the previous tokensObserved reading when a later line has no usage', () => {
    const withUsage =
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'm',
          role: 'assistant',
          content: [{ type: 'text', text: 'a' }],
          usage: { input_tokens: 10, output_tokens: 20 }
        }
      }) + '\n'
    const withoutUsage =
      JSON.stringify({
        type: 'assistant',
        message: { model: 'm', role: 'assistant', content: [{ type: 'text', text: 'b' }] }
      }) + '\n'
    expect(parseClaudeTranscriptTail(withUsage + withoutUsage).tokensObserved).toBe(30)
  })
})

describe('extractClaudeFeed', () => {
  it('returns human-readable messages in order, skipping notifications and tool results', () => {
    const feed = extractClaudeFeed(parentTranscript, 20)
    expect(feed.map((m) => [m.role, m.text])).toEqual([
      ['user', 'Placeholder user prompt.'],
      ['assistant', 'Placeholder text block.'],
      ['assistant', 'Latest assistant reply placeholder.']
    ])
    expect(feed.every((m) => m.timestamp !== '')).toBe(true)
  })

  it('keeps only the last N messages', () => {
    const feed = extractClaudeFeed(parentTranscript, 2)
    expect(feed.map((m) => m.text)).toEqual([
      'Placeholder text block.',
      'Latest assistant reply placeholder.'
    ])
  })

  it('works on subagent transcripts', () => {
    const feed = extractClaudeFeed(subagentTranscript, 20)
    expect(feed.map((m) => [m.role, m.text])).toEqual([
      ['user', 'Placeholder user prompt.'],
      ['assistant', 'Subagent latest reply placeholder.']
    ])
  })
})

describe('parseClaudeTranscriptTail on subagent transcripts', () => {
  it('reads the latest assistant text for worker speech bubbles', () => {
    const info = parseClaudeTranscriptTail(subagentTranscript)
    expect(info.lastAssistantText).toBe('Subagent latest reply placeholder.')
    expect(info.model).toBe('claude-fable-5')
  })

  it('reads tokensObserved from the subagent transcript too', () => {
    // input:2, output:1152, cache_creation:7879, cache_read:117478 -> 126511.
    expect(parseClaudeTranscriptTail(subagentTranscript).tokensObserved).toBe(126_511)
  })
})
