import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  encodeClaudeProjectDir,
  extractClaudeFeed,
  parseClaudeSessionEntry,
  parseClaudeTranscriptTail
} from './parse'

const FIXTURES = join(import.meta.dirname, '..', '__fixtures__', 'claude')
const parentTranscript = readFileSync(join(FIXTURES, 'parent-transcript.jsonl'), 'utf8')
const subagentTranscript = readFileSync(join(FIXTURES, 'subagent-transcript.jsonl'), 'utf8')
const sessionEntryJson: unknown = JSON.parse(readFileSync(join(FIXTURES, 'session-entry.json'), 'utf8'))

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
      name: 'ai-tools-70',
      startedAt: 1788001972417,
      updatedAt: 1788003794280
    })
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
})

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

  it('skips a partial first line produced by the tail read', () => {
    const partial = '"cwd":"C:\\\\x","message":{"content":[{"type"' + '\n' + parentTranscript
    expect(parseClaudeTranscriptTail(partial)).toEqual(info)
  })

  it('treats a failed task-notification as completion too', () => {
    const launch = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [] },
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'agentx', description: 'd' }
    })
    const failure = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: '<task-notification>\n<task-id>agentx</task-id>\n<status>failed</status>\n</task-notification>'
      }
    })
    expect(parseClaudeTranscriptTail(launch + '\n' + failure + '\n').inFlightAgents).toEqual([])
    expect(parseClaudeTranscriptTail(launch + '\n').inFlightAgents).toEqual([
      { agentId: 'agentx', description: 'd', resolvedModel: undefined }
    ])
  })

  it('returns an empty result for empty input', () => {
    expect(parseClaudeTranscriptTail('')).toEqual({
      model: undefined,
      effort: undefined,
      lastAssistantText: undefined,
      inFlightAgents: [],
      pendingBackgroundAgentCount: undefined
    })
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
})
