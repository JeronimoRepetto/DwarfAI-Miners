import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  type ClaudeSessionEntry,
  claudeSessionAttendance,
  claudeSessionDeliveryTarget,
  claudeWaitingReason,
  encodeClaudeProjectDir,
  extractClaudeFeed,
  parseClaudeSessionEntry,
  parseClaudeTranscriptTail
} from './parse'

const FIXTURES = join(import.meta.dirname, '..', '__fixtures__', 'claude')
const parentTranscript = readFileSync(join(FIXTURES, 'parent-transcript.jsonl'), 'utf8')
const subagentTranscript = readFileSync(join(FIXTURES, 'subagent-transcript.jsonl'), 'utf8')
const notificationEnvelopes = readFileSync(join(FIXTURES, 'notification-envelopes.jsonl'), 'utf8')
/** Three AskUserQuestion calls: one answered, one declined, one still open. */
const askUserQuestion = readFileSync(join(FIXTURES, 'ask-user-question.jsonl'), 'utf8')
const sessionEntryJson: unknown = JSON.parse(
  readFileSync(join(FIXTURES, 'session-entry.json'), 'utf8')
)
/** One registry entry per waitingFor string Claude Code can write; see the fixture. */
const waitingRegistryJson: unknown[] = JSON.parse(
  readFileSync(join(FIXTURES, 'waiting-registry.json'), 'utf8')
)

describe('encodeClaudeProjectDir', () => {
  it('replaces every non-alphanumeric character with a dash', () => {
    expect(encodeClaudeProjectDir('C:\\Users\\j\\Desktop\\Sample-Project')).toBe(
      'C--Users-j-Desktop-Sample-Project'
    )
  })

  it('encodes dots as dashes too (worktree paths)', () => {
    expect(
      encodeClaudeProjectDir('C:\\Users\\j\\Desktop\\Sample-Project\\.claude-worktrees\\x-fce647')
    ).toBe('C--Users-j-Desktop-Sample-Project--claude-worktrees-x-fce647')
  })
})

describe('parseClaudeSessionEntry', () => {
  it('parses a real sessions/<pid>.json registry entry', () => {
    // AMENDED for #255: `statusReported` joined the shape, and again for
    // #313: `statusUpdatedAt`. The assertion is whole-object on purpose — a
    // field added here has to be declared — and nothing else about the parse
    // moved either time.
    expect(parseClaudeSessionEntry(sessionEntryJson)).toEqual({
      pid: 32896,
      sessionId: '5efdffdd-53df-4509-b30d-c9e56552a22e',
      cwd: 'C:\\Users\\j\\Desktop\\Sample-Project',
      status: 'busy',
      statusReported: true,
      procStart: '134324755721362761',
      kind: 'interactive',
      name: 'sample-project-70',
      startedAt: 1788001972417,
      updatedAt: 1788003794280,
      statusUpdatedAt: 1788003794280
    })
  })

  it('keeps statusUpdatedAt, which dates the write that proves a REPL is there (#313)', () => {
    // A session with no transcript yet is judged by this stamp, so a
    // non-numeric one has to read as absent rather than as a fresh write.
    expect(
      parseClaudeSessionEntry({ pid: 1, sessionId: 's', cwd: 'c', statusUpdatedAt: 1788003794280 })
        ?.statusUpdatedAt
    ).toBe(1788003794280)
    expect(
      parseClaudeSessionEntry({ pid: 1, sessionId: 's', cwd: 'c', statusUpdatedAt: 'soon' })
        ?.statusUpdatedAt
    ).toBeUndefined()
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

  /**
   * Issue #255. An absent status and an unrecognized one both fold to 'idle',
   * and only one of them means no REPL was ever there to write it — the
   * difference between a terminal at a prompt and an SDK-hosted session that
   * has no console at all (#191).
   */
  it('records whether the registry reported a status, which the folded value cannot', () => {
    const reported = parseClaudeSessionEntry({ pid: 1, sessionId: 's', cwd: 'c', status: 'idle' })
    expect(reported).toMatchObject({ status: 'idle', statusReported: true })

    const absent = parseClaudeSessionEntry({ pid: 1, sessionId: 's', cwd: 'c' })
    expect(absent).toMatchObject({ status: 'idle', statusReported: false })
  })

  it('does not count a non-string status as reported', () => {
    // Garbage in that field is not a REPL saying anything, and the folded
    // value already reads it as idle: both halves stay conservative.
    const entry = parseClaudeSessionEntry({ pid: 1, sessionId: 's', cwd: 'c', status: 7 })
    expect(entry).toMatchObject({ status: 'idle', statusReported: false })
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
      claudeSessionDeliveryTarget({ pid: 4242, kind: 'interactive', name: 'sample-project-70' })
    ).toEqual({ kind: 'terminal', pid: 4242, sessionName: 'sample-project-70' })
  })

  it('offers a console-only target for an interactive session that never got a name', () => {
    const target = claudeSessionDeliveryTarget({ pid: 4242, kind: 'interactive' })
    expect(target).toEqual({ kind: 'terminal', pid: 4242 })
    // No name means no relay address at all — the fallback must not exist.
    expect(target !== null && 'sessionName' in target).toBe(false)
  })

  it('relays to a headless background job by its registry name', () => {
    expect(
      claudeSessionDeliveryTarget({ pid: 4242, kind: 'bg', name: 'sample-project-70' })
    ).toEqual({
      kind: 'claude-relay',
      sessionName: 'sample-project-70'
    })
  })

  it('has no channel to a headless job that never got an addressable name', () => {
    expect(claudeSessionDeliveryTarget({ pid: 4242, kind: 'bg' })).toBeNull()
  })

  it('assumes a console for an older entry that records no kind at all', () => {
    // A named legacy entry is just as relay-addressable as a named interactive
    // one, so its target carries the same fallback address.
    expect(claudeSessionDeliveryTarget({ pid: 4242, name: 'sample-project-70' })).toEqual({
      kind: 'terminal',
      pid: 4242,
      sessionName: 'sample-project-70'
    })
  })
})

/*
 * Issue #68. The same `kind` the delivery target above switches on is also the
 * only evidence Claude Code gives about whether anyone can answer the session,
 * and the silence window needs exactly that. The four values below are the
 * closed set the shipped binary validates against — `kind:E.enum(["interactive",
 * "bg","daemon","daemon-worker"])` in 2.1.251 — and three of the four were live
 * in this machine's registry while the table was written.
 */
describe('claudeSessionAttendance', () => {
  it('calls a TUI session attended, which is the one kind a human sits at', () => {
    expect(claudeSessionAttendance({ kind: 'interactive' })).toBe('attended')
  })

  it('calls every headless kind unattended, naming each rather than negating one', () => {
    // Claude Code's own rule is `kind !== 'interactive'`, but a table that
    // negates cannot tell a headless kind apart from a kind it has never seen,
    // and those two must not fall the same way — see the unknown cases below.
    expect(claudeSessionAttendance({ kind: 'bg' })).toBe('unattended')
    expect(claudeSessionAttendance({ kind: 'daemon' })).toBe('unattended')
    expect(claudeSessionAttendance({ kind: 'daemon-worker' })).toBe('unattended')
  })

  it('proves nothing about an entry that records no kind at all', () => {
    // Older entries carry no kind. The delivery target assumes a console for
    // one because guessing wrong there only costs a fallback; guessing wrong
    // here would shorten the window on a session a human is typing into.
    expect(claudeSessionAttendance({})).toBe('unknown')
  })

  it('proves nothing about a kind this table has never been taught', () => {
    // The vocabulary has grown before. A fifth kind must not be read as
    // headless just because it is not the word 'interactive'.
    expect(claudeSessionAttendance({ kind: 'interactive-remote' })).toBe('unknown')
    expect(claudeSessionAttendance({ kind: '' })).toBe('unknown')
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
      failedAgents: [],
      endedLaunches: [],
      resumedAgents: [],
      pendingBackgroundAgentCount: undefined,
      tokensObserved: undefined,
      pendingQuestion: undefined,
      unresolvedToolUses: []
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

/**
 * The envelopes Claude Code really writes a `<task-notification>` into, and the
 * places a transcript merely quotes one (issue #64). Shapes and key names come
 * from `notification-envelopes.jsonl`, which was built from records observed in
 * live transcripts rather than from what the parser expected to find.
 *
 * The agent ids are the fixture's, one per envelope, so a failure names the
 * envelope that broke.
 */
const ENVELOPE_AGENTS = {
  enqueue: 'a0000000000000001',
  remove: 'a0000000000000002',
  queuedCommand: 'a0000000000000003',
  userString: 'a0000000000000004',
  inFlight: 'a0000000000000005',
  quotedByToolResult: 'a0000000000000006',
  quotedByAssistant: 'a0000000000000007',
  quotedByHook: 'a0000000000000008',
  quotedByLaunchPrompt: 'a0000000000000009',
  launchedByThatPrompt: 'a000000000000000a'
}

describe('parseClaudeTranscriptTail notification envelopes (issue #64)', () => {
  const info = parseClaudeTranscriptTail(notificationEnvelopes)

  it('retires an agent whose notification arrived as a queue-operation record', () => {
    // The commonest envelope by far, and the one with no `message` key at all:
    // {type, operation, timestamp, sessionId, content}. Rooting the search at
    // message.content is what made this ending invisible.
    expect(info.terminalAgentIds).toContain(ENVELOPE_AGENTS.enqueue)
  })

  it('retires an agent from the queue-operation remove that follows the enqueue', () => {
    // Claude writes the whole blob a second time when the running turn absorbs
    // the queued message (operation: remove, reason: absorbed_mid_turn).
    expect(info.terminalAgentIds).toContain(ENVELOPE_AGENTS.remove)
  })

  it('retires an agent whose notification arrived as a queued_command attachment', () => {
    // {type: 'attachment', attachment: {type: 'queued_command', prompt}} — again
    // no message.content anywhere on the line.
    expect(info.terminalAgentIds).toContain(ENVELOPE_AGENTS.queuedCommand)
  })

  it('still retires an agent from the plain string user line it always understood', () => {
    expect(info.terminalAgentIds).toContain(ENVELOPE_AGENTS.userString)
  })

  it('leaves every agent the fixture never delivered a notification for still mining', () => {
    expect([...info.inFlightAgents.map((a) => a.agentId)].sort()).toEqual([
      ENVELOPE_AGENTS.inFlight,
      ENVELOPE_AGENTS.quotedByToolResult,
      ENVELOPE_AGENTS.quotedByAssistant,
      ENVELOPE_AGENTS.quotedByHook,
      ENVELOPE_AGENTS.quotedByLaunchPrompt,
      ENVELOPE_AGENTS.launchedByThatPrompt
    ])
  })

  it('counts exactly the four delivered endings and nothing else', () => {
    expect([...info.terminalAgentIds].sort()).toEqual([
      ENVELOPE_AGENTS.enqueue,
      ENVELOPE_AGENTS.remove,
      ENVELOPE_AGENTS.queuedCommand,
      ENVELOPE_AGENTS.userString
    ])
  })
})

/**
 * Where the line is drawn between a notification and a quotation of one.
 *
 * A transcript reproduces notifications constantly — a Bash result that printed
 * a transcript, an assistant discussing one, a hook echoing the prompt it saw,
 * an Agent launch whose own prompt pasted one. Counting any of those as an
 * ending retires an agent that is still mining, which is the failure #60 exists
 * to prevent, and `terminalAgentIds` is remembered for the life of the process
 * across every session — so one quoted id evicts a live dwarf somewhere else.
 *
 * The rule is about *who wrote the string*, not what the string looks like:
 * only the harness delivering a message to the session counts.
 */
describe('parseClaudeTranscriptTail quoted notifications (issues #60, #64)', () => {
  const info = parseClaudeTranscriptTail(notificationEnvelopes)

  it('keeps an agent mining when a Bash tool result merely printed its notification', () => {
    expect(info.terminalAgentIds).not.toContain(ENVELOPE_AGENTS.quotedByToolResult)
  })

  it('keeps an agent mining when an assistant message merely discusses its notification', () => {
    expect(info.terminalAgentIds).not.toContain(ENVELOPE_AGENTS.quotedByAssistant)
  })

  it('keeps an agent mining when a hook echoed the notification it was handed', () => {
    // hook_success attachments carry the hook's own stdout. Real endings do
    // arrive this way, but always alongside the queue-operation that delivered
    // them, so reading a hook's output buys no recall and costs the guarantee.
    expect(info.terminalAgentIds).not.toContain(ENVELOPE_AGENTS.quotedByHook)
  })

  it('keeps an agent mining when another launch prompt pasted its notification', () => {
    // The sharpest case: the record is itself an `async_launched` result, so a
    // scan over every string on the line would start one agent and retire
    // another in the same line.
    expect(info.terminalAgentIds).not.toContain(ENVELOPE_AGENTS.quotedByLaunchPrompt)
    expect(info.inFlightAgents.map((a) => a.agentId)).toContain(
      ENVELOPE_AGENTS.launchedByThatPrompt
    )
  })
})

describe('parseClaudeTranscriptTail notification nested in a content block', () => {
  it('reaches a notification inside a content object, not just a bare string', () => {
    // message.content is an array of blocks rather than a string, so the old
    // `typeof item === 'string'` filter dropped the whole line.
    const line =
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                '<task-notification>\n<task-id>a0000000000000001</task-id>\n' +
                '<status>completed</status>\n</task-notification>'
            }
          ]
        }
      }) + '\n'
    expect(parseClaudeTranscriptTail(line).terminalAgentIds).toEqual(['a0000000000000001'])
  })
})

/**
 * Issue #179. Every notification carries Claude Code's own note that "the user
 * can send it another message and resume it, so the same task-id may notify
 * more than once" — so an ending is "stopped for now", and a resume writes no
 * second `async_launched` record for anything to outrank the first one with.
 *
 * The parser cannot tell a resumed agent from a dead one: only the agent's own
 * transcript can, and reading files is the provider's job. All this reports is
 * the launch-time identity of an agent whose LATEST ending said `failed`, which
 * is what it would take to draw that agent again. Nothing here makes anybody
 * in flight — `terminalAgentIds` and `inFlightAgents` are unchanged by it.
 */
describe('parseClaudeTranscriptTail failed agents (issue #179)', () => {
  it('names an agent whose launch record and failed ending share the tail', () => {
    const parsed = parseClaudeTranscriptTail(
      launchLine('agentx') + notificationLine('agentx', 'failed')
    )
    expect(parsed.failedAgents).toEqual([
      { agentId: 'agentx', description: 'd', resolvedModel: undefined }
    ])
    // The ending still stands: this field is evidence for a later question, not
    // a verdict, and the agent is out of the crew exactly as it was before.
    expect(parsed.inFlightAgents).toEqual([])
    expect(parsed.terminalAgentIds).toEqual(['agentx'])
  })

  it.each(['completed', 'killed'])('names nobody for a %s ending', (status) => {
    // Only `failed` is claimed, and deliberately: `killed` is the status whose
    // omission was the original ghost dwarf, and a `completed` agent's last
    // write can legitimately land after its notification. Neither has been
    // observed resuming, so neither buys the relaxation.
    const parsed = parseClaudeTranscriptTail(
      launchLine('agentx') + notificationLine('agentx', status)
    )
    expect(parsed.failedAgents).toEqual([])
  })

  it('names nobody once a later ending superseded the failure', () => {
    // Three failures then a completion is one agent retried and finished. The
    // last ending in the tail is the one that describes the agent now.
    const tail =
      launchLine('agentx') +
      notificationLine('agentx', 'failed') +
      notificationLine('agentx', 'completed')
    expect(parseClaudeTranscriptTail(tail).failedAgents).toEqual([])
  })

  it('still names an agent whose failure is the latest of several endings', () => {
    const tail =
      launchLine('agentx') +
      notificationLine('agentx', 'completed') +
      notificationLine('agentx', 'failed')
    expect(parseClaudeTranscriptTail(tail).failedAgents.map((a) => a.agentId)).toEqual(['agentx'])
  })

  it('names nobody when the failed agent has no launch record in this window', () => {
    // Without the launch record there is no description, no model and no proof
    // this window ever saw the agent start — nothing to draw, so nothing said.
    expect(parseClaudeTranscriptTail(notificationLine('agentx', 'failed')).failedAgents).toEqual([])
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

/**
 * One line per tool call, interleaved in call order between the speech either
 * side of it (#240). The verb and the subject come off
 * `domain/permissionSummary.ts`'s shared table — the same one a permission
 * card reads for the SAME call while it is still pending — so a Bash call
 * cannot read one way on the card and another way in the line it leaves
 * behind.
 */
describe('extractClaudeFeed activity lines (#240)', () => {
  /** One assistant line carrying an arbitrary content-block array. */
  function assistantLine(content: unknown[], timestamp = '2026-09-07T10:00:00.000Z'): string {
    return (
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content }, timestamp }) +
      '\n'
    )
  }

  it('publishes a tool call as its own line, in the summary form the permission card uses', () => {
    const tail = assistantLine([
      { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pnpm test' } }
    ])
    expect(extractClaudeFeed(tail, 20)).toEqual([
      {
        role: 'assistant',
        text: 'Ran pnpm test',
        timestamp: '2026-09-07T10:00:00.000Z',
        activity: { kind: 'run', target: 'pnpm test' }
      }
    ])
  })

  it('interleaves a tool call between the text either side of it, each on its own line', () => {
    const tail = assistantLine([
      { type: 'text', text: 'Let me check the tests.' },
      { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pnpm test' } },
      { type: 'text', text: 'They pass.' }
    ])
    const feed = extractClaudeFeed(tail, 20)
    expect(feed.map((m) => [m.role, m.text])).toEqual([
      ['assistant', 'Let me check the tests.'],
      ['assistant', 'Ran pnpm test'],
      ['assistant', 'They pass.']
    ])
    expect(feed[1]!.activity).toEqual({ kind: 'run', target: 'pnpm test' })
    expect('activity' in feed[0]!).toBe(false)
    expect('activity' in feed[2]!).toBe(false)
  })

  it('carries several tool calls on the same line as text, each its own row and in call order', () => {
    const tail = assistantLine([
      { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'src/parse.ts' } },
      { type: 'tool_use', id: 'toolu_2', name: 'Edit', input: { file_path: 'src/parse.ts' } }
    ])
    expect(extractClaudeFeed(tail, 20).map((m) => m.text)).toEqual([
      'Read src/parse.ts',
      'Edited src/parse.ts'
    ])
  })

  it('publishes nothing for a tool this table names no verb for, such as Agent', () => {
    // Agent traffic is drawn as a dwarf already (see TOOL_ACTIVITY_KINDS), so a
    // line here would say the same thing twice.
    const tail = assistantLine([
      { type: 'tool_use', id: 'toolu_1', name: 'Agent', input: { description: 'survey the seam' } }
    ])
    expect(extractClaudeFeed(tail, 20)).toEqual([])
  })

  it('publishes nothing for AskUserQuestion, which travels as pendingQuestion instead', () => {
    const tail = assistantLine([
      { type: 'tool_use', id: 'toolu_1', name: 'AskUserQuestion', input: askInput('Which?') }
    ])
    expect(extractClaudeFeed(tail, 20)).toEqual([])
  })

  it('redacts a secret in a tool-call line, same as it would in spoken text', () => {
    const key = ['sk', 'a'.repeat(48)].join('-')
    const tail = assistantLine([
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'Bash',
        input: { command: `curl -H "auth: ${key}" x.test` }
      }
    ])
    expect(extractClaudeFeed(tail, 20)[0]!.text).toBe('Ran curl -H "auth: [redacted]" x.test')
  })

  // AMENDED for #359 (was: 'counts a tool-call line toward the same limit as a
  // spoken message', expecting `extractClaudeFeed(tail, 2)` to answer
  // ['Ran pnpm test', 'two'] — the two newest ROWS). That is the defect #359
  // reports: `limit` is a count of things said, and a tool call is carried
  // beside the words rather than instead of them.
  it('spends the limit on things said, carrying the tool-call line between them', () => {
    const tail =
      assistantLine([{ type: 'text', text: 'one' }], '2026-09-07T10:00:00.000Z') +
      assistantLine(
        [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pnpm test' } }],
        '2026-09-07T10:00:01.000Z'
      ) +
      assistantLine([{ type: 'text', text: 'two' }], '2026-09-07T10:00:02.000Z')
    expect(extractClaudeFeed(tail, 2).map((m) => m.text)).toEqual(['one', 'Ran pnpm test', 'two'])
  })

  it('keeps both replies when twenty tool calls have run since the last of them (#359)', () => {
    // The transcript the defect was measured on, in miniature: the agent said
    // two things and then worked for a long stretch without speaking. Every
    // one of the twelve rows the panel asked for used to be a tool call, so it
    // drew one folded run and nothing said.
    const tools = ['Bash', 'Read', 'Grep', 'Edit'] as const
    const calls = Array.from({ length: 20 }, (_, index) =>
      assistantLine(
        [
          {
            type: 'tool_use',
            id: `toolu_${index}`,
            name: tools[index % tools.length],
            input:
              index % tools.length === 0
                ? { command: `pnpm test --shard ${index}` }
                : index % tools.length === 2
                  ? { pattern: `FeedMessage${index}` }
                  : { file_path: `src/main/step${index}.ts` }
          }
        ],
        `2026-09-07T10:01:${String(index).padStart(2, '0')}.000Z`
      )
    ).join('')
    const tail =
      assistantLine([{ type: 'text', text: 'Reading the extractor.' }]) +
      assistantLine([{ type: 'text', text: 'Found it; fixing now.' }]) +
      calls

    const feed = extractClaudeFeed(tail, 12)
    expect(feed.filter((m) => m.activity === undefined).map((m) => m.text)).toEqual([
      'Reading the extractor.',
      'Found it; fixing now.'
    ])
    expect(feed.filter((m) => m.activity !== undefined)).toHaveLength(20)
  })

  it('reads a real transcript unchanged: the Agent calls it carries publish no line of their own', () => {
    // parentTranscript's only tool_use blocks are Agent calls, which #240
    // leaves to the dwarf the board already draws — so this pins that the
    // interleaving above changes nothing for the fixture every other
    // extractClaudeFeed test in this file already depends on.
    const feed = extractClaudeFeed(parentTranscript, 20)
    expect(feed.map((m) => [m.role, m.text])).toEqual([
      ['user', 'Placeholder user prompt.'],
      ['assistant', 'Placeholder text block.'],
      ['assistant', 'Latest assistant reply placeholder.']
    ])
  })
})

/** The element Claude Code wraps one relayed message in, wherever it lands. */
function crossSessionEnvelope(text: string): string {
  return (
    '<cross-session-message from="uds:placeholder-socket" from-name="relay-42" ' +
    `from-mode="bypass">\n${text}\n</cross-session-message>`
  )
}

/** The peer origin such a message carries when it lands mid-turn. */
function peerOrigin(body?: string): unknown {
  return {
    kind: 'peer',
    from: 'uds:placeholder-socket',
    msg_id: 'placeholder-msg-id',
    name: 'relay-42',
    fromMode: 'bypass',
    ...(body === undefined ? {} : { body })
  }
}

/** A user line exactly as Claude Code records one relayed cross-session message. */
function relayedMessageLine(text: string): string {
  return (
    JSON.stringify({
      type: 'user',
      isMeta: true,
      timestamp: '2026-09-03T10:00:00.000Z',
      message: {
        role: 'user',
        content:
          'Another Claude session sent a message:\n' +
          crossSessionEnvelope(text) +
          '\n\nThis came from another Claude session, not from your user.'
      }
    }) + '\n'
  )
}

/** An ordinary meta line: the harness talking to the session, not a person. */
function metaLine(content: string): string {
  return (
    JSON.stringify({
      type: 'user',
      isMeta: true,
      timestamp: '2026-09-03T10:00:01.000Z',
      message: { role: 'user', content }
    }) + '\n'
  )
}

/**
 * The three lines one message typed into the TUI mid-turn produces: enqueued,
 * materialised into the running turn, then removed as absorbed. It is never
 * written as a `user` line at all.
 */
function midTurnMessageLines(text: string, origin: unknown = { kind: 'human' }): string {
  // `null` is how a case asks for a record carrying no origin key at all;
  // passing undefined would take the default above instead.
  const timestamp = '2026-09-03T10:05:00.000Z'
  return (
    JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      timestamp,
      sessionId: '5efdffdd-53df-4509-b30d-c9e56552a22e',
      content: text
    }) +
    '\n' +
    JSON.stringify({
      type: 'attachment',
      attachment: {
        type: 'queued_command',
        prompt: text,
        commandMode: 'prompt',
        ...(origin === null ? {} : { origin }),
        timestamp
      },
      isSidechain: false,
      timestamp
    }) +
    '\n' +
    JSON.stringify({
      type: 'queue-operation',
      operation: 'remove',
      content: text,
      reason: 'absorbed_mid_turn',
      timestamp
    }) +
    '\n'
  )
}

/**
 * The same three records for a message RELAYED into a session that was already
 * mid-turn: still a `queued_command`, but the prompt is the whole
 * cross-session envelope and the origin is the peer session that sent it.
 * Field names and nesting come from a live transcript.
 */
function relayedMidTurnLines(prompt: string, origin: unknown): string {
  const timestamp = '2026-09-03T10:07:00.000Z'
  return (
    JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      timestamp,
      sessionId: '5efdffdd-53df-4509-b30d-c9e56552a22e',
      content: prompt
    }) +
    '\n' +
    JSON.stringify({
      type: 'attachment',
      attachment: {
        type: 'queued_command',
        prompt,
        source_uuid: 'placeholder-source-uuid',
        commandMode: 'prompt',
        origin,
        timestamp,
        isMeta: true
      },
      isSidechain: false,
      timestamp
    }) +
    '\n' +
    JSON.stringify({
      type: 'queue-operation',
      operation: 'remove',
      content: prompt,
      reason: 'absorbed_mid_turn',
      timestamp
    }) +
    '\n'
  )
}

/**
 * Issue #180. The panel's history is this feed, and three shapes of message the
 * user really sent were never in it — all because the reader only understood
 * the one envelope a message typed at a turn boundary happens to land in.
 *
 * A message delivered through the relay tier (#24) arrives as a meta user line
 * wrapping Claude Code's own cross-session framing, and a message typed while
 * the assistant is mid-turn is not written as a user line at all: it is
 * enqueued, materialised as a `queued_command` attachment, and absorbed. The
 * third is both at once — a relayed message landing mid-turn, which takes the
 * attachment shape with the whole envelope in its prompt and a `peer` origin.
 * All three were dropped, so the dwarf said delivered and the conversation
 * stayed empty.
 */
describe('extractClaudeFeed messages the panel never showed (issue #180)', () => {
  it('shows a relayed message as the text the human typed, without the framing', () => {
    const feed = extractClaudeFeed(relayedMessageLine('Ship the vault fix.'), 20)
    expect(feed.map((m) => [m.role, m.text])).toEqual([['user', 'Ship the vault fix.']])
    expect(feed[0]!.timestamp).toBe('2026-09-03T10:00:00.000Z')
  })

  it('keeps a multi-line relayed message whole', () => {
    const feed = extractClaudeFeed(relayedMessageLine('First line.\nSecond line.'), 20)
    expect(feed.map((m) => m.text)).toEqual(['First line.\nSecond line.'])
  })

  it('still keeps every other meta line out of the feed', () => {
    // The skip is not the bug: a meta line is the harness talking to the
    // session. Only the one envelope that carries a person's words is read.
    const tail =
      metaLine('<command-name>/clear</command-name>') +
      metaLine('Caveat: placeholder system reminder.')
    expect(extractClaudeFeed(tail, 20)).toEqual([])
  })

  it('ignores a relay envelope a tool result merely printed', () => {
    // Tool output can contain a whole transcript, envelopes and all — the same
    // reason an ending is only read from the envelopes Claude Code wrote it
    // into (issue #64). A printed message is not a message.
    const printed =
      JSON.stringify({
        type: 'user',
        timestamp: '2026-09-03T10:00:02.000Z',
        message: {
          role: 'user',
          content:
            '<cross-session-message from-name="relay-42">\nShip the vault fix.\n' +
            '</cross-session-message>'
        },
        toolUseResult: { stdout: 'printed', stderr: '', interrupted: false, isImage: false }
      }) + '\n'
    expect(extractClaudeFeed(printed, 20)).toEqual([])
  })

  it('says nothing for an envelope with no message inside it', () => {
    expect(extractClaudeFeed(relayedMessageLine(''), 20)).toEqual([])
  })

  it('shows a message typed while the assistant was still in its turn', () => {
    const feed = extractClaudeFeed(midTurnMessageLines('Stop and read the issue first.'), 20)
    expect(feed.map((m) => [m.role, m.text])).toEqual([['user', 'Stop and read the issue first.']])
    expect(feed[0]!.timestamp).toBe('2026-09-03T10:05:00.000Z')
  })

  it('reads that message once, from the attachment and not the queue pair', () => {
    // The same text is written three times — enqueue, attachment, remove. Only
    // the middle one is the message materialising into the turn; reading the
    // queue-operations too would triple every mid-turn message in the history.
    const feed = extractClaudeFeed(midTurnMessageLines('Stop and read the issue first.'), 20)
    expect(feed).toHaveLength(1)
  })

  it('leaves a queued command the harness wrote out of the feed', () => {
    // `origin.kind` is the whole test: the identical record shape carries the
    // harness's own queued prompts — a task-notification is one — and those are
    // not somebody speaking.
    expect(
      extractClaudeFeed(midTurnMessageLines('Agent finished', { kind: 'system' }), 20)
    ).toEqual([])
    // ...and a record with no origin at all proves nothing about who wrote it.
    expect(extractClaudeFeed(midTurnMessageLines('Agent finished', null), 20)).toEqual([])
  })

  it('leaves a queued command out however much it looks like a relayed message', () => {
    // The kind is the gate, not the shape of what it carries: a harness record
    // holding an envelope and even a body is still the harness queueing text.
    // Only the two kinds that name a person speaking are published.
    const tail = relayedMidTurnLines(crossSessionEnvelope('Ship it.'), {
      kind: 'system',
      body: 'Ship it.'
    })
    expect(extractClaudeFeed(tail, 20)).toEqual([])
  })

  it('shows a relayed message that landed while the assistant was mid-turn', () => {
    // Both failures at once: the envelope of the first shape inside the record
    // of the second. The origin the peer session sent carries the message on
    // its own, so that is what the panel shows.
    const feed = extractClaudeFeed(
      relayedMidTurnLines(crossSessionEnvelope('Ship it.'), peerOrigin('Ship it.')),
      20
    )
    expect(feed.map((m) => [m.role, m.text])).toEqual([['user', 'Ship it.']])
    expect(feed[0]!.timestamp).toBe('2026-09-03T10:07:00.000Z')
  })

  it('reads the peer origin body even when the prompt carries nothing', () => {
    // The body is what the sending session put on the wire, so it is read
    // first and stands on its own: the prompt is the same words a second time,
    // and a record that lost them still has a message to show.
    const feed = extractClaudeFeed(relayedMidTurnLines('', peerOrigin('Ship it.')), 20)
    expect(feed.map((m) => m.text)).toEqual(['Ship it.'])
  })

  it('unwraps the prompt envelope when a peer origin carries no body', () => {
    // The body is the direct evidence and the envelope is the same words a
    // second time, so the fallback costs nothing and covers a shape whose
    // origin keys a later Claude Code spells differently.
    const envelope = crossSessionEnvelope('Ship it.')
    const feed = extractClaudeFeed(relayedMidTurnLines(envelope, peerOrigin()), 20)
    expect(feed.map((m) => m.text)).toEqual(['Ship it.'])
  })

  it('says nothing when a peer record carries no message either way', () => {
    // An empty envelope and no body, then a prompt that is not an envelope at
    // all: two ways to have nothing to say, and neither may publish a bubble.
    expect(
      extractClaudeFeed(relayedMidTurnLines(crossSessionEnvelope(''), peerOrigin()), 20)
    ).toEqual([])
    expect(extractClaudeFeed(relayedMidTurnLines('no envelope here', peerOrigin()), 20)).toEqual([])
  })

  it('reads a relayed mid-turn message once, not from the queue pair around it', () => {
    const tail = relayedMidTurnLines(crossSessionEnvelope('Ship it.'), peerOrigin('Ship it.'))
    expect(extractClaudeFeed(tail, 20)).toHaveLength(1)
  })

  it('keeps all three kinds in transcript order beside an ordinary exchange', () => {
    const tail =
      parentTranscript +
      relayedMessageLine('Ship the vault fix.') +
      midTurnMessageLines('And update the docs.') +
      relayedMidTurnLines(
        crossSessionEnvelope('Then tag the release.'),
        peerOrigin('Then tag the release.')
      )
    expect(extractClaudeFeed(tail, 20).map((m) => [m.role, m.text])).toEqual([
      ['user', 'Placeholder user prompt.'],
      ['assistant', 'Placeholder text block.'],
      ['assistant', 'Latest assistant reply placeholder.'],
      ['user', 'Ship the vault fix.'],
      ['user', 'And update the docs.'],
      ['user', 'Then tag the release.']
    ])
  })
})

/** One `user` line whose `message.content` is whatever shape a test needs. */
function contentUserLine(content: unknown, extra: Record<string, unknown> = {}): string {
  return (
    JSON.stringify({
      type: 'user',
      timestamp: '2026-09-04T10:00:00.000Z',
      message: { role: 'user', content },
      ...extra
    }) + '\n'
  )
}

/*
 * Issue #216. A `user` line's content is a string most of the time and a block
 * array the rest of it, and the reader accepted only the string — so about one
 * human prompt in twenty never reached any feed, invisibly: nothing logs a
 * dropped line.
 *
 * Measured over every Claude transcript on the machine this was written on
 * (519 files, 537 MiB, 35 870 `user` lines): 1746 string contents, 103
 * text-block arrays, 14 mixed arrays, and 33 976 arrays holding tool results
 * alone. Not one of the 117 arrays carrying text also carried
 * `toolUseResult`, and none of their joined text opened with a tag — so
 * reading text blocks cannot reach the tool-output fork the string path leaves
 * open. The 33 976 must stay out, which is why only a block's own `text` is
 * read and never a `tool_result`'s nested content: a tool prints whole
 * transcripts.
 */
describe('extractClaudeFeed on block-array user content (issue #216)', () => {
  it('reads a prompt whose content is a single text block', () => {
    const feed = extractClaudeFeed(contentUserLine([{ type: 'text', text: 'dig' }]), 20)
    expect(feed.map((m) => [m.role, m.text])).toEqual([['user', 'dig']])
    expect(feed[0]!.timestamp).toBe('2026-09-04T10:00:00.000Z')
  })

  it('says nothing for an array that holds only tool results', () => {
    // The dominant shape by three orders of magnitude, and the one the string
    // check was accidentally filtering. Its nested content is deliberately
    // unread: a tool_result can hold a whole transcript.
    const tail = contentUserLine(
      [
        { type: 'tool_result', tool_use_id: 'toolu_01', content: 'ok' },
        { type: 'tool_result', tool_use_id: 'toolu_02', content: [{ type: 'text', text: 'ok' }] }
      ],
      { toolUseResult: { stdout: 'ok' } }
    )
    expect(extractClaudeFeed(tail, 20)).toEqual([])
  })

  it('takes the text blocks of a mixed array and leaves the tool result out', () => {
    const feed = extractClaudeFeed(
      contentUserLine([
        { type: 'tool_result', tool_use_id: 'toolu_01', content: 'ok' },
        { type: 'text', text: 'now dig deeper' }
      ]),
      20
    )
    expect(feed.map((m) => m.text)).toEqual(['now dig deeper'])
  })

  it('joins several text blocks of one prompt', () => {
    const feed = extractClaudeFeed(
      contentUserLine([
        { type: 'text', text: 'First line.' },
        { type: 'text', text: 'Second line.' }
      ]),
      20
    )
    expect(feed.map((m) => m.text)).toEqual(['First line.\nSecond line.'])
  })

  it('keeps both existing skips over the array shape too', () => {
    // 57 of the 103 text-block arrays measured were `isMeta` — the harness
    // talking to the session in the newer shape. Widening what counts as
    // content must not widen what counts as a person.
    expect(
      extractClaudeFeed(contentUserLine([{ type: 'text', text: 'dig' }], { isMeta: true }), 20)
    ).toEqual([])
    expect(
      extractClaudeFeed(
        contentUserLine([{ type: 'text', text: '<command-name>/clear</command-name>' }]),
        20
      )
    ).toEqual([])
  })

  it('unwraps a relay envelope carried in a text block', () => {
    const feed = extractClaudeFeed(
      contentUserLine([{ type: 'text', text: crossSessionEnvelope('Ship the vault fix.') }]),
      20
    )
    expect(feed.map((m) => m.text)).toEqual(['Ship the vault fix.'])
  })

  it('says nothing for an array with no readable text in it', () => {
    expect(extractClaudeFeed(contentUserLine([{ type: 'text', text: '' }]), 20)).toEqual([])
    expect(extractClaudeFeed(contentUserLine([]), 20)).toEqual([])
    expect(extractClaudeFeed(contentUserLine([{ type: 'image' }]), 20)).toEqual([])
    expect(extractClaudeFeed(contentUserLine(null), 20)).toEqual([])
  })
})

/*
 * Issue #188. Two `user` lines in that same corpus carried `isCompactSummary`,
 * both of them also `isVisibleInTranscriptOnly`: Claude Code's compaction
 * summary, multiple kilobytes of "This session is being continued from a
 * previous conversation...", which the panel drew as a message the person
 * typed. It is the harness writing down its own state, not conversation.
 */
describe('extractClaudeFeed on the harness transcript bookkeeping (issue #188)', () => {
  it('says nothing for a compaction summary', () => {
    const tail = contentUserLine(
      'This session is being continued from a previous conversation that ran out of context.',
      { isCompactSummary: true, isVisibleInTranscriptOnly: true }
    )
    expect(extractClaudeFeed(tail, 20)).toEqual([])
  })

  it('says nothing for a line marked visible in the transcript only', () => {
    // Either flag on its own is enough: both name a line written for the
    // transcript rather than sent by anybody.
    expect(
      extractClaudeFeed(
        contentUserLine('Placeholder summary.', { isVisibleInTranscriptOnly: true }),
        20
      )
    ).toEqual([])
    expect(
      extractClaudeFeed(contentUserLine('Placeholder summary.', { isCompactSummary: true }), 20)
    ).toEqual([])
  })

  it('still publishes an ordinary prompt written beside one', () => {
    const tail =
      contentUserLine('Placeholder summary.', { isCompactSummary: true }) +
      contentUserLine('carry on digging')
    expect(extractClaudeFeed(tail, 20).map((m) => m.text)).toEqual(['carry on digging'])
  })

  it('skips a summary written as a block array too', () => {
    // The flag decides, never the content shape — the fifth shape #216 added
    // must not become a way back in.
    const tail = contentUserLine([{ type: 'text', text: 'Placeholder summary.' }], {
      isCompactSummary: true
    })
    expect(extractClaudeFeed(tail, 20)).toEqual([])
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

/**
 * Issue #60. The normalized reason is derived from the registry's own
 * `waitingFor` vocabulary and from nothing else — never from a question mark
 * or from assistant prose, which is the whole risk the issue names.
 *
 * The fixture carries one entry per string Claude Code v2.1.251 can write,
 * read out of the shipped binary's own derivation rather than guessed:
 * `input needed`, `permission prompt`, `sandbox request`, `goal proposal`,
 * `worker request`, `dialog open`, plus `waiting` with no condition at all.
 */
describe('claudeWaitingReason (issue #60)', () => {
  /** The fixture entry whose registry `waitingFor` is this string. */
  function entryFor(waitingFor: string | undefined): ReturnType<typeof parseClaudeSessionEntry> {
    const json = waitingRegistryJson.find(
      (candidate) => (candidate as { waitingFor?: string }).waitingFor === waitingFor
    )
    expect(json, `no fixture entry for ${String(waitingFor)}`).toBeDefined()
    return parseClaudeSessionEntry(json)
  }

  it('reads user-input from the one condition that proves a human must answer', () => {
    // `input needed` is what an elicitation prompt and the ask-the-user
    // dialogs write. Nothing else in the vocabulary names a pending answer.
    expect(claudeWaitingReason(entryFor('input needed')!)).toBe('user-input')
  })

  it('reads approval from the conditions that name something to allow or refuse', () => {
    expect(claudeWaitingReason(entryFor('permission prompt')!)).toBe('approval')
    expect(claudeWaitingReason(entryFor('sandbox request')!)).toBe('approval')
    expect(claudeWaitingReason(entryFor('goal proposal')!)).toBe('approval')
  })

  it('leaves a bare open dialog unknown rather than claiming it wants an answer', () => {
    // The commonest value in the whole vocabulary, and it names only that a
    // modal is up: the same string covers a startup model switch and a
    // managed-settings review. Blocked is proven; blocked ON THE HUMAN is not.
    expect(claudeWaitingReason(entryFor('dialog open')!)).toBe('unknown')
    expect(claudeWaitingReason(entryFor('worker request')!)).toBe('unknown')
  })

  it('reports unknown when the registry proves waiting but names no condition', () => {
    expect(claudeWaitingReason(entryFor(undefined)!)).toBe('unknown')
  })

  it('reports unknown for a condition this version of Claude Code did not have', () => {
    // The vocabulary is version-specific and has grown before. A string nobody
    // has read is the absence of evidence, so it lands on unknown — never on
    // the one value that suspends eviction.
    const entry = parseClaudeSessionEntry({
      pid: 1,
      sessionId: 's',
      cwd: 'c',
      status: 'waiting',
      waitingFor: 'something invented later'
    })
    expect(claudeWaitingReason(entry!)).toBe('unknown')
  })

  it('carries no reason at all for a session that is not blocked', () => {
    // Absent is not `unknown`: one says the session is not waiting, the other
    // says it is waiting for a reason nothing proved.
    expect(claudeWaitingReason(parseClaudeSessionEntry(sessionEntryJson)!)).toBeUndefined()
    const idle = parseClaudeSessionEntry({ pid: 1, sessionId: 's', cwd: 'c', status: 'idle' })
    expect(claudeWaitingReason(idle!)).toBeUndefined()
  })

  it('reads the condition even when an unknown status normalized away the waiting', () => {
    // parseClaudeSessionEntry folds every status it does not recognize into
    // `idle`, so a future spelling of "blocked" would erase the session's only
    // proof of life. The condition itself survives that fold, which is what
    // keeps the eviction gate from depending on one status string.
    const entry = parseClaudeSessionEntry({
      pid: 1,
      sessionId: 's',
      cwd: 'c',
      status: 'blocked-on-something-new',
      waitingFor: 'input needed'
    })
    expect(entry?.status).toBe('idle')
    expect(claudeWaitingReason(entry!)).toBe('user-input')
  })
})

/** The `tool_use` block Claude writes when the model asks the user something. */
function askLine(toolUseId: string, input: unknown, timestamp?: string): string {
  return (
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolUseId, name: 'AskUserQuestion', input }]
      },
      ...(timestamp === undefined ? {} : { timestamp })
    }) + '\n'
  )
}

/** The `tool_result` block that resolves one ask; is_error is a decline or an interrupt. */
function answerLine(toolUseId: string, isError = false): string {
  return (
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: 'Accumulate',
            ...(isError ? { is_error: true } : {})
          }
        ]
      }
    }) + '\n'
  )
}

/** One well-formed AskUserQuestion input, so a case can vary just the part it is about. */
function askInput(question: string): unknown {
  return {
    questions: [
      {
        question,
        header: 'Approach',
        multiSelect: false,
        options: [{ label: 'Accumulate', description: 'Collect asks while walking the tail.' }]
      }
    ]
  }
}

/**
 * Issue #94. A question the model asks through the AskUserQuestion tool is not
 * prose that reads like a request — it is the model declaring in schema that it
 * is asking, and enumerating the answers it will accept. That is why reading it
 * does not touch the prohibition at contracts.ts:93-98, which bars INFERRING a
 * blocked state from text.
 *
 * The asymmetry that makes it safe: a tail is a suffix of the file and the
 * result line is always written after the ask, so "ask visible, its answer
 * scrolled out" cannot happen. Truncation can only hide a pending question,
 * never invent one. Misses are possible, false claims are not.
 */
describe('parseClaudeTranscriptTail pending question (issue #94)', () => {
  const info = parseClaudeTranscriptTail(askUserQuestion)

  it('carries the ask that has no tool_result behind it in this tail', () => {
    expect(info.pendingQuestion).toEqual({
      toolUseId: 'toolu_01AskPlaceholderPending',
      question: 'Which materials should the vault chart?',
      header: 'Materials',
      multiSelect: true,
      options: [
        { label: 'Copper', description: 'The starter material every mine yields.' },
        { label: 'Silver', description: 'The second tier, once a mine is measured.' },
        { label: 'Uranium', description: 'The rarest tier in the ladder.' }
      ],
      askedAt: '2026-09-01T09:03:41.062Z'
    })
  })

  it('drops the option preview, which can carry a whole code block', () => {
    // Every option in the fixture has one. Nothing downstream needs it, and the
    // panel would be carrying arbitrary source across the wire to show 70 chars.
    expect(JSON.stringify(info.pendingQuestion)).not.toContain('preview')
    expect(JSON.stringify(info.pendingQuestion)).not.toContain('materialUnits')
  })

  it('still reads the assistant text sitting beside the tool_use block', () => {
    // The ask and a text block share one assistant message in the fixture, so a
    // question must not cost the speech bubble.
    expect(info.lastAssistantText).toBe('Latest assistant reply placeholder.')
  })

  it('reports no pending question once the matching tool_result arrives', () => {
    const tail = askLine('toolu_a', askInput('Which approach?')) + answerLine('toolu_a')
    expect(parseClaudeTranscriptTail(tail).pendingQuestion).toBeUndefined()
  })

  it('reports no pending question when the ask was declined or interrupted', () => {
    // is_error marks the refusal Claude writes when the user escapes out of the
    // picker. A cancelled question is resolved, not still waiting on anyone.
    const tail = askLine('toolu_a', askInput('Which approach?')) + answerLine('toolu_a', true)
    expect(parseClaudeTranscriptTail(tail).pendingQuestion).toBeUndefined()
  })

  it('reports the later ask when an earlier one has already been answered', () => {
    const tail =
      askLine('toolu_a', askInput('First question?')) +
      answerLine('toolu_a') +
      askLine('toolu_b', askInput('Second question?'))
    expect(parseClaudeTranscriptTail(tail).pendingQuestion?.toolUseId).toBe('toolu_b')
  })

  it('reports the latest of two asks that are both still open', () => {
    const tail =
      askLine('toolu_a', askInput('First question?')) + askLine('toolu_b', askInput('Second?'))
    expect(parseClaudeTranscriptTail(tail).pendingQuestion?.question).toBe('Second?')
  })

  it('carries no question at all for a tail that holds no ask', () => {
    // The window bounds visibility: an ask older than the tail is simply absent,
    // which is the miss the design accepts rather than a claim it invents.
    expect(parseClaudeTranscriptTail(parentTranscript).pendingQuestion).toBeUndefined()
    expect(parseClaudeTranscriptTail('').pendingQuestion).toBeUndefined()
  })

  it('ignores a tool_use block for any other tool', () => {
    const tail =
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_a', name: 'Bash', input: askInput('Which?') }]
        }
      }) + '\n'
    expect(parseClaudeTranscriptTail(tail).pendingQuestion).toBeUndefined()
  })

  it.each([
    ['no input at all', undefined],
    ['a non-object input', 'questions'],
    ['no questions key', { headers: [] }],
    ['a non-array questions value', { questions: { question: 'Which?' } }],
    ['an empty questions array', { questions: [] }],
    ['a question that is not a record', { questions: ['Which approach?'] }],
    ['a non-string question', { questions: [{ question: 7, options: [] }] }],
    ['a non-array options value', { questions: [{ question: 'Which?', options: 'Accumulate' }] }]
  ])('tolerates %s without throwing or claiming a question', (_label, input) => {
    const tail = askLine('toolu_a', input)
    expect(() => parseClaudeTranscriptTail(tail)).not.toThrow()
    expect(parseClaudeTranscriptTail(tail).pendingQuestion).toBeUndefined()
  })

  it('keeps a well-formed question whose options are individually malformed', () => {
    // The question is the load-bearing half. A junk option is dropped on its
    // own rather than costing the panel the whole ask.
    const tail = askLine('toolu_a', {
      questions: [
        {
          question: 'Which approach?',
          options: [{ label: 'Accumulate' }, 'Second pass', { description: 'no label' }]
        }
      ]
    })
    expect(parseClaudeTranscriptTail(tail).pendingQuestion).toEqual({
      toolUseId: 'toolu_a',
      question: 'Which approach?',
      multiSelect: false,
      options: [{ label: 'Accumulate' }]
    })
  })

  it('ignores an ask whose tool_use block carries no id to resolve it by', () => {
    // Without an id nothing could ever mark it answered, so it would sit on the
    // panel forever. Absent evidence, not a question.
    const tail =
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'AskUserQuestion', input: askInput('Which?') }]
        }
      }) + '\n'
    expect(parseClaudeTranscriptTail(tail).pendingQuestion).toBeUndefined()
  })

  it('resolves an ask even when its result line arrives before it in the tail', () => {
    // Cannot happen in a real suffix read, and the parser must not depend on
    // that: resolution is id matching over the whole tail, not line order.
    const tail = answerLine('toolu_a') + askLine('toolu_a', askInput('Which approach?'))
    expect(parseClaudeTranscriptTail(tail).pendingQuestion).toBeUndefined()
  })
})

/**
 * Issue #94. The registry proves a session is BLOCKED; an outstanding ask can
 * only say what it is blocked ON. Neither source may claim the other's fact,
 * which is the whole shape of this: the tool block refines, and never asserts.
 *
 * So exactly one value moves, 'unknown' — "the provider proved this session is
 * blocked but named no condition this table recognizes" (see WaitingReason).
 * That is proof of blocked with the condition missing, which is precisely the
 * hole an unanswered AskUserQuestion fills. Every other reading is untouched:
 * a named condition is the registry's own answer and needs no help, and
 * `undefined` — not blocked, or nothing proves it either way — must stay
 * absent, because moving THAT would be the tool block asserting a blocked
 * state, which is the thing #60 refused.
 */
describe('claudeWaitingReason refined by an outstanding ask (issue #94)', () => {
  /** The one ask the fixture ends on with no result behind it. */
  const openAsk = parseClaudeTranscriptTail(askUserQuestion).pendingQuestion

  /** A registry entry with just the status and condition a case is about. */
  function entry(status: string, waitingFor?: string): ClaudeSessionEntry {
    return parseClaudeSessionEntry({
      pid: 1,
      sessionId: 's',
      cwd: 'c',
      status,
      ...(waitingFor !== undefined ? { waitingFor } : {})
    })!
  }

  it('refines a bare open dialog into user-input, and only with the ask', () => {
    // The commonest waiting value in the whole vocabulary, and the one the
    // issue is about: the registry says a modal is up, the model's own tool
    // call says what the modal wants. Both halves are asserted here so the
    // refinement cannot pass by making 'dialog open' user-input outright.
    expect(openAsk).toBeDefined()
    expect(claudeWaitingReason(entry('waiting', 'dialog open'))).toBe('unknown')
    expect(claudeWaitingReason(entry('waiting', 'dialog open'), openAsk)).toBe('user-input')
  })

  it('refines a session that proved waiting while naming no condition at all', () => {
    expect(claudeWaitingReason(entry('waiting'), openAsk)).toBe('user-input')
  })

  it('refines a condition this version of Claude Code never wrote', () => {
    // Reached 'unknown' by a different road — an unrecognized string rather
    // than a recognized-but-uninformative one — and 'unknown' means the same
    // thing either way, so the refinement must not care which road it came by.
    const invented = entry('waiting', 'something invented later')
    expect(claudeWaitingReason(invented)).toBe('unknown')
    expect(claudeWaitingReason(invented, openAsk)).toBe('user-input')
  })

  it('leaves every explicitly named condition exactly as the registry wrote it', () => {
    // The explicit mapping wins. An approval and an outstanding question can
    // both be true, and the registry is the one that watched the session stop:
    // rewriting its answer would be the tool block overruling it, not refining
    // it. `input needed` needs nothing either — it already proved the question.
    expect(claudeWaitingReason(entry('waiting', 'permission prompt'), openAsk)).toBe('approval')
    expect(claudeWaitingReason(entry('waiting', 'sandbox request'), openAsk)).toBe('approval')
    expect(claudeWaitingReason(entry('waiting', 'goal proposal'), openAsk)).toBe('approval')
    expect(claudeWaitingReason(entry('waiting', 'input needed'), openAsk)).toBe('user-input')
  })

  it('gives a session nothing proved blocked no reason, whatever its tail holds', () => {
    // THE guard on the whole phase. An ask sitting in the tail of a busy
    // session is the model still working — it wrote the tool call and the turn
    // has not stopped on it yet — and 'user-input' suspends eviction, so a
    // reason invented here makes a dwarf that never leaves. Absent stays
    // absent: the tool block may refine a proof, never manufacture one.
    expect(claudeWaitingReason(entry('busy'), openAsk)).toBeUndefined()
    expect(claudeWaitingReason(entry('idle'), openAsk)).toBeUndefined()
  })

  it('drops the refinement the moment the ask is answered', () => {
    const answered = parseClaudeTranscriptTail(
      askUserQuestion + answerLine('toolu_01AskPlaceholderPending')
    ).pendingQuestion
    expect(answered).toBeUndefined()
    expect(claudeWaitingReason(entry('waiting', 'dialog open'), answered)).toBe('unknown')
  })
})

/**
 * Issue #203. The half of an OBSERVED session's permission prompt that the
 * transcript can answer.
 *
 * Claude Code's `permission_prompt` hook says a dialog is open for a session
 * and never what it asks. The assistant's own `tool_use` block says exactly
 * what — and it is written to the transcript BEFORE the dialog opens, so it is
 * readable while the dialog stands, which is precisely what an
 * `AskUserQuestion` in the same TUI is not (see the docs' channel matrix).
 * While the prompt is open nothing has resolved that call, so an unresolved
 * `tool_use` is what the two halves have in common.
 *
 * Nothing here claims a prompt is open. This is the WHAT; the hook is the
 * WHETHER, and the provider is the only place the two meet.
 */
describe('parseClaudeTranscriptTail unresolved tool uses (#203)', () => {
  /** One `tool_use` block on its own assistant line. */
  function useLine(toolUseId: string, name: string, input: unknown, timestamp?: string): string {
    return (
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: toolUseId, name, input }]
        },
        ...(timestamp === undefined ? {} : { timestamp })
      }) + '\n'
    )
  }

  it('carries the tool, its id, its raw input and the line’s own timestamp', () => {
    const tail = useLine('toolu_r1', 'Bash', { command: 'pnpm test' }, '2026-09-05T10:00:00.000Z')
    expect(parseClaudeTranscriptTail(tail).unresolvedToolUses).toEqual([
      {
        toolUseId: 'toolu_r1',
        toolName: 'Bash',
        input: { command: 'pnpm test' },
        askedAt: '2026-09-05T10:00:00.000Z'
      }
    ])
  })

  it('carries no timestamp for a line that wrote none', () => {
    const tail = useLine('toolu_r1', 'Bash', { command: 'pnpm test' })
    expect('askedAt' in parseClaudeTranscriptTail(tail).unresolvedToolUses[0]!).toBe(false)
  })

  it('drops a call the matching tool_result has already answered', () => {
    const tail = useLine('toolu_r1', 'Bash', { command: 'pnpm test' }) + answerLine('toolu_r1')
    expect(parseClaudeTranscriptTail(tail).unresolvedToolUses).toEqual([])
  })

  it('drops a call the user escaped out of, which is resolved either way', () => {
    // Same reading pendingQuestion takes of is_error: a denial writes a result,
    // and a call with a result is not one anybody is still being asked about.
    const tail =
      useLine('toolu_r1', 'Bash', { command: 'rm -rf build' }) + answerLine('toolu_r1', true)
    expect(parseClaudeTranscriptTail(tail).unresolvedToolUses).toEqual([])
  })

  it('excludes AskUserQuestion, which travels as pendingQuestion and prompts nobody', () => {
    // The one tool that is a question rather than an act. Claude Code raises no
    // permission dialog for it, and the panel already has a card that repeats
    // the agent's own options — listing it here would let a permission card
    // invent Allow / Deny for a question that enumerated its own answers.
    const tail = askLine('toolu_ask', askInput('Which approach?'))
    expect(parseClaudeTranscriptTail(tail).unresolvedToolUses).toEqual([])
    expect(parseClaudeTranscriptTail(tail).pendingQuestion?.toolUseId).toBe('toolu_ask')
  })

  it('lists several open calls in ask order, so the latest is last', () => {
    const tail =
      useLine('toolu_r1', 'Read', { file_path: 'src/a.ts' }) +
      useLine('toolu_r2', 'Bash', { command: 'pnpm test' })
    expect(parseClaudeTranscriptTail(tail).unresolvedToolUses.map((use) => use.toolUseId)).toEqual([
      'toolu_r1',
      'toolu_r2'
    ])
  })

  it('leaves only the open one when an earlier call in the same tail was answered', () => {
    const tail =
      useLine('toolu_r1', 'Read', { file_path: 'src/a.ts' }) +
      answerLine('toolu_r1') +
      useLine('toolu_r2', 'Bash', { command: 'pnpm test' })
    expect(parseClaudeTranscriptTail(tail).unresolvedToolUses.map((use) => use.toolUseId)).toEqual([
      'toolu_r2'
    ])
  })

  it('ignores a call with no id, which nothing could ever mark resolved', () => {
    const tail =
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } }]
        }
      }) + '\n'
    expect(parseClaudeTranscriptTail(tail).unresolvedToolUses).toEqual([])
  })

  it.each([
    ['no input at all', undefined],
    ['a string input', 'pnpm test'],
    ['an array input', ['pnpm', 'test']]
  ])('ignores a call whose input is %s', (_label, input) => {
    const tail = useLine('toolu_r1', 'Bash', input)
    expect(() => parseClaudeTranscriptTail(tail)).not.toThrow()
    expect(parseClaudeTranscriptTail(tail).unresolvedToolUses).toEqual([])
  })

  it('ignores a call whose tool has no name', () => {
    const tail =
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_r1', input: { command: 'pnpm test' } }]
        }
      }) + '\n'
    expect(parseClaudeTranscriptTail(tail).unresolvedToolUses).toEqual([])
  })

  it('is empty for a tail that holds no tool call at all', () => {
    expect(parseClaudeTranscriptTail(parentTranscript).unresolvedToolUses).toEqual([])
    expect(parseClaudeTranscriptTail('').unresolvedToolUses).toEqual([])
  })

  it('resolves a call even when its result line arrives before it in the tail', () => {
    // Cannot happen in a real suffix read, and the rule must not depend on it:
    // matching is by id over the whole tail, exactly as it is for an ask.
    const tail = answerLine('toolu_r1') + useLine('toolu_r1', 'Bash', { command: 'pnpm test' })
    expect(parseClaudeTranscriptTail(tail).unresolvedToolUses).toEqual([])
  })
})

describe('parseClaudeTranscriptTail resume records (#338)', () => {
  /** The real fixture: one agent launched, ended, resumed and ended again. */
  const resumeLines = readFileSync(join(FIXTURES, 'resume-record.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
  const RESUMED_AGENT = 'c72a10f4b8e93d65a'
  const upTo = (end: number): string => resumeLines.slice(0, end + 1).join('\n') + '\n'

  /** A `SendMessage` result in the machine-readable shape, at a chosen time. */
  function resumeLine(payload: Record<string, unknown>, timestamp?: string): string {
    return (
      JSON.stringify({
        type: 'user',
        ...(timestamp === undefined ? {} : { timestamp }),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_s1' }] },
        toolUseResult: payload
      }) + '\n'
    )
  }

  it('reads the resumed agent off the real record, with its own timestamp', () => {
    expect(parseClaudeTranscriptTail(upTo(5)).resumedAgents).toEqual([
      {
        agentId: RESUMED_AGENT,
        timestamp: '2026-09-09T16:36:24.118Z',
        summary: 'Placeholder follow-up message.',
        endedSince: false
      }
    ])
  })

  it('reads it out of the tool_result text as readily as out of toolUseResult', () => {
    // Claude Code writes the same payload twice on one line — the model reads
    // the block, the harness reads the top-level copy — so either will do.
    const text =
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_s1',
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ success: true, resumedAgentId: 'agentx' })
                }
              ]
            }
          ]
        }
      }) + '\n'
    expect(parseClaudeTranscriptTail(text).resumedAgents.map((r) => r.agentId)).toEqual(['agentx'])
  })

  it('says the resume was outlived once an ending follows it in the window', () => {
    const parsed = parseClaudeTranscriptTail(upTo(6))
    expect(parsed.resumedAgents).toEqual([
      {
        agentId: RESUMED_AGENT,
        timestamp: '2026-09-09T16:36:24.118Z',
        summary: 'Placeholder follow-up message.',
        endedSince: true
      }
    ])
  })

  it('keeps only the latest resume of one agent, judged against the later ending', () => {
    // Resumed, ended, resumed again: the last record is the one that describes
    // the agent now, and no ending follows it.
    const tail =
      launchLine('agentx') +
      notificationLine('agentx', 'completed') +
      resumeLine({ success: true, resumedAgentId: 'agentx' }, 'first') +
      notificationLine('agentx', 'completed') +
      resumeLine({ success: true, resumedAgentId: 'agentx' }, 'second')
    expect(parseClaudeTranscriptTail(tail).resumedAgents).toEqual([
      { agentId: 'agentx', timestamp: 'second', endedSince: false }
    ])
  })

  it('names nobody for a result that carries no resumed agent', () => {
    const tail = resumeLine({ success: true, message: 'Message delivered' })
    expect(parseClaudeTranscriptTail(tail).resumedAgents).toEqual([])
  })

  it('names nobody for a resume the harness says did not happen', () => {
    const tail = resumeLine({ success: false, resumedAgentId: 'agentx' })
    expect(parseClaudeTranscriptTail(tail).resumedAgents).toEqual([])
  })

  it('names nobody for a payload a tool merely printed', () => {
    // The #64 rule one record further on: a Bash run that echoed a payload is
    // a quotation, and the key it quotes sits nested inside its output rather
    // than at the top of a result the harness returned.
    const printed = JSON.stringify({ success: true, resumedAgentId: 'agentx' })
    const tail =
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_b1', content: `saw ${printed}` }]
        },
        toolUseResult: { stdout: printed, stderr: '', interrupted: false, isImage: false }
      }) + '\n'
    expect(parseClaudeTranscriptTail(tail).resumedAgents).toEqual([])
  })

  it('names nobody for prose that only mentions the key', () => {
    const tail =
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'The result carries resumedAgentId, so it resumed.' }]
        }
      }) + '\n'
    expect(parseClaudeTranscriptTail(tail).resumedAgents).toEqual([])
  })

  it('hands over the launch identity of an agent that ended in the same window', () => {
    // What a redraw needs, for every status rather than only for `failed`:
    // a resume record can follow any of the three.
    const parsed = parseClaudeTranscriptTail(upTo(2))
    expect(parsed.endedLaunches).toEqual([
      {
        agentId: RESUMED_AGENT,
        description: 'Placeholder resumed agent task',
        resolvedModel: 'claude-fable-5'
      }
    ])
    // ...while #179's narrower door stays exactly as narrow: this ending said
    // `completed`, which no inference may reopen.
    expect(parsed.failedAgents).toEqual([])
    expect(parsed.terminalAgentIds).toEqual([RESUMED_AGENT])
  })

  it('hands over nothing for an agent whose launch record left the window', () => {
    expect(
      parseClaudeTranscriptTail(notificationLine('agentx', 'completed')).endedLaunches
    ).toEqual([])
  })

  it('hands over nothing for an agent that has not ended', () => {
    expect(parseClaudeTranscriptTail(launchLine('agentx')).endedLaunches).toEqual([])
  })
})
