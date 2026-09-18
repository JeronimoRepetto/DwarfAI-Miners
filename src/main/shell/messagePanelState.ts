/**
 * What the message-panel window is showing, and the boundary that reads it
 * (#162).
 *
 * The state itself is one small object main holds, written by BOTH windows: the
 * shell opens the panel on a dwarf or on the mine's Add action, and the panel
 * window closes itself and adopts the dwarf a launch produced. Main is the one
 * serialization point, so these parsers are what stands between two renderers
 * and a real BrowserWindow being created, moved and shown.
 *
 * Pure and Electron-free on purpose, like `panelBounds.ts` beside it: every
 * refusal below is assertable without a display, and `index.ts` keeps the
 * three-line handler it would otherwise have grown a validator inside.
 *
 * `parseAnswerRequest` joined them at #481 for that last reason alone. It is
 * not about what the window is SHOWING — it reads an answer the window gives
 * back — but it is a boundary parser of exactly the same kind, and the two
 * exclusive forms it now has to keep apart are worth pinning without a display
 * in front of them.
 */
import {
  MAX_DWARF_TEXT_CHARS,
  type DwarfDeliveryReport,
  type DwarfQuestionAnswerRequest,
  type MessagePanelState,
  type MessagePanelSurface
} from '../domain/types'

const SURFACES: readonly MessagePanelSurface[] = ['none', 'launch', 'message']

/**
 * The phases each store's own verdict may be in (see DwarfSendState,
 * DwarfKickState).
 *
 * 'held' is a SEND phase and never a kick one (#457): a message can wait for
 * a Codex turn to end, and an interrupt aimed at that same turn cannot — the
 * two lists are checked separately so neither can borrow the other's words.
 */
const SEND_PHASES = ['sending', 'held', 'delivered', 'reacted', 'failed'] as const
const KICK_PHASES = ['kicking', 'delivered', 'reacted', 'failed'] as const

/** The window closed: no surface, and therefore no mine and no dwarf. */
export function emptyMessagePanel(): MessagePanelState {
  return { surface: 'none', mineId: '', dwarfId: '' }
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
}

/**
 * Read a state one of the two windows asked for, or refuse it.
 *
 * The same boundary discipline every channel in `index.ts` holds, with one
 * thing added that the ordinary id channels do not need: a surface has to be
 * ABOUT something. A 'message' naming no dwarf, or a 'launch' naming no mine,
 * is not a narrower request — it is a payload that could not say what it
 * meant, and honouring it would open a window onto nothing. 'none' is the
 * opposite case and forgets both ids outright: keeping them would leave main
 * holding a selection nothing on screen agrees with.
 */
export function parseMessagePanelState(payload: unknown): MessagePanelState | null {
  if (typeof payload !== 'object' || payload === null) return null
  const record = payload as Record<string, unknown>
  if (!isOneOf(record.surface, SURFACES)) return null
  const { mineId, dwarfId } = record
  if (typeof mineId !== 'string' || typeof dwarfId !== 'string') return null
  if (record.surface === 'none') return emptyMessagePanel()
  if (mineId === '') return null
  if (record.surface === 'message' && dwarfId === '') return null
  return {
    surface: record.surface,
    mineId,
    // A launch has produced no dwarf yet, and must not carry one.
    dwarfId: record.surface === 'launch' ? '' : dwarfId
  }
}

/**
 * Read the height the panel window measured of itself, in DESIGN pixels, or
 * refuse it.
 *
 * Rounded here rather than in the geometry, because this is the boundary and
 * Electron's bounds take whole pixels; a non-positive or non-finite height
 * would reach `setBounds` as a rectangle it cannot apply, and the window would
 * either vanish or stay at whatever it last was with nothing saying why.
 */
export function parseMessagePanelHeight(payload: unknown): number | null {
  if (typeof payload !== 'number' || !Number.isFinite(payload) || payload <= 0) return null
  return Math.round(payload)
}

function parseVerdict<T extends string>(
  payload: unknown,
  phases: readonly T[]
): { phase: T; via?: string; error?: string; awaitingReaction?: boolean } | null {
  if (typeof payload !== 'object' || payload === null) return null
  const record = payload as Record<string, unknown>
  if (!isOneOf(record.phase, phases)) return null
  if (record.via !== undefined && typeof record.via !== 'string') return null
  if (record.error !== undefined && typeof record.error !== 'string') return null
  if (record.awaitingReaction !== undefined && typeof record.awaitingReaction !== 'boolean') {
    return null
  }
  return {
    phase: record.phase,
    // Absent stays absent: the stores leave these off when they have nothing
    // to say, and filling one in would put words on a marker nobody wrote.
    ...(record.via === undefined ? {} : { via: record.via }),
    ...(record.error === undefined ? {} : { error: record.error }),
    ...(record.awaitingReaction === undefined ? {} : { awaitingReaction: record.awaitingReaction })
  }
}

function parseVerdicts<T extends string>(
  payload: unknown,
  phases: readonly T[]
): Record<string, { phase: T }> | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const parsed: Record<string, { phase: T }> = {}
  for (const [dwarfId, verdict] of Object.entries(payload as Record<string, unknown>)) {
    const one = parseVerdict(verdict, phases)
    // One malformed entry takes the whole report down rather than being
    // dropped — the same ruling the answer record below holds. A partly read
    // report is a mine drawing one marker, missing another, and saying so
    // nowhere.
    if (one === null) return null
    parsed[dwarfId] = one
  }
  return parsed
}

/**
 * Read the send and kick verdicts the panel window reported, or refuse them.
 *
 * The two phase vocabularies are checked against their own lists rather than
 * against one merged list, so a kick can never arrive claiming to be 'sending'
 * — the two markers say different things and the words are the whole
 * difference between them.
 */
export function parseDwarfDeliveryReport(payload: unknown): DwarfDeliveryReport | null {
  if (typeof payload !== 'object' || payload === null) return null
  const record = payload as Record<string, unknown>
  const send = parseVerdicts(record.send, SEND_PHASES)
  const kick = parseVerdicts(record.kick, KICK_PHASES)
  if (send === null || kick === null) return null
  return { send, kick }
}

/** The record form: every key and value a string pair, or no answer at all. */
function parseAnswerRecord(payload: unknown): Record<string, string> | null {
  if (typeof payload !== 'object' || payload === null) return null
  const answers: Record<string, string> = {}
  for (const [question, label] of Object.entries(payload as Record<string, unknown>)) {
    // One malformed entry takes the whole answer down rather than being
    // dropped — a partly-read answer is one the panel would be answering
    // differently from how the person did.
    if (typeof label !== 'string') return null
    answers[question] = label
  }
  return answers
}

/**
 * Read an answer one of the windows gave to an agent's question, or refuse it
 * (#125, #481).
 *
 * Here rather than in `index.ts`, where it lived until #481, for the reason
 * every parser in this file is here: an answer releases a tool call a live
 * agent is blocked inside, and the refusals below are worth asserting without
 * an Electron window in front of them.
 *
 * ## Exactly one of the two forms
 *
 * The LABEL form is a RECORD of strings, which no other channel carries: keyed
 * by the question's text, valued by one of the agent's own option labels. The
 * TEXT form is #481's, and it is the person's own words for the picker's
 * "Other" row. A payload carrying BOTH is refused rather than resolved in some
 * order, because it could not say which answer it meant and choosing one would
 * be main answering on the person's behalf; a payload carrying NEITHER answers
 * nothing.
 *
 * ## What is judged here, and what is not
 *
 * A SHAPE and never a choice — the rule this parser has held since #125. What
 * the strings MEAN is matched against the ask the agent actually made, in the
 * runtime, where the ask is; so an empty record passes here and is refused
 * there as an answer that chose nothing.
 *
 * The text's two checks are shape checks on the same terms. An EMPTY string is
 * a field that could not say anything, and the wire ceiling is the widest bound
 * certainly true of the route (`MAX_DWARF_TEXT_CHARS`, #431). Whitespace alone
 * is content rather than shape, and it is refused where the keys are built,
 * with the sentence that is true of it.
 */
export function parseAnswerRequest(payload: unknown): DwarfQuestionAnswerRequest | null {
  if (typeof payload !== 'object' || payload === null) return null
  const record = payload as Record<string, unknown>
  if (typeof record.dwarfId !== 'string' || typeof record.toolUseId !== 'string') return null
  const address = { dwarfId: record.dwarfId, toolUseId: record.toolUseId }

  const hasText = record.text !== undefined
  const hasAnswers = record.answers !== undefined
  if (hasText === hasAnswers) return null

  if (hasText) {
    if (typeof record.text !== 'string') return null
    if (record.text === '' || record.text.length > MAX_DWARF_TEXT_CHARS) return null
    return { ...address, text: record.text }
  }

  const answers = parseAnswerRecord(record.answers)
  return answers === null ? null : { ...address, answers }
}
