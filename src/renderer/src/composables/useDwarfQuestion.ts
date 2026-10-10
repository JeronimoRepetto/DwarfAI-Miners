import { reactive, watch } from 'vue'
import {
  HOST_FRAME_SCHEMAS,
  type AskId,
  type AskRecord,
  type HostFrame,
  type QuestionAnswers,
  type SnapshotChunk,
  type UiSessionChange
} from '@dwarfai/contracts'
import {
  permissionAnswerRecord,
  questionAnswersRecord,
  wordsAnswerRecord
} from '../lib/question/answersRecord'
import {
  answerRequest,
  permissionRequest,
  textAnswerRequest,
  type AskAnswer
} from '../lib/question/questionAnswer'
import {
  defaultDwarfQuestionState,
  type DwarfAnswerState,
  type DwarfPermissionDecision,
  type DwarfPermissionRequest,
  type DwarfQuestion,
  type DwarfQuestionAnswerRequest,
  type DwarfQuestionAnswerResult,
  type Mine
} from '../types'
import { createReadModel, followHost, type HostFollower } from './readModel'
import { useDwarfMessaging } from './useDwarfMessaging'
import { useHostConnection } from './useHostConnection'
import { useMines } from './useMines'

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

/** The answer's verdict as its record wears it: handed over, or refused with main's reason. */
function verdictOf(result: DwarfQuestionAnswerResult): { answered: boolean; error?: string } {
  return result.answered
    ? { answered: true }
    : { answered: false, error: result.error ?? NOT_ANSWERED }
}

/*
 * THE DUAL-SOURCE ASK READ MODEL (ISSUE-138; 21 §2 cut 2 "Legacy-bridge adapters", §3 `LegacyAskRelay`; 14 §6.4 row
 * `useDwarfQuestion`; ADR-033 items 3, 4).
 *
 * From cut 2 every ask has exactly one answerer, and the store reads both:
 * - The Host source: the snapshot's `asks` section and the frames `ask.opened`, `ask.closed`, `ask.step` (B-F15…B-F17)
 *   over A-N01/A-N02, applied only above the last seq (`followHost`). A re-snapshot replaces the Host asks whole.
 * - The legacy overlay: today's open asks as the facade's board (A-12/A-P2, `BoardFacadeAdapter`) carries them on its
 *   dwarfs, ids in `LegacyAskRelay`'s namespace `legacy:<legacyAskId>`. It has no seq: each board replaces it whole.
 * A card's source is its id namespace: a `legacy:` id is never a UUIDv7, so it can never pass for a Host AskId, and a
 * Host ask never enters the overlay.
 *
 * The front card of a dwarf is its oldest open Host ask, else its legacy card (a permission before a question, as the
 * panel draws them). `ask.closed` drops the card with no notice, so the composer comes back; an `ask.opened` re-sent
 * for the same id brings it back and drops the last verdict of that ask, so no earlier refusal is shown (ADR-010).
 *
 * Partial picks live in the UI main session store (`ask-picks`, A-N17…A-N19; ADR-033 item 4), mirrored here and never
 * sent to the Host. Only Host AskIds cross: the store's `ask-picks` key is an AskId (14 §3.9), which a `legacy:` id is
 * not, so a legacy card keeps today's own picks.
 *
 * Not built here (21 §1 item 8, hidden until built): reporting the current step (A-N07, later: ISSUE-129) and the
 * answers in the 14 shapes, which reach `window.api` only when the cut-2 switch (later: ISSUE-141) gives A-40/A-41
 * their target shape; until then answers leave in today's shape below.
 */

/** One card of the read model; its source is its id namespace. */
export type AskCard =
  { source: 'host'; id: string; dwarfId: string; ask: AskRecord } | LegacyAskCard

/** A card of the legacy overlay, in today's shape. */
export type LegacyAskCard =
  | { source: 'legacy'; id: string; dwarfId: string; kind: 'question'; question: DwarfQuestion }
  | {
      source: 'legacy'
      id: string
      dwarfId: string
      kind: 'permission'
      permission: DwarfPermissionRequest
    }

/** `LegacyAskRelay`'s AskId namespace (21 §3). */
const LEGACY_ASK_NAMESPACE = 'legacy:'

function isLegacyAskId(id: string): boolean {
  return id.startsWith(LEGACY_ASK_NAMESPACE) && id.length > LEGACY_ASK_NAMESPACE.length
}

type HostAsks = Record<string, AskRecord>

const asks = reactive({
  host: {} as HostAsks,
  legacy: {} as Record<string, LegacyAskCard>
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

/** Replaces the legacy overlay whole with the asks the facade's board carries now (never sequence-filtered). */
function replaceLegacyOverlay(mines: readonly Mine[]): void {
  const next: Record<string, LegacyAskCard> = {}
  for (const dwarf of mines.flatMap((mine) => mine.dwarfs)) {
    const { pendingPermission: permission, pendingQuestion: question } = dwarf
    if (permission !== undefined && isLegacyAskId(permission.toolUseId)) {
      const id = permission.toolUseId
      next[id] = { source: 'legacy', id, dwarfId: dwarf.id, kind: 'permission', permission }
    }
    if (question !== undefined && isLegacyAskId(question.toolUseId)) {
      const id = question.toolUseId
      next[id] = { source: 'legacy', id, dwarfId: dwarf.id, kind: 'question', question }
    }
  }
  replaceWhole(asks.legacy, next)
}

function applySessionChange(change: UiSessionChange): void {
  if (change.kind !== 'ask-picks') return
  if (change.picks === null) delete picks[change.askId]
  else picks[change.askId] = change.picks
}

let follower: HostFollower | null = null
let stopFollowing: Array<() => void> = []

/**
 * Follows both sources and the session store's picks; answers whether the Host now feeds its asks (a table that
 * refuses A-N01 leaves only the legacy overlay).
 */
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
    watch(() => useMines().state.mines, replaceLegacyOverlay, { immediate: true, flush: 'sync' }),
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

/** Stops following both sources and forgets what they held. */
function stopAsks(): void {
  follower?.stop()
  follower = null
  for (const stop of stopFollowing.splice(0)) stop()
  hostModel.seq = 0
  replaceWhole(asks.host, {})
  replaceWhole(asks.legacy, {})
  replaceWhole(picks, {})
}

/** The card a dwarf shows now: its oldest open Host ask, else its legacy card (a permission first). */
function frontAsk(dwarfId: string): AskCard | undefined {
  const host = Object.values(asks.host)
    .filter((ask) => ask.dwarfId === dwarfId)
    .sort((a, b) => a.openedAt - b.openedAt)[0]
  if (host !== undefined) return { source: 'host', id: host.id, dwarfId, ask: host }
  const legacy = Object.values(asks.legacy).filter((card) => card.dwarfId === dwarfId)
  return legacy.find((card) => card.kind === 'permission') ?? legacy[0]
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
  if (isLegacyAskId(askId)) return
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
      answerRequest(dwarfId, question, label),
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
      textAnswerRequest(dwarfId, question, text),
      wordsAnswerRecord(question, text)
    )
  }

  async function release(
    dwarfId: string,
    question: DwarfQuestion,
    request: DwarfQuestionAnswerRequest,
    record: string
  ): Promise<void> {
    // Read-only while the Host is not connected (ADR-002 D9; 13 FM-146): nothing leaves.
    if (useHostConnection().readOnly.value) return
    if (state.byDwarfId[dwarfId]?.phase === 'answering') return
    const toolUseId = question.toolUseId
    state.byDwarfId[dwarfId] = { phase: 'answering', toolUseId }
    const recordId = messaging.recordAnswer(dwarfId, record, toolUseId)

    let result: DwarfQuestionAnswerResult
    try {
      result = await window.api.answerDwarfQuestion(request)
    } catch {
      result = { answered: false, error: LOST_BRIDGE }
    }

    state.byDwarfId[dwarfId] = result.answered
      ? { phase: 'answered', toolUseId }
      : { phase: 'refused', toolUseId, error: result.error ?? NOT_ANSWERED }
    messaging.settleAnswer(dwarfId, recordId, verdictOf(result))
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

    let result: DwarfQuestionAnswerResult
    try {
      result = await window.api.answerDwarfPermission(
        permissionRequest(dwarfId, permission, decision)
      )
    } catch {
      result = { answered: false, error: LOST_BRIDGE }
    }

    state.byDwarfId[dwarfId] = result.answered
      ? { phase: 'answered', toolUseId, decision }
      : { phase: 'refused', toolUseId, decision, error: result.error ?? NOT_ANSWERED }
    messaging.settleAnswer(dwarfId, recordId, verdictOf(result))
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
