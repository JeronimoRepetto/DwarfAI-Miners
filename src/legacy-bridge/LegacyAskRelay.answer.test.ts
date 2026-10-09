// layer: L2
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CHANNELS } from '@dwarfai/contracts'
import {
  ASK_NO_LONGER_OPEN,
  defaultDwarf,
  type Dwarf,
  type DwarfPermissionRequest,
  type DwarfQuestion,
  type ProviderSnapshot
} from '../main/domain/types'
import { createAnswerDwarfRows } from '../ui-main/ipc/handlers/answerDwarf.host'
import { createAnswerDwarfDispatch } from '../ui-main/ipc/handlers/answerDwarf.dispatch'
import { createLegacyAnswerShapeAdapter } from './asks/LegacyAnswerShapeAdapter'
import { createLegacyAskRelay, legacyOpenAsksOf } from './LegacyAskRelay'
import type { LegacyDwarfIdBridge } from './LegacyDwarfIdBridge'
import type { LegacyLog, LegacyLogEntry } from './legacyDiagnostics'
import { NO_SUCH_DWARF } from './rowShapes/notFound'
import { PROMPT_NO_LONGER_OPEN } from './rowShapes/notOpen'

// L2 (17 §1.2): the answer half of `LegacyAskRelay` (21 §3, cuts 1–4) and `LegacyAnswerShapeAdapter` (21 §3.1, cuts
// 2–4): the legacy asks are exposed as `legacy:<legacyAskId>` with the Host dwarf of the exact join and their origin,
// and an A-40/A-41 answer in the 14 shapes (`AnswerQuestionParams` / `AnswerPermissionParams`) is converted to today's
// call, handed to today's runtime, and its result comes back as an ADR-010 `AnswerOutcome`. Doubles: a fake legacy
// runtime that records each call and answers a scripted result, `FakeLegacyDwarfIdBridge` (a fixed join), a
// recording UI log. TC-137-01, TC-137-02, TC-137-03.

const MINE_PATH = '/work/moria'
const FOREMAN = '01920000-0000-7000-9000-0000000e0001'
const CODEX = '01920000-0000-7000-9000-0000000e0002'
const SESSION = '9f1c2a7e-0000-4000-8000-00000000c1a0'
const THREAD = '0199aa00-0000-7000-8000-00000000c0de'
const LEGACY_FOREMAN = `claude:${SESSION}`
const LEGACY_CODEX = `codex:${THREAD}`
const PERMISSION_ID = 'toolu_01AbCdEfGhIjKlMnOpQrStUv'
const HELD_QUESTION_ID = 'toolu_01HeLdQuEsTiOnAbCdEfGhIj'
const QUESTION_ID = '0199aa00-0000-7000-8000-0000000a5c01'
const REQUEST = '01920000-0000-7000-a000-000000000001'
const OWN_WORDS = 'Ship it on Friday after the demo'

const permission: DwarfPermissionRequest = {
  toolUseId: PERMISSION_ID,
  toolName: 'Bash',
  title: 'Claude wants to run a command',
  input: 'pnpm test',
  channel: 'held',
  askedAt: '2026-10-05T10:00:00.000Z'
}
/** A held Claude question with two steps, the second multi-select. */
const heldQuestion: DwarfQuestion = {
  toolUseId: HELD_QUESTION_ID,
  channel: 'held',
  questions: [
    {
      question: 'When should it ship?',
      multiSelect: false,
      options: [{ label: 'Today' }, { label: 'Next week' }]
    },
    {
      question: 'Which checks first?',
      multiSelect: true,
      options: [{ label: 'lint' }, { label: 'tests' }, { label: 'build' }]
    }
  ],
  askedAt: '2026-10-05T10:00:02.000Z'
}
/** An observed Codex question, read by today's runtime (origin `legacy-ask-channel`). */
const codexQuestion: DwarfQuestion = {
  toolUseId: QUESTION_ID,
  channel: 'terminal',
  questions: [
    {
      question: 'Which branch should I use?',
      multiSelect: false,
      options: [{ label: 'main' }, { label: 'develop' }]
    }
  ],
  askedAt: '2026-10-05T10:00:01.000Z'
}

const legacyDwarf = (over: Partial<Dwarf> & Pick<Dwarf, 'id' | 'sessionId'>): Dwarf => ({
  ...defaultDwarf(),
  ...over
})

/** Today's sessions as `LegacyAgentRegistryFeed` wrote them: the foreman's ask given, and the Codex question. */
function legacySessions(foreman: {
  pendingPermission?: DwarfPermissionRequest
  pendingQuestion?: DwarfQuestion
}) {
  const sessions: ProviderSnapshot[] = [
    {
      provider: 'claude',
      sessionId: SESSION,
      cwd: MINE_PATH,
      status: 'busy',
      dwarfs: [
        legacyDwarf({
          id: LEGACY_FOREMAN,
          sessionId: SESSION,
          role: 'foreman',
          status: 'waiting',
          ...foreman
        })
      ],
      updatedAt: 1
    },
    {
      provider: 'codex',
      sessionId: THREAD,
      cwd: MINE_PATH,
      status: 'idle',
      dwarfs: [
        legacyDwarf({
          id: LEGACY_CODEX,
          sessionId: THREAD,
          provider: 'codex',
          status: 'waiting',
          pendingQuestion: codexQuestion
        })
      ],
      updatedAt: 1
    }
  ]
  return sessions
}

/** The exact join, fixed: Host dwarf ↔ legacy dwarf, both ways; anything else is not found. */
class FakeLegacyDwarfIdBridge implements Pick<LegacyDwarfIdBridge, 'toHost' | 'toLegacy'> {
  constructor(private readonly pairs: ReadonlyArray<[host: string, legacy: string]>) {}
  toHost(legacyId: string): Promise<string | null> {
    return Promise.resolve(this.pairs.find(([, legacy]) => legacy === legacyId)?.[0] ?? null)
  }
  toLegacy(dwarfId: string): Promise<string | null> {
    return Promise.resolve(this.pairs.find(([host]) => host === dwarfId)?.[1] ?? null)
  }
}

/** Today's runtime: records each call and answers the scripted result (or rejects). */
class FakeLegacyRuntime {
  readonly served: Array<[string, unknown]> = []
  result: () => Promise<unknown> = () => Promise.resolve({ answered: true })
  serve(channel: string, payload: unknown): Promise<unknown> {
    this.served.push([channel, payload])
    return this.result()
  }
}

class RecordingLegacyLog implements LegacyLog {
  readonly entries: LegacyLogEntry[] = []
  record(entry: LegacyLogEntry): void {
    this.entries.push(entry)
  }
}

const BOTH: ReadonlyArray<[string, string]> = [
  [FOREMAN, LEGACY_FOREMAN],
  [CODEX, LEGACY_CODEX]
]

async function world(
  options: {
    foreman?: { pendingPermission?: DwarfPermissionRequest; pendingQuestion?: DwarfQuestion }
    join?: ReadonlyArray<[string, string]>
  } = {}
) {
  const sessions = legacySessions(options.foreman ?? { pendingPermission: permission })
  const legacy = new FakeLegacyRuntime()
  const log = new RecordingLegacyLog()
  const relay = createLegacyAskRelay({
    bridge: new FakeLegacyDwarfIdBridge(options.join ?? BOTH),
    asks: { openAsks: () => legacyOpenAsksOf(sessions) },
    legacy,
    changed: () => undefined
  })
  await relay.update()
  const adapter = createLegacyAnswerShapeAdapter({ relay, log })
  return { relay, adapter, legacy, log }
}

const QUESTION_ROW = 'agent:answerQuestion'
const PERMISSION_ROW = 'agent:answerPermission'
const accepted = { ok: true, value: { kind: 'accepted' } }
const notOpen = { ok: true, value: { kind: 'not-open' } }
const refused = (reason: string) => ({ ok: true, value: { kind: 'refused', reason } })

describe('LegacyAskRelay answers and LegacyAnswerShapeAdapter (21 §3, §3.1; 14 §8 I-11)', () => {
  it('[ADR-001] a legacy ask is exposed as legacy:<id> with its Host dwarf id from the exact join', async () => {
    const { relay } = await world()

    // TC-137-01: each ask's id is in the relay's namespace, its dwarf is the joined Host dwarf, and its origin is
    // the channel today's runtime answers it on: a held ask is a legacy-launched session's, any other is read and
    // answered by today's runtime for a session it did not launch.
    expect(relay.asks()).toEqual([
      {
        askId: `legacy:${PERMISSION_ID}`,
        dwarfId: FOREMAN,
        origin: 'legacy-launch',
        kind: 'permission'
      },
      {
        askId: `legacy:${QUESTION_ID}`,
        dwarfId: CODEX,
        origin: 'legacy-ask-channel',
        kind: 'question',
        channel: 'terminal',
        questions: codexQuestion.questions
      }
    ])
  })

  it('[ADR-001] an answer to a legacy: id is converted and handed to the legacy runtime, and its result comes back as an AnswerOutcome', async () => {
    const { adapter, legacy } = await world()
    const questionResponse = CHANNELS[QUESTION_ROW].response
    const permissionResponse = CHANNELS[PERMISSION_ROW].response

    // TC-137-01, TC-137-02: the 14 shapes in, today's call out (legacy dwarf id, today's ask id, nothing else), and
    // the renderer receives a valid IpcResult<AnswerOutcome>.
    const question = await adapter.serve(QUESTION_ROW, {
      askId: `legacy:${QUESTION_ID}`,
      answers: [{ step: 0, option: 'develop' }],
      requestId: REQUEST
    })
    const decision = await adapter.serve(PERMISSION_ROW, {
      askId: `legacy:${PERMISSION_ID}`,
      decision: 'deny',
      requestId: REQUEST
    })

    expect(questionResponse.parse(question)).toEqual(accepted)
    expect(permissionResponse.parse(decision)).toEqual(accepted)
    expect(legacy.served).toEqual([
      [
        QUESTION_ROW,
        {
          dwarfId: LEGACY_CODEX,
          toolUseId: QUESTION_ID,
          answers: { 'Which branch should I use?': 'develop' }
        }
      ],
      [PERMISSION_ROW, { dwarfId: LEGACY_FOREMAN, toolUseId: PERMISSION_ID, decision: 'deny' }]
    ])
  })

  it('[ADR-001] today’s answer result maps to accepted, not-open or refused, and an unmappable result is refused channel-rejected', async () => {
    const { adapter, legacy } = await world()
    const response = CHANNELS[PERMISSION_ROW].response
    const cases: Array<[label: string, result: () => Promise<unknown>, expected: unknown]> = [
      ['answered', () => Promise.resolve({ answered: true }), accepted],
      [
        'question closed',
        () => Promise.resolve({ answered: false, error: ASK_NO_LONGER_OPEN }),
        notOpen
      ],
      [
        'prompt closed',
        () => Promise.resolve({ answered: false, error: PROMPT_NO_LONGER_OPEN }),
        notOpen
      ],
      ['dwarf left', () => Promise.resolve({ answered: false, error: NO_SUCH_DWARF }), notOpen],
      [
        'refused with a reason',
        () => Promise.resolve({ answered: false, error: 'No console.' }),
        refused('channel-rejected')
      ],
      [
        'refused without a reason',
        () => Promise.resolve({ answered: false }),
        refused('channel-rejected')
      ],
      ['nothing', () => Promise.resolve(undefined), refused('channel-rejected')],
      ['another shape', () => Promise.resolve({ ok: true }), refused('channel-rejected')],
      [
        'a mistyped verdict',
        () => Promise.resolve({ answered: 'true' }),
        refused('channel-rejected')
      ],
      ['a throw', () => Promise.reject(new Error('runtime gone')), refused('channel-rejected')]
    ]
    for (const [label, result, expected] of cases) {
      legacy.result = result
      const outcome = await adapter.serve(PERMISSION_ROW, {
        askId: `legacy:${PERMISSION_ID}`,
        decision: 'allow',
        requestId: REQUEST
      })
      expect(response.parse(outcome), label).toEqual(expected)
    }
  })

  it('[ADR-001] a refused legacy answer is logged by event name only, never with the answer’s words', async () => {
    const { adapter, legacy, log } = await world()
    legacy.result = () => Promise.resolve({ verdict: OWN_WORDS })

    const outcome = await adapter.serve(QUESTION_ROW, {
      askId: `legacy:${QUESTION_ID}`,
      answers: [{ step: 0, freeText: OWN_WORDS }],
      requestId: REQUEST
    })

    expect(outcome).toEqual(refused('channel-rejected'))
    // NFR-SEC-12, 19 §7: the record names the event and the reason; no answer text, no ids of today's runtime.
    expect(log.entries).toEqual([
      {
        level: 'warn',
        event: 'ask.answer.refused',
        subsystem: 'legacy-runtime',
        causeClass: 'channel-rejected'
      }
    ])
    expect(JSON.stringify(log.entries)).not.toContain(OWN_WORDS)
  })

  it('[ADR-001] a free-text or multi-select answer converts to today’s text, ownWords or joined labels', async () => {
    const terminal = await world()
    await terminal.adapter.serve(QUESTION_ROW, {
      askId: `legacy:${QUESTION_ID}`,
      answers: [{ step: 0, freeText: OWN_WORDS }],
      requestId: REQUEST
    })
    // A one-question picker in a console takes the person's words as today's `text`.
    expect(terminal.legacy.served).toEqual([
      [QUESTION_ROW, { dwarfId: LEGACY_CODEX, toolUseId: QUESTION_ID, text: OWN_WORDS }]
    ])

    const held = await world({ foreman: { pendingQuestion: heldQuestion } })
    await held.adapter.serve(QUESTION_ROW, {
      askId: `legacy:${HELD_QUESTION_ID}`,
      answers: [
        { step: 0, freeText: OWN_WORDS },
        { step: 1, option: 'lint' },
        { step: 1, option: 'tests' }
      ],
      requestId: REQUEST
    })
    // A held call takes labels per question (several joined as today joins them) and the person's words as ownWords.
    expect(held.legacy.served).toEqual([
      [
        QUESTION_ROW,
        {
          dwarfId: LEGACY_FOREMAN,
          toolUseId: HELD_QUESTION_ID,
          answers: { 'Which checks first?': 'lint\ntests' },
          ownWords: { 'When should it ship?': OWN_WORDS }
        }
      ]
    ])
  })

  it('[ADR-001] an answer that names no step of the ask is refused invalid-answer, and a payload off the 14 shape is invalid params', async () => {
    const { adapter, legacy } = await world()
    const askId = `legacy:${QUESTION_ID}`

    for (const answers of [
      [{ step: 1, option: 'develop' }],
      [{ step: 0, option: 'develop', freeText: OWN_WORDS }],
      [{ step: 0 }],
      [
        { step: 0, freeText: OWN_WORDS },
        { step: 0, freeText: 'twice' }
      ]
    ]) {
      expect(await adapter.serve(QUESTION_ROW, { askId, answers, requestId: REQUEST })).toEqual(
        refused('invalid-answer')
      )
    }
    for (const payload of [
      { askId, answers: [{ step: 0, option: 'develop' }] },
      { askId, answers: [{ step: 0, option: 'develop' }], requestId: REQUEST, dwarfId: CODEX },
      { askId: 'toolu_01AbCdEfGhIjKlMnOpQrStUv', answers: [], requestId: REQUEST },
      null
    ]) {
      expect(await adapter.serve(QUESTION_ROW, payload)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_PARAMS' }
      })
    }
    expect(
      await adapter.serve(PERMISSION_ROW, {
        askId: `legacy:${PERMISSION_ID}`,
        decision: 'always',
        requestId: REQUEST
      })
    ).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } })
    expect(legacy.served).toEqual([])
  })

  it('[ADR-001] an answer to a legacy: id that is not open now is not-open and never reaches the legacy runtime', async () => {
    const { adapter, legacy } = await world()

    // ADR-010 stale drop: an id no card carries, and a question row naming the permission's id.
    expect(
      await adapter.serve(QUESTION_ROW, {
        askId: 'legacy:toolu_closed',
        answers: [{ step: 0, option: 'develop' }],
        requestId: REQUEST
      })
    ).toEqual(notOpen)
    expect(
      await adapter.serve(QUESTION_ROW, {
        askId: `legacy:${PERMISSION_ID}`,
        answers: [{ step: 0, option: 'develop' }],
        requestId: REQUEST
      })
    ).toEqual(notOpen)
    expect(
      await adapter.serve(PERMISSION_ROW, {
        askId: `legacy:${QUESTION_ID}`,
        decision: 'allow',
        requestId: REQUEST
      })
    ).toEqual(notOpen)
    expect(legacy.served).toEqual([])
  })

  it('[ADR-001] a legacy ask whose dwarf has no exact match is not shown (never a guessed dwarf)', async () => {
    // The join knows only the foreman: the Codex dwarf has no Host match.
    const { relay, adapter, legacy } = await world({ join: [[FOREMAN, LEGACY_FOREMAN]] })

    expect(relay.asks().map((ask) => ask.askId)).toEqual([`legacy:${PERMISSION_ID}`])
    expect(
      await adapter.serve(QUESTION_ROW, {
        askId: `legacy:${QUESTION_ID}`,
        answers: [{ step: 0, option: 'develop' }],
        requestId: REQUEST
      })
    ).toEqual(notOpen)
    expect(legacy.served).toEqual([])
  })

  it('[ADR-001] the answer of an observed Codex question through the relay equals the pre-cut build', async () => {
    // TC-137-03 (lives here, not in the dispatch's L6 file: only the bridge may compose the relay, R16).
    const fixture = JSON.parse(
      readFileSync(new URL('./asks/fixtures/observed-codex-question.json', import.meta.url), 'utf8')
    ) as {
      legacyDwarfId: string
      hostDwarfId: string
      pendingQuestion: DwarfQuestion
      preCut: { channel: string; payload: unknown }
      cut2: { channel: string; payload: unknown }
      legacyRuntimeCall: [string, unknown]
    }
    const sessions: ProviderSnapshot[] = [
      {
        provider: 'codex',
        sessionId: THREAD,
        cwd: MINE_PATH,
        status: 'idle',
        dwarfs: [
          legacyDwarf({
            id: fixture.legacyDwarfId,
            sessionId: THREAD,
            provider: 'codex',
            status: 'waiting',
            pendingQuestion: fixture.pendingQuestion
          })
        ],
        updatedAt: 1
      }
    ]
    const legacy = new FakeLegacyRuntime()
    const relay = createLegacyAskRelay({
      bridge: new FakeLegacyDwarfIdBridge([[fixture.hostDwarfId, fixture.legacyDwarfId]]),
      asks: { openAsks: () => legacyOpenAsksOf(sessions) },
      legacy,
      changed: () => undefined
    })
    await relay.update()
    const hostCalls: unknown[] = []
    const dispatch = createAnswerDwarfDispatch({
      host: createAnswerDwarfRows({
        call: (method) => {
          hostCalls.push(method)
          return Promise.reject(new Error('never the Host'))
        }
      }),
      legacy: createLegacyAnswerShapeAdapter({ relay, log: new RecordingLegacyLog() })
    })

    // The pre-cut build: today's payload through the cut-1 relay.
    expect(await relay.serve(fixture.preCut.channel, fixture.preCut.payload)).toEqual({
      answered: true
    })
    // Cut 2: the 14 shape through the dispatch.
    expect(await dispatch.serve(fixture.cut2.channel, fixture.cut2.payload)).toEqual(accepted)

    // Today's runtime, and so the provider, receives the same answer both times.
    expect(legacy.served).toEqual([fixture.legacyRuntimeCall, fixture.legacyRuntimeCall])
    expect(hostCalls).toEqual([])
  })
})
