import { reactive } from 'vue'
import {
  HOST_FRAME_SCHEMAS,
  type AnswerOutcome,
  type AskId,
  type AskRecord,
  type HostFrame,
  type IpcResult,
  type QuestionAnswers,
  type SnapshotChunk,
  type UiSessionChange
} from '@dwarfai/contracts'
import {
  permissionAnswerRecord,
  questionAnswersRecord,
  wordsAnswerRecord
} from '../lib/question/answersRecord'
import type { AskAnswer } from '../lib/question/questionAnswer'
import {
  defaultDwarfQuestionState,
  splitAnswerLabels,
  type DwarfAnswerState,
  type DwarfPermissionDecision,
  type DwarfPermissionRequest,
  type DwarfQuestion
} from '../types'
import { mintRequestId } from './requestIds'
import { createReadModel, followHost, type HostFollower } from './readModel'
import { useAttentionCues } from './useAttentionCues'
import { useDwarfMessaging } from './useDwarfMessaging'
import { useHostConnection } from './useHostConnection'

/**
 * The verdict of an answer the panel gave to an agent's question (#94, #125),
 * or a decision it gave on a permission prompt (#203) — ONE store for both,
 * because a verdict is about a toolUseId, whichever kind of prompt named it.
 * `answer` and `decide` differ only in which wire request they build and which
 * bridge method they call; both write the exact same DwarfAnswerState shape,
 * keyed by dwarf, and neither cares what the other last wrote there.
 *
 * Deliberately shorter than useDwarfMessaging, and the difference is the whole
 * point. A message is watched across later polls because a relay can offer no
 * proof a session read it; a verdict here needs none, because main releases
 * the agent's own blocked tool call and reports whether that happened. There
 * is no reaction to observe here and none to invent — routing this through a
 * watch would throw away the stronger fact to reconstruct a weaker one.
 *
 * What a verdict never touches is the PROMPT. The card on screen is drawn from
 * the dwarf's own `pendingQuestion` or `pendingPermission`, which only main's
 * next snapshot can drop: a store that hid one on a successful send would be
 * claiming the prompt was closed on the strength of its own optimism.
 *
 * What a submit does draw is its RECORD (#635; decision log, Answers bubble is a record): the
 * "Answers:" bubble in the conversation, minted in the same step that takes the in-flight guard, so
 * one submit draws one record however many presses reached it. It is the messaging store's echo,
 * because it is drawn with the person's other bubbles, but nothing is sent for it: the answer
 * leaves on the ask's own channel below, and the record walks that answer's verdict.
 */

// Singleton store: module-scope state shared by every useDwarfQuestion()
// caller, exactly as the messaging and kicking stores are.
const state = reactive(defaultDwarfQuestionState())

const LOST_BRIDGE = 'The panel lost contact with the app.'
const NOT_ANSWERED = 'That answer could not be delivered.'

/**
 * What one answer came to (AMENDED for ISSUE-141, was: today's `DwarfQuestionAnswerResult`): from the cut-2 switch A-40
 * and A-41 answer in the 14 shape, `IpcResult<AnswerOutcome>` (ADR-010 item 5), for every card (from ISSUE-241 each a
 * Host ask). `accepted` is handed over; `not-open` is a
 * stale submit, which renders nothing (US-ASK-006.AC09): the card stays as the Host reports it; a refusal, a call
 * error or a lost bridge is not handed over, with today's own words (the outcome carries a reason code, never a
 * sentence to show).
 */
type AnswerVerdict =
  { kind: 'answered' } | { kind: 'not-open' } | { kind: 'refused'; error: string }

/** The verdict of an A-40/A-41 result; anything off the 14 shape is a refusal. */
function answerVerdictOf(result: IpcResult<AnswerOutcome> | undefined): AnswerVerdict {
  if (result?.ok !== true) return { kind: 'refused', error: NOT_ANSWERED }
  if (result.value.kind === 'accepted') return { kind: 'answered' }
  if (result.value.kind === 'not-open') return { kind: 'not-open' }
  return { kind: 'refused', error: NOT_ANSWERED }
}

/**
 * The 14 answers of one card submit (14 §3.4 `QuestionAnswers`): one entry per chosen option of each step (a toggled
 * step's labels split back out of their joined value), or the person's own words for that step.
 */
function questionAnswersOf(question: DwarfQuestion, answer: AskAnswer): QuestionAnswers {
  const values = typeof answer === 'string' ? [answer] : answer
  const answers: Array<QuestionAnswers[number]> = []
  question.questions.forEach((_asked, step) => {
    const value = values[step]
    if (value === undefined) return
    if (typeof value !== 'string') {
      answers.push({ step, freeText: value.ownWords })
      return
    }
    for (const option of splitAnswerLabels(value)) answers.push({ step, option })
  })
  return answers
}

/*
 * THE ASK READ MODEL (ISSUE-138; 14 §6.4 row `useDwarfQuestion`; ADR-033 items 3, 4).
 *
 * Every ask has exactly one answerer, the Host, and the store reads its source: the snapshot's `asks` section and the
 * frames `ask.opened`, `ask.closed`, `ask.step` (B-F15…B-F17) over A-N01/A-N02, applied only above the last seq
 * (`followHost`). A re-snapshot replaces the Host asks whole.
 *
 * AMENDED for ISSUE-241, the end of cut 4 (was: a dual-source read model, 21 §2 cut 2 "Legacy-bridge adapters", with a
 * legacy overlay of today's open asks as the facade's board carried them, ids in `LegacyAskRelay`'s namespace
 * `legacy:<legacyAskId>`): the relay left the tree, so a person-launched Codex question opens no card (ADR-011 item 4)
 * and the Host is the one source.
 *
 * The front card of a dwarf is its oldest open Host ask. `ask.closed` drops the card with no notice, so the composer comes back; an `ask.opened` re-sent
 * for the same id brings it back and drops the last verdict of that ask, so no earlier refusal is shown (ADR-010).
 * Each `ask.opened` frame also reaches the attention cues' `askOpened` intake, which judges it once per ask; a
 * snapshot's asks are state, never an arrival. `App.vue` starts the model at mount, and the message panel draws its
 * dwarf's front card from it (lib/message/askCard.ts).
 *
 * Partial picks live in the UI main session store (`ask-picks`, A-N17…A-N19; ADR-033 item 4), mirrored here and never
 * sent to the Host. The store's `ask-picks` key is an AskId (14 §3.9).
 *
 * Not built here (21 §1 item 8, hidden until built): reporting the current step (A-N07, later: ISSUE-129).
 *
 * AMENDED for ISSUE-141 (lead decision 2026-10-14: the answer half of ISSUE-138 is folded into the cut-2 switch, was:
 * answers leave in today's shape until the switch): A-40/A-41 have their target shape from the cut-2 switch, so every
 * answer leaves as `{ askId, answers, requestId }` / `{ askId, decision, requestId }` with one UUIDv7 per submit (14
 * §1.6), its AskId the card's own.
 */

/** One card of the read model: a Host ask. */
export type AskCard = { source: 'host'; id: string; dwarfId: string; ask: AskRecord }

type HostAsks = Record<string, AskRecord>

const asks = reactive({
  host: {} as HostAsks
})

/** Partial picks per Host AskId, as the UI main session store holds them. */
const picks = reactive<Record<string, QuestionAnswers>>({})

function replaceWhole<V>(target: Record<string, V>, next: Record<string, V>): void {
  for (const key of Object.keys(target)) delete target[key]
  Object.assign(target, next)
}

/** Drops the last verdict of a dwarf when it belongs to `askId`. */
function forgetVerdict(dwarfId: string, askId: string): void {
  if (state.byDwarfId[dwarfId]?.toolUseId === askId) delete state.byDwarfId[dwarfId]
}

/** Applies one ask frame newer than the snapshot; a frame whose data is not its 14 §3.5 payload is ignored. */
function applyAskFrame(frame: HostFrame): void {
  switch (frame.name) {
    case 'ask.opened': {
      const parsed = HOST_FRAME_SCHEMAS['ask.opened'].safeParse(frame.data)
      if (!parsed.success) return
      const ask = parsed.data.ask as AskRecord
      asks.host[ask.id] = ask
      forgetVerdict(ask.dwarfId, ask.id)
      // An arrival, judged by the attention cues once per ask (ISSUE-117 intake); a snapshot ask never is one.
      useAttentionCues().askOpened({
        dwarfId: ask.dwarfId,
        kind: ask.kind,
        askId: ask.id,
        reannounce: ask.reannounce
      })
      return
    }
    case 'ask.closed': {
      const parsed = HOST_FRAME_SCHEMAS['ask.closed'].safeParse(frame.data)
      if (!parsed.success) return
      delete asks.host[parsed.data.askId]
      forgetVerdict(parsed.data.dwarfId, parsed.data.askId)
      return
    }
    case 'ask.step': {
      const parsed = HOST_FRAME_SCHEMAS['ask.step'].safeParse(frame.data)
      if (!parsed.success) return
      const ask = asks.host[parsed.data.askId]
      if (ask !== undefined) ask.currentStep = parsed.data.currentStep
      return
    }
    default:
      return
  }
}

const hostModel = createReadModel<HostAsks, HostFrame>({
  state: asks.host,
  replace: (data) => replaceWhole(asks.host, data),
  apply: applyAskFrame
})

function hostAsksOf(chunks: readonly SnapshotChunk[]): HostAsks {
  const next: HostAsks = {}
  for (const chunk of chunks) {
    if (chunk.section !== 'asks') continue
    for (const ask of chunk.data.asks) next[ask.id] = ask as AskRecord
  }
  return next
}

function applySessionChange(change: UiSessionChange): void {
  if (change.kind !== 'ask-picks') return
  if (change.picks === null) delete picks[change.askId]
  else picks[change.askId] = change.picks
}

let follower: HostFollower | null = null
let stopFollowing: Array<() => void> = []

/** Follows the Host's asks and the session store's picks; answers whether the Host now feeds its asks. */
async function startAsks(): Promise<boolean> {
  if (follower !== null) return follower.start()
  follower = followHost(
    {
      subscribe: (listener) => window.api.onHostEvent((frames) => listener(frames as HostFrame[])),
      snapshot: (params) => window.api.getHostSnapshot(params)
    },
    { model: hostModel, sections: ['asks'], dataOf: hostAsksOf, settled: () => undefined }
  )
  stopFollowing = [
    // Subscribe first, then read (ADR-033 item 3): a change between the two is never missed.
    window.api.onUiSessionChanged((change) => applySessionChange(change as UiSessionChange))
  ]
  const [fed] = await Promise.all([follower.start(), loadPicks()])
  return fed
}

async function loadPicks(): Promise<void> {
  let session: { askPicks?: Record<string, QuestionAnswers> } | undefined
  try {
    session = (await window.api.getUiSession()) as typeof session
  } catch {
    return // Hidden until built: no session store, no stored picks.
  }
  replaceWhole(picks, { ...(session?.askPicks ?? {}) })
}

/** Stops following the Host's asks and forgets what they held. */
function stopAsks(): void {
  follower?.stop()
  follower = null
  for (const stop of stopFollowing.splice(0)) stop()
  hostModel.seq = 0
  replaceWhole(asks.host, {})
  replaceWhole(picks, {})
}

/** The card a dwarf shows now: its oldest open Host ask. */
function frontAsk(dwarfId: string): AskCard | undefined {
  const host = Object.values(asks.host)
    .filter((ask) => ask.dwarfId === dwarfId)
    .sort((a, b) => a.openedAt - b.openedAt)[0]
  return host === undefined ? undefined : { source: 'host', id: host.id, dwarfId, ask: host }
}

/** The step a Host ask is on, as the Host reports it. */
function stepOf(askId: string): number | undefined {
  return asks.host[askId]?.currentStep
}

/** The partial picks of an ask, as the UI main session store holds them. */
function picksFor(askId: string): QuestionAnswers {
  return picks[askId] ?? []
}

/** Stores the partial picks of a Host ask in the UI main session store (`null` drops them); never sent to the Host. */
function pick(askId: string, next: QuestionAnswers | null): void {
  if (next === null) delete picks[askId]
  else picks[askId] = next
  window.api.patchUiSession({ kind: 'ask-picks', askId: askId as AskId, picks: next })
}

export function useDwarfQuestion() {
  const messaging = useDwarfMessaging()

  function stateFor(dwarfId: string): DwarfAnswerState | undefined {
    return state.byDwarfId[dwarfId]
  }

  /**
   * Answer `question` with the option `label`. A second call while one is still
   * in flight for the same dwarf is ignored: a double press must never release
   * the same tool call twice.
   *
   * AMENDED for #443: `label` may be one value per question of a call that
   * asked several, and it still leaves as ONE request — the card's single
   * Submit — under the same guard, since every question belongs to the one
   * blocked tool call.
   */
  async function answer(dwarfId: string, question: DwarfQuestion, label: AskAnswer): Promise<void> {
    await release(
      dwarfId,
      question,
      questionAnswersOf(question, label),
      questionAnswersRecord(question, label)
    )
  }

  /**
   * Answer `question` in the person's own words, through the "Other" row its
   * picker offers (#481).
   *
   * `answer`'s sibling rather than a widening of it, because the two build
   * different wire forms and the forms are exclusive — one string against a
   * record of the agent's own labels. What they share is everything else, which
   * is `release` below: one in-flight guard and one verdict shape, because a
   * verdict is about a toolUseId whichever way the answer was given. A typed
   * answer behind an option answer would release the same blocked tool call
   * twice, and the guard is the store's rather than either function's for
   * exactly that.
   */
  async function answerWithText(
    dwarfId: string,
    question: DwarfQuestion,
    text: string
  ): Promise<void> {
    await release(
      dwarfId,
      question,
      [{ step: 0, freeText: text }],
      wordsAnswerRecord(question, text)
    )
  }

  async function release(
    dwarfId: string,
    question: DwarfQuestion,
    answers: QuestionAnswers,
    record: string
  ): Promise<void> {
    // Read-only while the Host is not connected (ADR-002 D9; 13 FM-146): nothing leaves.
    if (useHostConnection().readOnly.value) return
    if (state.byDwarfId[dwarfId]?.phase === 'answering') return
    const toolUseId = question.toolUseId
    state.byDwarfId[dwarfId] = { phase: 'answering', toolUseId }
    const recordId = messaging.recordAnswer(dwarfId, record, toolUseId)

    let verdict: AnswerVerdict
    try {
      verdict = answerVerdictOf(
        await window.api.answerDwarfQuestion({
          askId: toolUseId as AskId,
          answers,
          requestId: mintRequestId()
        })
      )
    } catch {
      verdict = { kind: 'refused', error: LOST_BRIDGE }
    }
    settle(dwarfId, toolUseId, recordId, verdict)
  }

  /**
   * Writes one answer's verdict. A `not-open` renders nothing (US-ASK-006.AC09): the card keeps no verdict and stays as
   * the Host reports it (its `ask.closed` frame closes it), and its "Answers:" record is withdrawn, the marker it took
   * given back (ISSUE-141, lead decision 2026-10-14).
   */
  function settle(
    dwarfId: string,
    toolUseId: string,
    recordId: string,
    verdict: AnswerVerdict,
    decision?: DwarfPermissionDecision
  ): void {
    const decided = decision === undefined ? {} : { decision }
    if (verdict.kind === 'not-open') {
      delete state.byDwarfId[dwarfId]
      messaging.withdrawAnswer(dwarfId, recordId)
      return
    }
    state.byDwarfId[dwarfId] =
      verdict.kind === 'answered'
        ? { phase: 'answered', toolUseId, ...decided }
        : { phase: 'refused', toolUseId, ...decided, error: verdict.error }
    messaging.settleAnswer(
      dwarfId,
      recordId,
      verdict.kind === 'answered' ? { answered: true } : { answered: false, error: verdict.error }
    )
  }

  /**
   * Decide `permission` with `decision` ('allow' or 'deny'). Same in-flight
   * guard and the same store as `answer` — see the module comment: a verdict
   * is about a toolUseId, whichever kind of prompt it named, so a second call
   * while one is still in flight for the same dwarf is ignored here exactly
   * as it is there.
   */
  async function decide(
    dwarfId: string,
    permission: DwarfPermissionRequest,
    decision: DwarfPermissionDecision
  ): Promise<void> {
    // Read-only while the Host is not connected (ADR-002 D9; 13 FM-146): nothing leaves.
    if (useHostConnection().readOnly.value) return
    if (state.byDwarfId[dwarfId]?.phase === 'answering') return
    const toolUseId = permission.toolUseId
    // The decision travels with every phase of the verdict, because what the
    // panel may say about it depends on which one it was: on a terminal
    // channel an Allow is a keypress waiting to be acted on and a Deny is an
    // Esc that may have interrupted a turn instead (#203, see
    // permissionStatusLine). An answer to a QUESTION records none — that
    // vocabulary is the permission prompt's alone.
    state.byDwarfId[dwarfId] = { phase: 'answering', toolUseId, decision }
    const recordId = messaging.recordAnswer(
      dwarfId,
      permissionAnswerRecord(permission, decision),
      toolUseId
    )

    let verdict: AnswerVerdict
    try {
      verdict = answerVerdictOf(
        await window.api.answerDwarfPermission({
          askId: toolUseId as AskId,
          decision,
          requestId: mintRequestId()
        })
      )
    } catch {
      verdict = { kind: 'refused', error: LOST_BRIDGE }
    }
    settle(dwarfId, toolUseId, recordId, verdict, decision)
  }

  function clear(dwarfId: string): void {
    delete state.byDwarfId[dwarfId]
  }

  function clearAll(): void {
    for (const dwarfId of Object.keys(state.byDwarfId)) clear(dwarfId)
  }

  return {
    state,
    answer,
    answerWithText,
    decide,
    stateFor,
    clear,
    clearAll,
    asks,
    startAsks,
    stopAsks,
    frontAsk,
    stepOf,
    picksFor,
    pick
  }
}
