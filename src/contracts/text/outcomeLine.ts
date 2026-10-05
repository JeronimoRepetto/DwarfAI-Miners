// The turn outcome line's words (US-MSG-011 "States and copy"; 06 §9.2; INV-67): the Host sends a
// structured line (kind, up to three parts, reliability) and this rule words it with the copy
// dictionary, so the renderer shows it and the idle time moves with the renderer's own clock, never a
// Host timer (NFR-TIM-15). Pure: `now` is passed in.
//
// - The status word is the kind's; a line with no reliable end (`reliability: 'inferred'`, kind
//   `working`, see the Host's `deriveOutcomeLine`) never reads "Turn finished" (ADR-021 item 3): its
//   word is the open design item of US-MSG-011, a `⟦COPY NEEDED⟧` marker until design writes it.
// - Parts follow in order, joined by " · "; counts take their singular and plural forms.
// - The idle part shows from the first whole minute: a dwarf falls asleep one minute after it
//   finishes (PO #7), and the line appends its idle time when it falls asleep (US-MSG-011
//   interaction 6). Package gap resolved in development: no Host trigger recomputes the line at
//   that instant, so the rule keys the part on the elapsed time it already words.
//
// The input is structural, because this folder imports nothing but its own files and zod (R9): the
// wire `OutcomeLine` (`contracts/wire`) is assignable to it, which its test holds.
import { t } from './copy'

/** The square's colour (US-MSG-011 business rules): idle has no colour of its own. */
export type OutcomeSquareTone = 'green' | 'brass' | 'steel'

/** 06 §9.2's closed part union, as the wire carries it. */
export type RenderablePart =
  | { kind: 'steps'; n: number }
  | { kind: 'steps-so-far'; n: number }
  | { kind: 'waiting-questions'; n: number }
  | { kind: 'waiting-permission' }
  | { kind: 'answers-received' }
  | { kind: 'reading-your-message' }
  | { kind: 'idle-since'; at: number }

/** What the rule reads of an outcome line. */
export interface RenderableOutcomeLine {
  kind: 'working' | 'concluded' | 'capped' | 'errored' | 'interrupted' | 'waiting-on-you'
  parts: readonly RenderablePart[]
  reliability: 'reliable' | 'inferred'
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** NFR-TIM-15: minutes, then hours, then days, each rounded down; no unit above days. */
export function idleText(ms: number): string {
  const elapsed = Math.max(0, ms)
  if (elapsed < HOUR_MS) {
    return t('outcomeLine.idle.minutes', { count: Math.floor(elapsed / MINUTE_MS) })
  }
  if (elapsed < DAY_MS) return t('outcomeLine.idle.hours', { count: Math.floor(elapsed / HOUR_MS) })
  return t('outcomeLine.idle.days', { count: Math.floor(elapsed / DAY_MS) })
}

function statusWord(line: RenderableOutcomeLine): string {
  if (line.reliability === 'inferred') return t('outcomeLine.status.noReliableEnd')
  switch (line.kind) {
    case 'working':
      return t('outcomeLine.status.working')
    case 'waiting-on-you':
      return t('outcomeLine.status.waitingOnYou')
    case 'concluded':
      return t('outcomeLine.status.concluded')
    case 'capped':
      return t('outcomeLine.status.capped')
    case 'errored':
      return t('outcomeLine.status.errored')
    case 'interrupted':
      return t('outcomeLine.status.interrupted')
  }
}

/** One part's words, or null when the part is not shown at `now`. */
function partText(part: RenderablePart, now: number): string | null {
  switch (part.kind) {
    case 'steps':
      return t('outcomeLine.part.steps', { count: part.n })
    case 'steps-so-far':
      return t('outcomeLine.part.stepsSoFar', { count: part.n })
    case 'waiting-questions':
      return t('outcomeLine.part.waitingQuestions', { count: part.n })
    case 'waiting-permission':
      return t('outcomeLine.part.waitingPermission')
    case 'answers-received':
      return t('outcomeLine.part.answersReceived')
    case 'reading-your-message':
      return t('outcomeLine.part.readingYourMessage')
    case 'idle-since': {
      const elapsed = now - part.at
      return elapsed < MINUTE_MS ? null : t('outcomeLine.part.idleFor', { time: idleText(elapsed) })
    }
  }
}

/** The line as the person reads it: the status word, then each shown part, joined by " · ". */
export function renderOutcomeLine(line: RenderableOutcomeLine, now: number): string {
  const parts = line.parts.flatMap((part) => {
    const text = partText(part, now)
    return text === null ? [] : [text]
  })
  return [statusWord(line), ...parts].join(t('outcomeLine.separator'))
}

/** The status square: green for working and idle, brass for asking, steel for asleep. */
export function outcomeSquareTone(
  status: 'working' | 'asking' | 'idle' | 'asleep'
): OutcomeSquareTone {
  if (status === 'asking') return 'brass'
  if (status === 'asleep') return 'steel'
  return 'green'
}
