import { describe, expect, it } from 'vitest'
import {
  HELD_CONVERSATION_LIMIT,
  HELD_MESSAGE_MAX_CHARS,
  defaultDwarf,
  defaultMine,
  type FeedMessage,
  type Mine
} from '../domain/types'
import { HeldCrew, type HeldSessionSubagentSignal } from './heldCrew'
import {
  askToWireQuestion,
  heldMessageText,
  heldTelemetryToWire,
  parseAskUserQuestion,
  resolveAnswers,
  retainHeldMessage,
  stampHeldConversation,
  stampHeldCrew,
  stampHeldQuestions,
  stampHeldRank,
  stampHeldTelemetry,
  type HeldAsk,
  type HeldSessionTelemetryUpdate,
  type HeldTelemetryState
} from './heldSession'

const ASKED_AT = '2026-09-02T07:00:00.000Z'

/** One well-formed AskUserQuestion input, as the SDK hands it to canUseTool. */
function askInput(): Record<string, unknown> {
  return {
    questions: [
      {
        question: 'Which colour?',
        header: 'Colour',
        multiSelect: false,
        options: [
          { label: 'Green', description: 'The calm one', preview: '#0f0' },
          { label: 'Red', description: 'The loud one' }
        ]
      }
    ]
  }
}

describe('parseAskUserQuestion', () => {
  it('reads the question, its header, its flag and every option', () => {
    expect(parseAskUserQuestion('toolu_01', askInput())).toEqual({
      toolUseId: 'toolu_01',
      questions: [
        {
          question: 'Which colour?',
          header: 'Colour',
          multiSelect: false,
          options: [
            { label: 'Green', description: 'The calm one' },
            { label: 'Red', description: 'The loud one' }
          ]
        }
      ]
    })
  })

  it('keeps every question of a multi-question ask, in the order it was asked', () => {
    const ask = parseAskUserQuestion('toolu_02', {
      questions: [
        { question: 'First?', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'Second?', multiSelect: true, options: [{ label: 'C' }, { label: 'D' }] }
      ]
    })

    expect(ask?.questions.map((entry) => entry.question)).toEqual(['First?', 'Second?'])
    expect(ask?.questions[1]?.multiSelect).toBe(true)
  })

  it("drops each option's preview, which is never display text the panel needs", () => {
    const ask = parseAskUserQuestion('toolu_03', askInput())
    expect(ask?.questions[0]?.options[0]).toEqual({ label: 'Green', description: 'The calm one' })
  })

  it('refuses an input that is not an object, or carries no questions list', () => {
    expect(parseAskUserQuestion('toolu_04', null as unknown as Record<string, unknown>)).toBeNull()
    expect(parseAskUserQuestion('toolu_04', {})).toBeNull()
    expect(parseAskUserQuestion('toolu_04', { questions: 'Which colour?' })).toBeNull()
    expect(parseAskUserQuestion('toolu_04', { questions: [] })).toBeNull()
  })

  it('refuses the whole ask when a question is not the shape the schema promises', () => {
    // A non-array `options` means this block is not an AskUserQuestion at all,
    // so nothing is salvaged from it — the same split parse.ts drew for the
    // transcript-derived ask (#94 phase 1).
    expect(
      parseAskUserQuestion('toolu_05', {
        questions: [{ question: 'Which colour?', multiSelect: false, options: 'Green' }]
      })
    ).toBeNull()
    expect(
      parseAskUserQuestion('toolu_05', { questions: [{ multiSelect: false, options: [] }] })
    ).toBeNull()
  })

  it('drops one unusable option on its own, because the question is the load-bearing half', () => {
    const ask = parseAskUserQuestion('toolu_06', {
      questions: [
        { question: 'Which colour?', multiSelect: false, options: [{ label: 'Green' }, {}, 7] }
      ]
    })
    expect(ask?.questions[0]?.options).toEqual([{ label: 'Green' }])
  })

  it('refuses an ask no option could be read from: nothing could answer it', () => {
    expect(
      parseAskUserQuestion('toolu_07', {
        questions: [{ question: 'Which colour?', multiSelect: false, options: [{}, 7] }]
      })
    ).toBeNull()
  })

  it('treats a missing or non-boolean multiSelect as single-select', () => {
    const ask = parseAskUserQuestion('toolu_08', {
      questions: [{ question: 'Which colour?', options: [{ label: 'Green' }, { label: 'Red' }] }]
    })
    expect(ask?.questions[0]?.multiSelect).toBe(false)
  })
})

describe('askToWireQuestion', () => {
  it('carries the first question only — the wire shape is singular', () => {
    const ask = parseAskUserQuestion('toolu_10', {
      questions: [
        { question: 'First?', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'Second?', multiSelect: false, options: [{ label: 'C' }, { label: 'D' }] }
      ]
    })!

    expect(askToWireQuestion(ask, ASKED_AT)).toEqual({
      toolUseId: 'toolu_10',
      question: 'First?',
      multiSelect: false,
      options: [{ label: 'A' }, { label: 'B' }],
      askedAt: ASKED_AT
    })
  })

  it('redacts the question, the header, every label and every description', () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwx'
    const ask = parseAskUserQuestion('toolu_11', {
      questions: [
        {
          question: `Use ${secret}?`,
          header: `Key ${secret}`,
          multiSelect: false,
          options: [
            { label: `Yes ${secret}`, description: `Send ${secret}` },
            { label: 'No', description: 'Stop' }
          ]
        }
      ]
    })!

    const wire = askToWireQuestion(ask, ASKED_AT)
    expect(wire.question).toBe('Use [redacted]?')
    expect(wire.header).toBe('Key [redacted]')
    expect(wire.options[0]).toEqual({ label: 'Yes [redacted]', description: 'Send [redacted]' })
    expect(wire.options[1]).toEqual({ label: 'No', description: 'Stop' })
  })

  it('omits a header and a description the ask never carried', () => {
    const ask = parseAskUserQuestion('toolu_12', {
      questions: [{ question: 'Which?', multiSelect: false, options: [{ label: 'A' }] }]
    })!
    const wire = askToWireQuestion(ask, ASKED_AT)
    expect('header' in wire).toBe(false)
    expect('description' in wire.options[0]!).toBe(false)
  })
})

describe('resolveAnswers', () => {
  const secret = 'sk-abcdefghijklmnopqrstuvwx'
  const redacting = (): HeldAsk =>
    parseAskUserQuestion('toolu_20', {
      questions: [
        {
          question: `Use ${secret}?`,
          multiSelect: false,
          options: [{ label: `Yes ${secret}` }, { label: 'No' }]
        }
      ]
    })!

  it('answers with the option label the agent offered, keyed by the question text', () => {
    const ask = parseAskUserQuestion('toolu_21', askInput())!
    expect(resolveAnswers(ask, { 'Which colour?': 'Green' })).toEqual({
      ok: true,
      answers: { 'Which colour?': 'Green' }
    })
  })

  it('maps a redacted question and label back to the strings the agent actually wrote', () => {
    // The panel only ever saw the redacted spellings, so those are what come
    // back — and the agent's own tool would not recognise them.
    const resolved = resolveAnswers(redacting(), { 'Use [redacted]?': 'Yes [redacted]' })
    expect(resolved).toEqual({ ok: true, answers: { [`Use ${secret}?`]: `Yes ${secret}` } })
  })

  it('refuses an empty record: nothing was answered', () => {
    const ask = parseAskUserQuestion('toolu_22', askInput())!
    expect(resolveAnswers(ask, {}).ok).toBe(false)
  })

  it('refuses a question text the ask never carried', () => {
    const ask = parseAskUserQuestion('toolu_23', askInput())!
    const resolved = resolveAnswers(ask, { 'Which shape?': 'Green' })
    expect(resolved.ok).toBe(false)
    expect(resolved.ok ? '' : resolved.reason).toContain('question')
  })

  it('refuses a value that is not one of the labels the agent offered', () => {
    const ask = parseAskUserQuestion('toolu_24', askInput())!
    const resolved = resolveAnswers(ask, { 'Which colour?': 'Blue' })
    expect(resolved.ok).toBe(false)
    expect(resolved.ok ? '' : resolved.reason).toContain('option')
  })

  it('refuses two labels joined into one value, even where the ask was multi-select', () => {
    // Answering more than one option is unproven against a live agent, so the
    // engine sends exactly one label rather than a separator it guessed.
    const ask = parseAskUserQuestion('toolu_25', {
      questions: [
        { question: 'Which?', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }
      ]
    })!
    expect(resolveAnswers(ask, { 'Which?': 'A, B' }).ok).toBe(false)
  })

  it('refuses more answers than the ask has questions', () => {
    const ask = parseAskUserQuestion('toolu_26', askInput())!
    expect(resolveAnswers(ask, { 'Which colour?': 'Green', 'Which shape?': 'Round' }).ok).toBe(
      false
    )
  })

  it('refuses an answer to two questions that redact to the same text', () => {
    // Redaction is lossy on purpose, so it can collapse two distinct questions
    // into one string. Guessing which of them was answered is how the agent
    // would come to read an answer nobody gave.
    const ask = parseAskUserQuestion('toolu_28', {
      questions: [
        { question: `Use ${secret}?`, multiSelect: false, options: [{ label: 'A' }] },
        {
          question: 'Use sk-zyxwvutsrqponmlkjihgfe?',
          multiSelect: false,
          options: [{ label: 'B' }]
        }
      ]
    })!
    const resolved = resolveAnswers(ask, { 'Use [redacted]?': 'A' })
    expect(resolved.ok).toBe(false)
    expect(resolved.ok ? '' : resolved.reason).toContain('same')
  })

  it('accepts a partial record, because the wire only ever showed the first question', () => {
    const ask = parseAskUserQuestion('toolu_27', {
      questions: [
        { question: 'First?', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'Second?', multiSelect: false, options: [{ label: 'C' }, { label: 'D' }] }
      ]
    })!
    expect(resolveAnswers(ask, { 'First?': 'A' })).toEqual({ ok: true, answers: { 'First?': 'A' } })
  })
})

describe('stampHeldQuestions', () => {
  const question = {
    toolUseId: 'toolu_30',
    question: 'Which colour?',
    multiSelect: false,
    options: [{ label: 'Green' }]
  }

  function board(): Mine[] {
    return [
      {
        ...defaultMine(),
        id: 'mine-1',
        dwarfs: [
          { ...defaultDwarf(), id: 'foreman-1', role: 'foreman', sessionId: 'sess-1' },
          { ...defaultDwarf(), id: 'worker-1', role: 'worker', sessionId: 'sess-1' }
        ]
      }
    ]
  }

  it("stamps the held session's live question onto its foreman", () => {
    const stamped = stampHeldQuestions(board(), () => ({ held: true, question }))
    expect(stamped[0]!.dwarfs[0]!.pendingQuestion).toEqual(question)
  })

  it('supersedes a tail-derived question, and clears it when nothing is open', () => {
    const mines = board()
    mines[0]!.dwarfs[0] = {
      ...mines[0]!.dwarfs[0]!,
      pendingQuestion: { ...question, toolUseId: 'toolu_old' }
    }

    const stamped = stampHeldQuestions(mines, () => ({ held: true }))
    expect(stamped[0]!.dwarfs[0]!.pendingQuestion).toBeUndefined()
    expect('pendingQuestion' in stamped[0]!.dwarfs[0]!).toBe(false)
  })

  it('leaves a session this panel does not hold exactly as the provider reported it', () => {
    const mines = board()
    const tail = { ...question, toolUseId: 'toolu_tail' }
    mines[0]!.dwarfs[0] = { ...mines[0]!.dwarfs[0]!, pendingQuestion: tail }

    const stamped = stampHeldQuestions(mines, () => ({ held: false }))
    expect(stamped[0]!.dwarfs[0]!.pendingQuestion).toEqual(tail)
  })

  it("never stamps a worker, which shares its foreman's session id", () => {
    const stamped = stampHeldQuestions(board(), () => ({ held: true, question }))
    expect(stamped[0]!.dwarfs[1]!.pendingQuestion).toBeUndefined()
  })
})

/*
 * Issue #96. `heldTelemetryToWire` is the same kind of narrowing
 * `askToWireQuestion` does for an ask: it takes what the registry
 * accumulated off the SDK's own `init`/`result` messages and turns it into
 * exactly the wire shape `Dwarf` admits — validating `mcp_servers[].status`
 * against the closed enum along the way, since the CLI's own message types
 * that field as a plain string (see MCP_CONNECTION_STATUSES in contracts.ts).
 */
describe('heldTelemetryToWire', () => {
  it('carries model, effort and totalCostUsd straight through when present', () => {
    const telemetry: HeldSessionTelemetryUpdate = {
      model: 'claude-haiku-4-5',
      effort: 'low',
      totalCostUsd: 0.0697689
    }
    expect(heldTelemetryToWire(telemetry)).toEqual({
      model: 'claude-haiku-4-5',
      effort: 'low',
      totalCostUsd: 0.0697689
    })
  })

  it('omits every field the telemetry never reported', () => {
    expect(heldTelemetryToWire({})).toEqual({})
  })

  it('keeps every MCP server whose status the closed enum recognises', () => {
    const telemetry: HeldSessionTelemetryUpdate = {
      mcpServers: [
        { name: 'codegraph', status: 'connected' },
        { name: 'claude-ai-proxy', status: 'needs-auth' }
      ]
    }
    expect(heldTelemetryToWire(telemetry).mcpServers).toEqual([
      { name: 'codegraph', status: 'connected' },
      { name: 'claude-ai-proxy', status: 'needs-auth' }
    ])
  })

  it('drops a server whose status this build does not recognise, keeping the rest', () => {
    // The CLI's own `init` message types `status` as a plain string, so a
    // future value outside the five the SDK's typed surface promises must
    // read as "not this enum" rather than being passed on as a guess — the
    // same discipline isMineTier/isDwarfProvider already hold.
    const telemetry: HeldSessionTelemetryUpdate = {
      mcpServers: [
        { name: 'codegraph', status: 'connected' },
        { name: 'future-server', status: 'reconnecting' }
      ]
    }
    expect(heldTelemetryToWire(telemetry).mcpServers).toEqual([
      { name: 'codegraph', status: 'connected' }
    ])
  })

  it('never puts usage on the wire: it is registry-only for this slice', () => {
    // Issue #96 draws the minimal wire vocabulary deliberately narrow — usage
    // (token-level detail) stays on the held session record, never stamped to
    // the panel, so 'usage' must not leak through even though it travels
    // alongside totalCostUsd on the same result message.
    const telemetry: HeldSessionTelemetryUpdate = {
      totalCostUsd: 1,
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cacheCreationInputTokens: 3,
        cacheReadInputTokens: 4
      }
    }
    expect('usage' in heldTelemetryToWire(telemetry)).toBe(false)
  })
})

describe('stampHeldCrew', () => {
  function board(): Mine[] {
    return [
      {
        ...defaultMine(),
        id: 'mine-1',
        dwarfs: [{ ...defaultDwarf(), id: 'claude:sess-1', role: 'foreman', sessionId: 'sess-1' }]
      }
    ]
  }

  function crewWith(...signals: HeldSessionSubagentSignal[]): HeldCrew {
    const crew = new HeldCrew()
    for (const signal of signals) crew.apply(signal)
    return crew
  }

  const launched = (taskId: string, spawnDepth = 1): HeldSessionSubagentSignal => ({
    kind: 'task-started',
    taskId,
    taskType: 'local_agent',
    spawnDepth
  })

  it('puts a held session’s subagents on the board beside its own dwarf', () => {
    const crew = crewWith(launched('a1'), launched('a2', 2))
    const { mines } = stampHeldCrew(board(), () => ({ held: true, crew }))
    expect(mines[0]!.dwarfs.map((dwarf) => [dwarf.id, dwarf.role])).toEqual([
      ['claude:sess-1', 'foreman'],
      ['claude:sess-1:a1', 'worker'],
      ['claude:sess-1:a2', 'worker2']
    ])
  })

  it('leaves a mine whose session this panel does not hold exactly as it was', () => {
    const { mines } = stampHeldCrew(board(), () => ({ held: false }))
    expect(mines[0]!.dwarfs).toHaveLength(1)
  })

  it('adds nobody for a held session that has launched nothing', () => {
    const { mines } = stampHeldCrew(board(), () => ({ held: true, crew: crewWith() }))
    expect(mines[0]!.dwarfs).toHaveLength(1)
  })

  it('routes every crew member, so the panel can offer a send that lands', () => {
    const crew = crewWith(launched('a1'))
    const { targets } = stampHeldCrew(board(), () => ({ held: true, crew }))
    expect(targets.get('claude:sess-1:a1')).toEqual({
      kind: 'foreman-relay',
      foremanDwarfId: 'claude:sess-1',
      workerName: 'agent-a1'
    })
  })

  it('never attaches a crew to a dwarf that is itself a subagent', () => {
    // A Claude worker carries its foreman's session id, so keying on the id
    // alone would hang one session's whole crew off every subagent in it — the
    // same trap stampHeldQuestions names.
    const mines = board()
    mines[0]!.dwarfs.push({
      ...defaultDwarf(),
      id: 'claude:sess-1:observed',
      role: 'worker',
      sessionId: 'sess-1'
    })
    const crew = crewWith(launched('a1'))
    const { mines: stamped } = stampHeldCrew(mines, () => ({ held: true, crew }))
    expect(stamped[0]!.dwarfs.map((dwarf) => dwarf.id)).toEqual([
      'claude:sess-1',
      'claude:sess-1:observed',
      'claude:sess-1:a1'
    ])
  })
})

describe('stampHeldRank', () => {
  function board(role: 'foreman' | 'worker' = 'foreman'): Mine[] {
    return [
      {
        ...defaultMine(),
        id: 'mine-1',
        dwarfs: [
          { ...defaultDwarf(), id: 'claude:sess-1', role, sessionId: 'sess-1' },
          { ...defaultDwarf(), id: 'claude:sess-1:a1', role: 'worker', sessionId: 'sess-1' }
        ]
      }
    ]
  }

  function crewThatCoordinated(): HeldCrew {
    const crew = new HeldCrew()
    crew.apply({ kind: 'task-started', taskId: 'a1', taskType: 'local_agent', spawnDepth: 1 })
    return crew
  }

  it('draws a launched session that has coordinated nothing as a lone worker', () => {
    const stamped = stampHeldRank(board(), () => ({ held: true, crew: new HeldCrew() }))
    expect(stamped[0]!.dwarfs[0]!.role).toBe('worker')
  })

  it('promotes it the moment it has a crew out', () => {
    const stamped = stampHeldRank(board(), () => ({ held: true, crew: crewThatCoordinated() }))
    expect(stamped[0]!.dwarfs[0]!.role).toBe('foreman')
  })

  it('keeps the promotion after the crew has finished', () => {
    // The observed sessions' own rule, so both paths say the same thing about
    // the same session: a session is the foreman whether or not it currently
    // has agents out. Deriving the rank from the headcount is what made the
    // same dwarf swap identity mid-session (claudeProvider).
    const crew = crewThatCoordinated()
    crew.apply({ kind: 'task-ended', taskId: 'a1' })
    const stamped = stampHeldRank(board(), () => ({ held: true, crew }))
    expect(stamped[0]!.dwarfs[0]!.role).toBe('foreman')
  })

  it('leaves a session this panel does not hold as its provider ranked it', () => {
    const stamped = stampHeldRank(board(), () => ({ held: false }))
    expect(stamped[0]!.dwarfs[0]!.role).toBe('foreman')
  })

  it('never demotes a subagent, which shares its session id', () => {
    const stamped = stampHeldRank(board(), () => ({ held: true, crew: new HeldCrew() }))
    expect(stamped[0]!.dwarfs[1]!.role).toBe('worker')
  })
})

describe('stampHeldTelemetry', () => {
  function board(): Mine[] {
    return [
      {
        ...defaultMine(),
        id: 'mine-1',
        dwarfs: [
          { ...defaultDwarf(), id: 'foreman-1', role: 'foreman', sessionId: 'sess-1' },
          { ...defaultDwarf(), id: 'worker-1', role: 'worker', sessionId: 'sess-1' }
        ]
      }
    ]
  }

  const state: HeldTelemetryState = {
    held: true,
    model: 'claude-haiku-4-5',
    effort: 'low',
    mcpServers: [{ name: 'codegraph', status: 'connected' }],
    totalCostUsd: 0.07
  }

  it("stamps the held session's own self-reported telemetry onto its foreman", () => {
    const stamped = stampHeldTelemetry(board(), () => state)
    expect(stamped[0]!.dwarfs[0]!).toMatchObject({
      model: 'claude-haiku-4-5',
      effort: 'low',
      mcpServers: [{ name: 'codegraph', status: 'connected' }],
      totalCostUsd: 0.07
    })
  })

  it("never stamps a worker, which shares its foreman's session id", () => {
    const stamped = stampHeldTelemetry(board(), () => state)
    expect(stamped[0]!.dwarfs[1]!.model).toBeUndefined()
    expect(stamped[0]!.dwarfs[1]!.totalCostUsd).toBeUndefined()
  })

  it('leaves a session this panel does not hold exactly as its provider reported it', () => {
    const mines = board()
    mines[0]!.dwarfs[0] = { ...mines[0]!.dwarfs[0]!, model: 'tail-derived-model' }
    const stamped = stampHeldTelemetry(mines, () => ({ held: false }))
    expect(stamped[0]!.dwarfs[0]!.model).toBe('tail-derived-model')
  })

  it('leaves every field untouched while a held session has reported nothing yet', () => {
    // held:true with an otherwise-empty state is the honest reading between
    // launch and the first init message — nothing to stamp, and nothing to
    // clear, unlike a resolved question.
    const mines = board()
    mines[0]!.dwarfs[0] = { ...mines[0]!.dwarfs[0]!, model: 'tail-derived-model' }
    const stamped = stampHeldTelemetry(mines, () => ({ held: true }))
    expect(stamped[0]!.dwarfs[0]!.model).toBe('tail-derived-model')
  })

  it("supersedes a tail-derived model once the held session's own init reports one", () => {
    const mines = board()
    mines[0]!.dwarfs[0] = { ...mines[0]!.dwarfs[0]!, model: 'tail-derived-model' }
    const stamped = stampHeldTelemetry(mines, () => ({ held: true, model: 'claude-sonnet-5' }))
    expect(stamped[0]!.dwarfs[0]!.model).toBe('claude-sonnet-5')
  })
})

/**
 * The words a held session's own stream carried (#159). The panel's message
 * surface needs a conversation to draw, and until now the loop read every
 * assistant and user message and threw them away.
 */
describe('heldMessageText', () => {
  it('reads a plain string message as its own text', () => {
    expect(heldMessageText('dig here')).toBe('dig here')
  })

  it('joins the text blocks of a block-array message, in order', () => {
    expect(
      heldMessageText([
        { type: 'text', text: 'Found the seam.' },
        { type: 'text', text: 'Digging.' }
      ])
    ).toBe('Found the seam.\nDigging.')
  })

  it('reads no words out of a tool call or a tool result', () => {
    // Neither is something a person said or an agent wrote, so neither is
    // part of the conversation — an empty answer is what keeps it out.
    expect(heldMessageText([{ type: 'tool_use', id: 'toolu_01', name: 'Read', input: {} }])).toBe(
      ''
    )
    expect(
      heldMessageText([{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'file contents' }])
    ).toBe('')
  })

  it('answers with nothing for a shape it does not recognise', () => {
    expect(heldMessageText(undefined)).toBe('')
    expect(heldMessageText(42)).toBe('')
    expect(heldMessageText([{ type: 'text' }])).toBe('')
  })
})

describe('retainHeldMessage', () => {
  const at = '2026-09-03T09:00:00.000Z'

  it('appends the message to what the host has already watched go by', () => {
    const kept = retainHeldMessage([], { role: 'user', text: 'dig here', timestamp: at })
    expect(retainHeldMessage(kept, { role: 'assistant', text: 'Digging.', timestamp: at })).toEqual(
      [
        { role: 'user', text: 'dig here', timestamp: at },
        { role: 'assistant', text: 'Digging.', timestamp: at }
      ]
    )
  })

  it('keeps only the last HELD_CONVERSATION_LIMIT messages', () => {
    let kept: FeedMessage[] = []
    for (let index = 0; index < HELD_CONVERSATION_LIMIT + 5; index++) {
      kept = retainHeldMessage(kept, { role: 'assistant', text: `line ${index}`, timestamp: at })
    }
    expect(kept).toHaveLength(HELD_CONVERSATION_LIMIT)
    expect(kept[0]!.text).toBe('line 5')
    expect(kept.at(-1)!.text).toBe(`line ${HELD_CONVERSATION_LIMIT + 4}`)
  })

  it('caps one message at HELD_MESSAGE_MAX_CHARS', () => {
    const kept = retainHeldMessage([], {
      role: 'assistant',
      text: 'x'.repeat(HELD_MESSAGE_MAX_CHARS + 500),
      timestamp: at
    })
    expect(kept[0]!.text).toHaveLength(HELD_MESSAGE_MAX_CHARS)
  })

  it('redacts on the way IN, so nothing retained can ship a secret later', () => {
    const kept = retainHeldMessage([], {
      role: 'user',
      text: 'use sk-abcdefghijklmnopqrstuvwxyz012345 for the API',
      timestamp: at
    })
    expect(kept[0]!.text).not.toContain('sk-abcdefghij')
    expect(kept[0]!.text).toContain('[redacted]')
  })

  it('retains nothing for a message with no words in it', () => {
    const kept: FeedMessage[] = [{ role: 'user', text: 'dig here', timestamp: at }]
    expect(retainHeldMessage(kept, { role: 'assistant', text: '   ', timestamp: at })).toEqual(kept)
  })
})

describe('stampHeldConversation', () => {
  function board(): Mine[] {
    return [
      {
        ...defaultMine(),
        id: 'mine-1',
        dwarfs: [
          { ...defaultDwarf(), id: 'foreman-1', role: 'foreman', sessionId: 'sess-1' },
          { ...defaultDwarf(), id: 'worker-1', role: 'worker', sessionId: 'sess-1' }
        ]
      }
    ]
  }

  const conversation = [
    { role: 'user' as const, text: 'dig here', timestamp: '2026-09-03T09:00:00.000Z' },
    { role: 'assistant' as const, text: 'Digging.', timestamp: '2026-09-03T09:00:01.000Z' }
  ]

  it("stamps the held session's own exchange onto its foreman", () => {
    const stamped = stampHeldConversation(board(), () => ({ held: true, conversation }))
    expect(stamped[0]!.dwarfs[0]!.conversation).toEqual(conversation)
  })

  it("never stamps a worker, which shares its foreman's session id", () => {
    const stamped = stampHeldConversation(board(), () => ({ held: true, conversation }))
    expect(stamped[0]!.dwarfs[1]!.conversation).toBeUndefined()
  })

  it('leaves a session this panel does not hold without a conversation at all', () => {
    const stamped = stampHeldConversation(board(), () => ({ held: false }))
    expect('conversation' in stamped[0]!.dwarfs[0]!).toBe(false)
  })

  it('stamps no empty conversation while a held session has said nothing yet', () => {
    // Absence is the wire's "nothing to show"; an empty array would be the
    // panel being told there IS a conversation and it is empty.
    const stamped = stampHeldConversation(board(), () => ({ held: true, conversation: [] }))
    expect('conversation' in stamped[0]!.dwarfs[0]!).toBe(false)
  })
})
