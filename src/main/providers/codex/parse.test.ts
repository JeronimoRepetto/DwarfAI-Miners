import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  extractCodexFeed,
  firstCodexUserMessage,
  isCodexArtifactStorageCwd,
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
      cwd: 'C:\\Users\\j\\Desktop\\Sample-Project'
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

  /**
   * Issue #34: `turn_aborted` is the structured record Codex writes when the
   * user interrupts a turn (real observed payload: {"type":"turn_aborted",
   * "turn_id":"…","reason":"interrupted",…}). Without it an aborted turn keeps
   * its unmatched task_started and the dwarf mines forever after an Esc.
   */
  describe('turn_aborted (issue #34)', () => {
    function event(payload: Record<string, unknown>): string {
      return JSON.stringify({ type: 'event_msg', payload }) + '\n'
    }

    it('closes the open turn on a matching turn_aborted (user interrupt = turn over)', () => {
      const tail =
        event({ type: 'task_started', turn_id: 'turn-3' }) +
        event({ type: 'turn_aborted', turn_id: 'turn-3', reason: 'interrupted' })
      expect(parseCodexRolloutTail(tail).busy).toBe(false)
    })

    it('keeps the turn open when turn_aborted names a different turn', () => {
      const tail =
        event({ type: 'task_started', turn_id: 'turn-2' }) +
        event({ type: 'turn_aborted', turn_id: 'turn-1', reason: 'interrupted' })
      expect(parseCodexRolloutTail(tail).busy).toBe(true)
    })

    it('closes any open turn when turn_aborted carries no turn id', () => {
      const tail =
        event({ type: 'task_started', turn_id: 'turn-2' }) + event({ type: 'turn_aborted' })
      expect(parseCodexRolloutTail(tail).busy).toBe(false)
    })
  })

  /**
   * Issue #219: `busy: false` is not a record that a turn ENDED. It is also
   * what a rollout with no turn events at all looks like — a thread whose
   * session_meta is on disk but whose first `task_started` has not been
   * written yet. `completedTurn` is the positive record: Codex's own
   * `task_complete`, the event that carries `last_agent_message`, with no
   * later turn reopened. The provider retires a finished sub-agent on it, so
   * "no evidence yet" must never read as "finished".
   */
  describe('completedTurn (issue #219)', () => {
    function event(payload: Record<string, unknown>): string {
      return JSON.stringify({ type: 'event_msg', payload }) + '\n'
    }

    it('records a completed turn when task_complete closes the last task_started', () => {
      expect(parseCodexRolloutTail(rollout).completedTurn).toBe(true)
    })

    it('records no completed turn while a turn is still open', () => {
      expect(parseCodexRolloutTail(busyRollout).completedTurn).toBe(false)
    })

    it('records no completed turn for a rollout that carries no turn events at all', () => {
      // The freshly spawned thread: identity on disk, nothing started yet.
      // `busy` is false here too, which is exactly why it cannot be the signal.
      const tail = parseCodexRolloutTail(rolloutLines[0]! + '\n')
      expect(tail.busy).toBe(false)
      expect(tail.completedTurn).toBe(false)
    })

    it('records no completed turn once a later task_started reopens one', () => {
      const tail =
        event({ type: 'task_started', turn_id: 'turn-1' }) +
        event({ type: 'task_complete', turn_id: 'turn-1' }) +
        event({ type: 'task_started', turn_id: 'turn-2' })
      expect(parseCodexRolloutTail(tail).completedTurn).toBe(false)
    })

    /**
     * A `turn_aborted` ends the turn (issue #34) but is deliberately NOT a
     * completion: it is a human pressing Esc, and what happens next is the
     * human's, not the agent's. Retiring on it would be this app deciding an
     * interrupted thread is finished, so an aborted thread keeps the window it
     * has today.
     */
    it('does not count a user-interrupted turn as completed, though the turn is closed', () => {
      const tail =
        event({ type: 'task_started', turn_id: 'turn-4' }) +
        event({ type: 'turn_aborted', turn_id: 'turn-4', reason: 'interrupted' })
      const info = parseCodexRolloutTail(tail)
      expect(info.busy).toBe(false)
      expect(info.completedTurn).toBe(false)
    })
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

/**
 * Issue #166: a "Codex Desktop"/`vscode`-sourced session asked about a real
 * repository the user never opened as its bound workspace wrote its OWN
 * artifact-storage folder as session_meta.cwd — `.../Documents/Codex/<date>/
 * <slug>` — verified live on the maintainer's machine (2026-09-03): the
 * exact same window produced one sibling rollout whose cwd was the real
 * repository, and one whose cwd was this shape. Codex itself never recorded
 * any other cwd for the second session, so laundering this value as a
 * project would invent the phantom project the issue reports. Windows-
 * verified only; see docs/codex-v2-format.md for the platform gap.
 */
describe('isCodexArtifactStorageCwd', () => {
  it('recognizes the Documents/Codex/<date>/<slug> storage shape', () => {
    expect(
      isCodexArtifactStorageCwd(
        'C:\\Users\\j\\Documents\\Codex\\2026-09-03\\este-proyecto-usa-electron'
      )
    ).toBe(true)
  })

  it('recognizes the shape with forward slashes too', () => {
    expect(isCodexArtifactStorageCwd('/home/j/Documents/Codex/2026-09-03/some-slug')).toBe(true)
  })

  it('does not match a real project path', () => {
    expect(isCodexArtifactStorageCwd('C:\\Users\\j\\Desktop\\Sample-Project')).toBe(false)
  })

  it('does not match a real project that happens to be named Codex', () => {
    expect(isCodexArtifactStorageCwd('C:\\Users\\j\\Desktop\\Codex\\2026-09-03\\notes')).toBe(false)
  })

  it('does not match without a well-formed date segment', () => {
    expect(isCodexArtifactStorageCwd('C:\\Users\\j\\Documents\\Codex\\not-a-date\\some-slug')).toBe(
      false
    )
  })

  it('does not match a too-short path', () => {
    expect(isCodexArtifactStorageCwd('Documents\\Codex\\2026-09-03')).toBe(false)
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

/**
 * One line per tool call, interleaved with the speech in call order (#240) —
 * off the same shared table `domain/permissionSummary.ts` reads for Claude
 * (`toolActivityLine`), so a call cannot read one way on that provider and
 * another on this one. Codex names two of the four verbs from real rollouts:
 * `shell_command` (a `function_call` whose `arguments` is a JSON-encoded
 * string) and `apply_patch` (a `custom_tool_call` whose `input` is the patch
 * envelope) — see docs/provider-formats.md §2.2.
 */
describe('extractCodexFeed activity lines (#240)', () => {
  function record(timestamp: string, type: string, payload: Record<string, unknown>): string {
    return JSON.stringify({ timestamp, type, payload }) + '\n'
  }

  const assistantLine = (text: string, timestamp: string): string =>
    record(timestamp, 'response_item', {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }]
    })

  function shellCall(command: string, timestamp = '2026-09-07T10:00:00.000Z'): string {
    return record(timestamp, 'response_item', {
      type: 'function_call',
      name: 'shell_command',
      call_id: 'call_1',
      arguments: JSON.stringify({
        command,
        workdir: 'C:\\Users\\j\\Desktop\\Sample-Project',
        timeout_ms: 20000
      })
    })
  }

  function applyPatchCall(input: string, timestamp = '2026-09-07T10:00:01.000Z'): string {
    return record(timestamp, 'response_item', {
      type: 'custom_tool_call',
      name: 'apply_patch',
      call_id: 'call_2',
      status: 'completed',
      input
    })
  }

  it('publishes a shell_command call as a run line, reading the command out of its stringified arguments', () => {
    expect(extractCodexFeed(shellCall('pnpm test'), 20)).toEqual([
      {
        role: 'assistant',
        text: 'Ran pnpm test',
        timestamp: '2026-09-07T10:00:00.000Z',
        activity: { kind: 'run', target: 'pnpm test' }
      }
    ])
  })

  it('publishes an apply_patch call as an edit line, reading the first file out of the patch envelope', () => {
    const tail = applyPatchCall(
      '*** Begin Patch\n*** Update File: src/parse.ts\n@@\n-old\n+new\n*** End Patch'
    )
    expect(extractCodexFeed(tail, 20)).toEqual([
      {
        role: 'assistant',
        text: 'Edited src/parse.ts',
        timestamp: '2026-09-07T10:00:01.000Z',
        activity: { kind: 'edit', target: 'src/parse.ts' }
      }
    ])
  })

  it('takes the first file of a multi-file patch, rather than misreporting the rest', () => {
    const tail = applyPatchCall(
      '*** Begin Patch\n*** Add File: docs/a.md\n+a\n*** Update File: docs/b.md\n@@\n-x\n+y\n*** End Patch'
    )
    expect(extractCodexFeed(tail, 20)[0]!.text).toBe('Edited docs/a.md')
  })

  it('interleaves a tool call between the assistant replies either side of it', () => {
    const tail =
      assistantLine('Checking.', '2026-09-07T10:00:00.000Z') +
      shellCall('pnpm test', '2026-09-07T10:00:01.000Z') +
      assistantLine('Passed.', '2026-09-07T10:00:02.000Z')
    expect(extractCodexFeed(tail, 20).map((m) => [m.role, m.text])).toEqual([
      ['assistant', 'Checking.'],
      ['assistant', 'Ran pnpm test'],
      ['assistant', 'Passed.']
    ])
  })

  it('publishes nothing for exec, whose input is a JavaScript program rather than a command line', () => {
    const tail = record('2026-09-07T10:00:00.000Z', 'response_item', {
      type: 'custom_tool_call',
      name: 'exec',
      call_id: 'call_3',
      input: 'console.log(1)'
    })
    expect(extractCodexFeed(tail, 20)).toEqual([])
  })

  it('redacts a secret carried in a shell command, same as it would in spoken text', () => {
    const key = ['sk', 'a'.repeat(48)].join('-')
    const tail = shellCall(`curl -H "auth: ${key}" x.test`)
    expect(extractCodexFeed(tail, 20)[0]!.text).toBe('Ran curl -H "auth: [redacted]" x.test')
  })

  it('publishes nothing for a shell_command call whose arguments are not valid JSON', () => {
    const tail = record('2026-09-07T10:00:00.000Z', 'response_item', {
      type: 'function_call',
      name: 'shell_command',
      call_id: 'call_1',
      arguments: 'not json'
    })
    expect(extractCodexFeed(tail, 20)).toEqual([])
  })

  it('publishes nothing for an apply_patch call whose input names no file action', () => {
    expect(extractCodexFeed(applyPatchCall('*** Begin Patch\n*** End Patch'), 20)).toEqual([])
  })

  it('reads the shared rollout fixture unchanged: it carries no tool call today', () => {
    expect(extractCodexFeed(rollout, 20).map((m) => [m.role, m.text])).toEqual([
      ['user', 'Placeholder plain message.'],
      ['assistant', 'Placeholder text block.']
    ])
  })

  it('keeps both replies when twenty tool calls have run since the last of them (#359)', () => {
    // `limit` is a count of things SAID here too — one rule for all three
    // extractors, so a long tool loop cannot empty this panel either.
    const calls = Array.from({ length: 20 }, (_, index) =>
      shellCall(
        `pnpm test --shard ${index}`,
        `2026-09-07T10:01:${String(index).padStart(2, '0')}.000Z`
      )
    ).join('')
    const tail =
      assistantLine('Checking.', '2026-09-07T10:00:00.000Z') +
      assistantLine('Working on it.', '2026-09-07T10:00:02.000Z') +
      calls

    const feed = extractCodexFeed(tail, 12)
    expect(feed.filter((m) => m.activity === undefined).map((m) => m.text)).toEqual([
      'Checking.',
      'Working on it.'
    ])
    expect(feed.filter((m) => m.activity !== undefined)).toHaveLength(20)
  })
})

/*
 * The launch receipt's half of a rollout (#191): the FIRST thing a person said
 * in this thread, which is what tells the panel which dwarf its own detached
 * launch became.
 */
describe('firstCodexUserMessage', () => {
  function record(type: string, payload: Record<string, unknown>): string {
    return JSON.stringify({ timestamp: '2026-09-04T10:00:00.000Z', type, payload })
  }

  const userEvent = (message: string): string =>
    record('event_msg', { type: 'user_message', message })

  const userItem = (text: string): string =>
    record('response_item', {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }]
    })

  it('reads the human turn a rollout records as its own event', () => {
    expect(firstCodexUserMessage(rollout)).toBe('Placeholder plain message.')
  })

  it('answers the first human turn, never a later one', () => {
    expect(firstCodexUserMessage([userEvent('dig'), userEvent('shore')].join('\n'))).toBe('dig')
  })

  /*
   * A Codex child thread is a FORK and carries no `event_msg/user_message` at
   * all (#218) — its human prompt survives only as a response_item. That shape
   * is the fallback rather than a second first choice: where both exist, the
   * event is Codex stating outright that a person said this.
   */
  it('falls back to the request item for a rollout that records no user event', () => {
    expect(firstCodexUserMessage(userItem('dig the east gallery'))).toBe('dig the east gallery')
  })

  it('prefers the human event over an item that precedes it', () => {
    expect(firstCodexUserMessage([userItem('<context>'), userEvent('dig')].join('\n'))).toBe('dig')
  })

  it('never reads the agent’s own words as a human turn', () => {
    const assistant = record('response_item', {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'digging' }]
    })

    expect(firstCodexUserMessage(assistant)).toBeUndefined()
  })

  /*
   * A rollout whose first record is present but whose prompt is not yet
   * written answers nothing, and nothing is not a mismatch: the caller asks
   * again rather than concluding this thread is somebody else's.
   */
  it('answers nothing for a rollout that has only opened', () => {
    expect(firstCodexUserMessage(rolloutLines[0]!)).toBeUndefined()
  })
})

/*
 * The `codex exec` shape (#458), measured 2026-09-17 on codex-cli 0.153.4 and
 * recorded in docs/codex-v2-format.md §14. Five real exec rollouts carried ZERO
 * `event_msg/user_message`; the person's prompts survive only as `response_item`
 * user items, and beside them sit two things that are not the person's words:
 * `developer` items (skills, permissions, a model switch), and `user`-role
 * items of injected context — `<recommended_plugins>`, the AGENTS.md text,
 * `<environment_context>` — whose metadata names no `user.*` content kind.
 */
const execRollout = readFileSync(join(FIXTURES, 'rollout-exec.jsonl'), 'utf8')

/** Every prompt the person typed into the exec fixture, in order, with the replies between. */
const EXEC_CONVERSATION: [string, string][] = [
  ['user', 'Reply with exactly the word ALPHA and nothing else.\n'],
  ['assistant', 'ALPHA'],
  ['user', 'What word did you just say? Reply with that word plus the word BETA.'],
  ['assistant', 'ALPHA BETA'],
  ['user', 'Which word did I ask you to remember?'],
  ['assistant', 'ALPHA, then BETA.']
]

/** One rollout record; `kinds` is the `content_item_kinds` passthrough Codex writes on a message item. */
function execRecord(
  type: string,
  payload: Record<string, unknown>,
  timestamp = '2026-09-17T12:05:24.000Z'
): string {
  return JSON.stringify({ timestamp, type, payload })
}

function messageItem(role: string, texts: string[], kinds?: string[]): string {
  return execRecord('response_item', {
    type: 'message',
    id: `msg_${role}`,
    role,
    content: texts.map((text) => ({ type: 'input_text', text })),
    ...(kinds === undefined
      ? {}
      : {
          internal_chat_message_metadata_passthrough: { turn_id: 't1', content_item_kinds: kinds }
        })
  })
}

const assistantItem = (text: string): string =>
  execRecord('response_item', {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text }]
  })

const userEvent = (message: string): string =>
  execRecord('event_msg', { type: 'user_message', message })

/**
 * The opening tags measured on user-role items that carry NO metadata (builds
 * 0.145 through 0.149 on this machine) — the fallback rule's whole vocabulary.
 */
const INJECTED_TAGS = [
  '<recommended_plugins>',
  '<environment_context>',
  '<realtime_delegation>',
  '<codex_delegation>',
  '<user_shell_command>',
  '<turn_aborted>'
]

describe('extractCodexFeed on a codex exec rollout (#458)', () => {
  it('shows the person’s prompts and the replies, and none of the injected context', () => {
    expect(extractCodexFeed(execRollout, 20).map((m) => [m.role, m.text])).toEqual(
      EXEC_CONVERSATION
    )
  })

  /*
   * Refused by ROLE, before either injected-context rule is reached: 470 of
   * the corpus's developer items carry no metadata and open with a plain
   * line, so neither rule would catch them — the role is the only thing that
   * says these are not a person's words.
   */
  it('never reads a developer item as anybody’s words', () => {
    const tail = [
      messageItem('developer', ['You are `/root`, the primary agent in a team of agents.']),
      messageItem(
        'developer',
        ['<skills_instructions>\nPlaceholder.'],
        ['host_skills.instructions']
      ),
      assistantItem('Ready.')
    ].join('\n')
    expect(extractCodexFeed(tail, 20).map((m) => [m.role, m.text])).toEqual([
      ['assistant', 'Ready.']
    ])
  })

  /*
   * The shape the committed TUI fixture has (a `user_message` event) and the
   * shape an older TUI rollout has (the event AND the item for the same words)
   * must both read as one row per human message: the event wins, exactly as
   * firstCodexUserMessage already rules, and the item is only ever read for a
   * window that carries no event at all.
   */
  it('keeps exactly one row per human message where a rollout carries both the event and the item', () => {
    const tail = [
      messageItem('user', ['dig the east gallery'], ['user.text']),
      userEvent('dig the east gallery'),
      assistantItem('Digging.'),
      messageItem('user', ['now shore it'], ['user.text']),
      userEvent('now shore it'),
      assistantItem('Shored.')
    ].join('\n')
    expect(extractCodexFeed(tail, 20).map((m) => [m.role, m.text])).toEqual([
      ['user', 'dig the east gallery'],
      ['assistant', 'Digging.'],
      ['user', 'now shore it'],
      ['assistant', 'Shored.']
    ])
  })

  it('still reads the shared TUI fixture as one user row and one reply', () => {
    expect(extractCodexFeed(rollout, 20).map((m) => [m.role, m.text])).toEqual([
      ['user', 'Placeholder plain message.'],
      ['assistant', 'Placeholder text block.']
    ])
  })

  /*
   * The TUI's own turn-one context item opens with a PLAIN line — 47 items on
   * 0.150.1 through 0.153.4 read `# AGENTS.md instructions for <cwd>` first —
   * so a tag alone cannot tell it from a person; the metadata can, and it is
   * the rule wherever Codex wrote it.
   */
  it('skips a user item whose metadata names no user.* kind, even when its first line is plain', () => {
    const tail = [
      messageItem(
        'user',
        [
          '# AGENTS.md instructions for C:\\Users\\j\\Desktop\\Sample-Project',
          '<environment_context>\n</environment_context>'
        ],
        ['agents_md.instructions', 'environments.environment_context']
      ),
      messageItem('user', ['dig'], ['user.text']),
      assistantItem('Digging.')
    ].join('\n')
    expect(extractCodexFeed(tail, 20).map((m) => [m.role, m.text])).toEqual([
      ['user', 'dig'],
      ['assistant', 'Digging.']
    ])
  })

  it('keeps a user item whose metadata names an image beside its text', () => {
    const tail = messageItem(
      'user',
      ['look at this', 'and this'],
      ['user.text', 'user.image', 'user.text']
    )
    expect(extractCodexFeed(tail, 20).map((m) => [m.role, m.text])).toEqual([
      ['user', 'look at this\nand this']
    ])
  })

  it.each(INJECTED_TAGS)('skips an item without metadata whose first line opens with %s', (tag) => {
    const tail = [messageItem('user', [`${tag}\nPlaceholder body.`]), assistantItem('Ok.')].join(
      '\n'
    )
    expect(extractCodexFeed(tail, 20).map((m) => [m.role, m.text])).toEqual([['assistant', 'Ok.']])
  })

  /* A fork's prompt (#218): no event, no metadata, a plain first line — a person. */
  it('keeps an item without metadata whose first line is plain', () => {
    expect(extractCodexFeed(messageItem('user', ['dig the east gallery']), 20)).toEqual([
      { role: 'user', text: 'dig the east gallery', timestamp: '2026-09-17T12:05:24.000Z' }
    ])
  })
})

describe('firstCodexUserMessage on a codex exec rollout (#458)', () => {
  it('answers the person’s prompt, not the plugin list that precedes it', () => {
    expect(firstCodexUserMessage(execRollout)).toBe(EXEC_CONVERSATION[0]![1])
  })

  it('skips a metadata-bearing context item and a developer item alike', () => {
    const head = [
      messageItem(
        'developer',
        ['<skills_instructions>\nPlaceholder.'],
        ['host_skills.instructions']
      ),
      messageItem('user', ['# AGENTS.md instructions'], ['agents_md.instructions']),
      messageItem('user', ['dig'], ['user.text'])
    ].join('\n')
    expect(firstCodexUserMessage(head)).toBe('dig')
  })

  it.each(INJECTED_TAGS)('skips an item without metadata whose first line opens with %s', (tag) => {
    const head = [
      messageItem('user', [`${tag}\nPlaceholder body.`]),
      messageItem('user', ['dig'])
    ].join('\n')
    expect(firstCodexUserMessage(head)).toBe('dig')
  })
})
