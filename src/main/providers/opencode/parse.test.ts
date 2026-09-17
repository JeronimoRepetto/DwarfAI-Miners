import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  lastAssistantText,
  openCodeFeedRows,
  parseOpenCodeMessageData,
  parseOpenCodeModel,
  parseOpenCodePartData,
  type OpenCodeMessageRow,
  type OpenCodePartRow
} from './parse'

/*
 * Issue #444. Pure parsers over `message.data` / `part.data` JSON blobs and
 * `session.model` [V row 3, docs/opencode-format.md]. This half covers
 * message.data and session.model; part.data and the feed assembly follow in
 * the sibling describe blocks appended for the part+feed half (#444).
 */

const FIXTURES = join(import.meta.dirname, '..', '__fixtures__', 'opencode')

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))
}

describe('parseOpenCodeMessageData', () => {
  it('parses a user message', () => {
    expect(parseOpenCodeMessageData(fixture('message-user.json'))).toEqual({
      role: 'user',
      timeCreatedMs: 1757900000000,
      agent: 'gentle-orchestrator'
    })
  })

  it('parses a streaming assistant message, absent time.completed', () => {
    expect(parseOpenCodeMessageData(fixture('message-assistant-streaming.json'))).toEqual({
      role: 'assistant',
      timeCreatedMs: 1757900001000,
      agent: 'gentle-orchestrator'
    })
  })

  it('parses a completed intermediate-step assistant message (finish: tool-calls)', () => {
    expect(parseOpenCodeMessageData(fixture('message-assistant-toolcalls.json'))).toEqual({
      role: 'assistant',
      timeCreatedMs: 1757900001000,
      timeCompletedMs: 1757900030000,
      finish: 'tool-calls',
      agent: 'gentle-orchestrator'
    })
  })

  it('parses a completed final assistant message (finish: stop)', () => {
    expect(parseOpenCodeMessageData(fixture('message-assistant-stop.json'))).toEqual({
      role: 'assistant',
      timeCreatedMs: 1757900031000,
      timeCompletedMs: 1757900045000,
      finish: 'stop',
      agent: 'gentle-orchestrator'
    })
  })

  it('never surfaces message.data.parentID as a parent — it is a reply edge, not topology', () => {
    const message = parseOpenCodeMessageData(fixture('message-assistant-toolcalls.json'))
    expect(message).not.toHaveProperty('parentId')
    expect(message).not.toHaveProperty('parentID')
  })

  it('returns null for a shape this build does not recognise', () => {
    expect(parseOpenCodeMessageData({ role: 'system' })).toBeNull()
    expect(parseOpenCodeMessageData(null)).toBeNull()
    expect(parseOpenCodeMessageData('not an object')).toBeNull()
    expect(parseOpenCodeMessageData({ role: 'user' })).toBeNull()
  })

  it('accepts the raw JSON text state.ts hands over, not only a parsed object', () => {
    const raw = readFileSync(join(FIXTURES, 'message-user.json'), 'utf8')
    expect(parseOpenCodeMessageData(raw)).toEqual({
      role: 'user',
      timeCreatedMs: 1757900000000,
      agent: 'gentle-orchestrator'
    })
  })
})

describe('parseOpenCodeModel', () => {
  it('reads the {id, providerID} JSON and keeps only id', () => {
    expect(
      parseOpenCodeModel(JSON.stringify({ id: 'mimo-v2.5', providerID: 'opencode-go' }))
    ).toEqual({ id: 'mimo-v2.5' })
  })

  it('ignores the extra variant key a delegated child carries [V row 4]', () => {
    expect(
      parseOpenCodeModel(
        JSON.stringify({ id: 'qwen3.6-plus', providerID: 'opencode-go', variant: 'default' })
      )
    ).toEqual({ id: 'qwen3.6-plus' })
  })

  it('returns null for a non-JSON string', () => {
    expect(parseOpenCodeModel('not json')).toBeNull()
  })

  it('returns null when the id is missing', () => {
    expect(parseOpenCodeModel(JSON.stringify({ providerID: 'opencode-go' }))).toBeNull()
  })
})

/*
 * Part+feed half (#444). `part.data` types [V row 3], the feed ordering rule
 * (message.time_created, message.id, then part order — the measured index),
 * and lastAssistantText — the newest text part of the newest assistant
 * message.
 */

describe('parseOpenCodePartData', () => {
  it('parses a text part', () => {
    expect(parseOpenCodePartData(fixture('part-text.json'))).toEqual({
      type: 'text',
      text: 'Placeholder assistant reply text.'
    })
  })

  it('parses a reasoning part, carrying no text field the feed could show', () => {
    expect(parseOpenCodePartData(fixture('part-reasoning.json'))).toEqual({ type: 'reasoning' })
  })

  it('parses a tool part', () => {
    expect(parseOpenCodePartData(fixture('part-tool.json'))).toEqual({
      type: 'tool',
      tool: 'glob',
      callId: 'call_placeholder_glob',
      status: 'completed'
    })
  })

  it('parses a tool part carrying an input the state records', () => {
    expect(parseOpenCodePartData(fixture('part-task-tool.json'))).toEqual({
      type: 'tool',
      tool: 'task',
      callId: 'call_placeholder_task',
      status: 'completed',
      input: { description: 'Placeholder subagent task' }
    })
  })

  it('parses step-start and step-finish as markers with no displayable content', () => {
    expect(parseOpenCodePartData(fixture('part-step-start.json'))).toEqual({ type: 'step-start' })
    expect(parseOpenCodePartData(fixture('part-step-finish.json'))).toEqual({ type: 'step-finish' })
  })

  it('returns null for a part.data shape this build never wrote', () => {
    expect(parseOpenCodePartData(fixture('part-unknown.json'))).toBeNull()
  })

  it('returns null for a non-record blob', () => {
    expect(parseOpenCodePartData(null)).toBeNull()
    expect(parseOpenCodePartData('not an object')).toBeNull()
  })

  it('accepts the raw JSON text state.ts hands over, not only a parsed object', () => {
    const raw = readFileSync(join(FIXTURES, 'part-text.json'), 'utf8')
    expect(parseOpenCodePartData(raw)).toEqual({
      type: 'text',
      text: 'Placeholder assistant reply text.'
    })
  })
})

const userMessage = (id: string, timeCreatedMs: number): OpenCodeMessageRow => ({
  id,
  timeCreatedMs,
  data: { role: 'user', time: { created: timeCreatedMs }, agent: 'gentle-orchestrator' }
})

const assistantMessage = (
  id: string,
  timeCreatedMs: number,
  timeCompletedMs?: number
): OpenCodeMessageRow => ({
  id,
  timeCreatedMs,
  data: {
    role: 'assistant',
    time: {
      created: timeCreatedMs,
      ...(timeCompletedMs === undefined ? {} : { completed: timeCompletedMs })
    },
    agent: 'gentle-orchestrator',
    ...(timeCompletedMs === undefined ? {} : { finish: 'stop' })
  }
})

const textPart = (
  id: string,
  messageId: string,
  timeCreatedMs: number,
  text: string
): OpenCodePartRow => ({
  id,
  messageId,
  timeCreatedMs,
  data: { type: 'text', text, time: { start: timeCreatedMs, end: timeCreatedMs } }
})

const reasoningPart = (id: string, messageId: string, timeCreatedMs: number): OpenCodePartRow => ({
  id,
  messageId,
  timeCreatedMs,
  data: { type: 'reasoning', text: 'scratch', time: { start: timeCreatedMs, end: timeCreatedMs } }
})

const toolPart = (id: string, messageId: string, timeCreatedMs: number): OpenCodePartRow => ({
  id,
  messageId,
  timeCreatedMs,
  data: {
    type: 'tool',
    tool: 'glob',
    callID: 'call_1',
    state: { status: 'completed', input: { pattern: '*.md' } }
  }
})

const stepPart = (
  id: string,
  messageId: string,
  timeCreatedMs: number,
  kind: 'step-start' | 'step-finish'
): OpenCodePartRow => ({ id, messageId, timeCreatedMs, data: { type: kind } })

describe('openCodeFeedRows', () => {
  it('orders rows by message.time_created, message.id, then part order', () => {
    const messages = [assistantMessage('m2', 2_000, 2_500), userMessage('m1', 1_000)]
    const parts = [textPart('p2', 'm2', 2_100, 'Second.'), textPart('p1', 'm1', 1_100, 'First.')]
    expect(openCodeFeedRows(messages, parts).map((row) => row.text)).toEqual(['First.', 'Second.'])
  })

  it('never shows a reasoning part as the agent’s own words', () => {
    const messages = [assistantMessage('m1', 1_000, 1_500)]
    const parts = [
      reasoningPart('p1', 'm1', 1_100),
      textPart('p2', 'm1', 1_200, 'The visible reply.')
    ]
    const feed = openCodeFeedRows(messages, parts)
    expect(feed).toHaveLength(1)
    expect(feed[0]?.text).toBe('The visible reply.')
  })

  it('turns a tool part into an activity line, spelled as Codex’s are', () => {
    const messages = [assistantMessage('m1', 1_000, 1_500)]
    const parts = [toolPart('p1', 'm1', 1_100)]
    const feed = openCodeFeedRows(messages, parts)
    expect(feed).toEqual([
      {
        role: 'assistant',
        text: 'Searched *.md',
        timestamp: new Date(1_100).toISOString(),
        activity: { kind: 'search', target: '*.md' }
      }
    ])
  })

  it('emits nothing for step-start and step-finish parts', () => {
    const messages = [assistantMessage('m1', 1_000, 1_500)]
    const parts = [
      stepPart('p1', 'm1', 1_050, 'step-start'),
      textPart('p2', 'm1', 1_100, 'The reply.'),
      stepPart('p3', 'm1', 1_200, 'step-finish')
    ]
    expect(openCodeFeedRows(messages, parts).map((row) => row.text)).toEqual(['The reply.'])
  })
})

describe('lastAssistantText', () => {
  it('is the newest text part of the newest assistant message', () => {
    const messages = [
      assistantMessage('m1', 1_000, 1_500),
      assistantMessage('m2', 2_000, 2_500),
      userMessage('m3', 3_000)
    ]
    const parts = [
      textPart('p1', 'm1', 1_100, 'Older reply.'),
      textPart('p2a', 'm2', 2_100, 'Newest reply, first part.'),
      textPart('p2b', 'm2', 2_200, 'Newest reply, second part.')
    ]
    expect(lastAssistantText(messages, parts)).toBe('Newest reply, second part.')
  })

  it('is undefined when no assistant message has replied yet', () => {
    expect(lastAssistantText([userMessage('m1', 1_000)], [])).toBeUndefined()
  })
})
