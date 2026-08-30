import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
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
    expect(parseClaudeSessionEntry(sessionEntryJson)).toEqual({
      pid: 32896,
      sessionId: '5efdffdd-53df-4509-b30d-c9e56552a22e',
      cwd: 'C:\\Users\\j\\Desktop\\Sample-Project',
      status: 'busy',
      procStart: '134324755721362761',
      kind: 'interactive',
      name: 'sample-project-70',
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
