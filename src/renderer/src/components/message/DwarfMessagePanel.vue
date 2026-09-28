<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { belongsToComposition } from '../../lib/controls/input'
import {
  CONSOLE_HINT,
  JUMP_TO_TERMINAL_NAME,
  approvalNote,
  buildActionBar,
  refusalLine,
  SESSION_CLOSED_REASON,
  sessionClosed
} from '../../lib/delivery/actionBar'
/* --- Message attachments (#408) — one block, appended -------------------- */
import { ATTACH_LOST_CONTACT, acceptAttachments, attachHint } from '../../lib/delivery/attachments'
/* --- end of the #408 block ----------------------------------------------- */
import { kickStatusLine, sendMarker, sendStatusLine } from '../../lib/delivery/deliveryVerdict'
import { historyClock, historyMarks, HISTORY_MARK } from '../../lib/history/mineHistory'
import {
  activityStepsLabel,
  countedRunSteps,
  groupActivity,
  runsHaveEnded,
  type PanelEntry
} from '../../lib/message/activityGroup'
import { conversationOf, ENDED_NOTE } from '../../lib/message/conversation'
import { echoRowsOf, mergeEchoes, type MessageEcho, type PanelRow } from '../../lib/message/echo'
import { tailArrivals } from '../../lib/message/entryArrival'
import { isOpenablePath } from '../../lib/message/openablePath'
import {
  COMPOSER_HINT,
  MENU_CONSOLE,
  MENU_HISTORY,
  MENU_STOP,
  STOP_DWARF_BODY,
  bubbleMark,
  dayLabel,
  messagePanelChips,
  messagePanelMenu,
  messagePanelOutcome,
  stopDwarfTitle,
  type BubbleMark
} from '../../lib/message/panelChrome'
import type { AskAnswer } from '../../lib/question/questionAnswer'
import { sceneDwarfLabel, sceneDwarfStatus } from '../../lib/scene/sceneDwarf'
import {
  STICK_TO_BOTTOM_TOLERANCE_PX,
  TOP_OF_LIST_TOLERANCE_PX,
  nextScrollTop,
  reachedTopOfList,
  rowsWerePrepended,
  scrollTopAfterPrepend,
  shouldStickToBottom
} from '../../lib/message/listScroll'
import {
  maxTextCharsFor,
  messageTooLongReason,
  type Dwarf,
  type DwarfAnswerState,
  type DwarfAttachment,
  type DwarfAttachmentPick,
  type DwarfFeedResult,
  type DwarfKickState,
  type DwarfPermissionDecision,
  type DwarfSendState
} from '../../types'
import ActionButton from '../controls/ActionButton.vue'
import InputField from '../controls/InputField.vue'
import MetaChip from '../controls/MetaChip.vue'
import DwarfPermissionCard from '../dwarf/DwarfPermissionCard.vue'
import DwarfPortrait from '../dwarf/DwarfPortrait.vue'
import DwarfQuestionCard from '../dwarf/DwarfQuestionCard.vue'
import PixelIcon from '../icon/PixelIcon.vue'
import MenuButton from '../overlay/MenuButton.vue'
import ModalDialog from '../overlay/ModalDialog.vue'
import ActivityDisclosure from './ActivityDisclosure.vue'
import ChatBubble from './ChatBubble.vue'

/**
 * The redesigned MessagePanel (#635), `organisms/message-panel` in the design: the conversation
 * with one dwarf, anchored in the dock's window slot. A header with the 40px portrait, the name
 * over two meta chips and the tools (Mine history, Open console, ⋯, Close); the turn outcome line;
 * the conversation, which scrolls inside; and the composer, or the question card in its place.
 *
 * Thin, like every component here. Which words may be shown and what the panel claims they are is
 * lib/message/conversation's; what the chrome says is lib/message/panelChrome's; which controls are
 * live and what a disabled one says is lib/delivery/actionBar's.
 *
 * ## What the redesign took away, stated rather than passing unseen
 *
 * The panel has no height of its own: the dock sets it, the person cannot resize it, and the
 * conversation scrolls inside (decision log, MessagePanel and Add panel anchored), so the top-edge
 * resize, the opening height derived from the latest message and the history tab that expanded it
 * are gone, with lib/message/panelHeight. The header does not drag. The kick in the composer's
 * icon column moved into the ⋯ menu as Stop dwarf…, which confirms first; Boost, which no provider
 * supports, is not drawn (screens/message.md, W4·6). The portraits beside each bubble are gone:
 * the design draws none. The file chips drop their thumbnails for the design's pill.
 *
 * ## Two things it deliberately does not do
 *
 * It never clears the question or permission card on its own, for the reason DwarfQuestionCard
 * states at length: only main's next snapshot may drop a `pendingQuestion` or a
 * `pendingPermission`. And it does not yank a reader to the bottom when a row arrives
 * (lib/message/listScroll): only their own sent message chases them down.
 */

const props = defineProps<{
  dwarf: Dwarf
  /**
   * The dwarf was seen with a channel for text earlier in this app run and has none now: its
   * delivery route went away (#635, decision log, Copy alone on a closed session). Only the
   * host's store, which watched the board over time, can know it; unset, a dwarf with no channel
   * is a session type with none yet.
   */
  routeGone?: boolean
  /**
   * The transcript read for this dwarf. Undefined while the read is in flight, which is its own
   * answer rather than an empty one (see conversationOf).
   */
  feed?: DwarfFeedResult
  /**
   * The one line to say about paging back through this conversation (#364) — that a page is being
   * read, that this is where it begins, or that it cannot be paged at all. Absent means nothing
   * has been asked for. The words belong to lib/message/feedPages.
   */
  pagingNote?: string
  sendState?: DwarfSendState
  /**
   * The messages this panel has sent and the transcript has yet to carry (#309), oldest first —
   * each with its own verdict, so a bubble can show what happened to the words it holds.
   */
  echoes?: readonly MessageEcho[]
  /** The files each of those messages was sent with, by echo id (#408). */
  echoAttachments?: Readonly<Record<string, readonly DwarfAttachment[]>>
  kickState?: DwarfKickState
  /**
   * The verdict of the last answer or decision given for this dwarf, whatever prompt it named (see
   * DwarfQuestionCard and DwarfPermissionCard).
   */
  answerState?: DwarfAnswerState
  /**
   * The half-written message its host keeps for this dwarf (#635; decision log, Drafts per
   * dwarf). The panel is mounted per dwarf, so a draft held here would go with a switch; it is
   * taken once, on mount, and every change to it is reported back as `draft`.
   */
  draft?: string
  /**
   * Take the keyboard as it opens (#409; screens/message.md, As built, Focus: "a chat opened in
   * any mode takes focus one frame after it opens"). The host's to say, because opening is the
   * host's: the dock opens a chat on a selection, and a panel drawn only to be looked at, as the
   * UI kit draws its states, is not opened on anybody's behalf.
   */
  focusOnOpen?: boolean
}>()

const emit = defineEmits<{
  /**
   * `attachments` is present only when there are some (#408), so a text-only message emits the
   * exact payload it always did.
   */
  send: [payload: { text: string; pressEnter: boolean; attachments?: readonly DwarfAttachment[] }]
  kick: []
  close: []
  /** One of the agent's own option labels, or one value per question (#443, see AskAnswer). */
  answer: [answer: AskAnswer]
  /** An answer in the person's own words, for the picker's own "Other" row (#481). */
  'answer-text': [text: string]
  /** One of Claude Code's own two answers to a permission prompt (#203). */
  decide: [decision: DwarfPermissionDecision]
  /**
   * Retry a failed message (#309, #635): re-send it in place, by its own echo id, never the text,
   * so the retry cannot land on another bubble.
   */
  retry: [echoId: string]
  /** Copy a failed message's words, exactly as written, to the clipboard (#635). */
  copy: [text: string]
  /** Focus this session's console: the header's Console tool and the ⋯ menu's Open console. */
  'open-console': []
  /** The mine history, which opens in the dock's slot in place of this panel (#635). */
  history: []
  /** An `edit`/`read` activity line's own path was pressed (#279): its exact target. */
  'open-path': [target: string]
  /** A link inside a bubble was pressed (#347): the address exactly as the transcript wrote it. */
  'open-link': [href: string]
  /** The reader has scrolled back to the oldest row this panel holds (#364). */
  'page-back': []
  /** The composer's text changed, for the host that keeps the draft (#635). */
  draft: [text: string]
}>()

const message = ref(props.draft ?? '')
watch(message, (text) => emit('draft', text))

const conversation = computed(() => conversationOf(props.dwarf, props.feed))

/**
 * The panel's claim about these rows, with whatever there is to say about paging in front of it
 * (#364) — two true statements about the same rows (`HELD_NOTE` against `OBSERVED_NOTE`, #436).
 */
const note = computed(() =>
  props.pagingNote === undefined
    ? conversation.value.note
    : `${props.pagingNote} ${conversation.value.note}`
)

/*
 * The note the log prints as a line of its own (`.dm-msg__note`): only when it says something
 * the rows cannot — nothing read yet, nothing said, no transcript, the session ended, or where
 * paging stands. The routine claim about where the rows came from is not drawn in the design; it
 * stays on the log's own title, so it is still one hover away.
 */
const shownNote = computed(() => {
  if (conversation.value.messages.length === 0) return note.value
  if (props.pagingNote !== undefined) return note.value
  return conversation.value.note.startsWith(ENDED_NOTE) ? ENDED_NOTE : null
})

/** The meta chips under the name: provider · model · effort, and the worktree. */
const chips = computed(() => messagePanelChips(props.dwarf))
/*
 * The clock the outcome line's idle time reads (decision log, Turn outcome line: "idle for 41m"),
 * a second at a time so it never lags the silence the dwarf tooltip counts the same way.
 */
const now = ref(Date.now())
const clock = setInterval(() => {
  now.value = Date.now()
}, 1_000)
onUnmounted(() => clearInterval(clock))
/** The header portrait wears the dwarf's state, as the scene does. */
const portraitStatus = computed(() => sceneDwarfStatus(props.dwarf))

const transient = computed(() => ({ kicking: isKicking.value }))
const actions = computed(() => buildActionBar(props.dwarf, transient.value))
/*
 * Why a disabled composer is disabled, said where the design says it: the composer's own hint
 * (#217). Which sentence it is belongs to lib/delivery/actionBar.
 */
const refusal = computed(() => refusalLine(props.dwarf))
/*
 * Where a permission dialog this panel cannot answer is being held open, and therefore where the
 * person has to go (#203). Its own line above the composer: nothing is refused, the session
 * simply has a dialog up somewhere else.
 */
const approval = computed(() => approvalNote(props.dwarf))
function action(id: 'kick' | 'boost' | 'chat') {
  return actions.value.find((entry) => entry.id === id)
}

// Off the capability model rather than off `textDelivery` directly: a leaving
// dwarf still carries the channel it had, and the model is what knows the
// session behind it has ended (#192).
const canReceive = computed(() => action('chat')?.enabled === true)
/*
 * A session that can no longer take text: it ended, or its route went away (decision log, Copy
 * alone on a closed session). One fact for the composer and the failed bubbles alike, so the
 * closed well and a failed message's Copy alone can never disagree.
 */
const closed = computed(() => sessionClosed(props.dwarf, props.routeGone === true))
/*
 * The box's tooltip: the capability model's reason, except where the route went away — the
 * model sees only a dwarf with no channel and would say the no-channel sentence, which is never
 * said of a closed session. An ended session keeps saying it has ended.
 */
const composerTitle = computed(() =>
  props.routeGone === true && !canReceive.value ? SESSION_CLOSED_REASON : action('chat')?.hint
)
const isSending = computed(() => props.sendState?.phase === 'sending')
const isKicking = computed(() => props.kickState?.phase === 'kicking')

/**
 * The composer (#409, #635): the shell window takes the keyboard on the press that selected the
 * dwarf (raisePanelWindow in main), and this is which control inside it gets it.
 */
const composerRef = ref<HTMLElement | null>(null)

/*
 * Whether THIS render draws the ordinary composer rather than one of the two cards that take its
 * slot instead (#203).
 */
const showsComposer = computed(
  () => props.dwarf.pendingPermission === undefined && props.dwarf.pendingQuestion === undefined
)

/** Hand the composer the keyboard, once Vue has actually drawn it (#409). */
async function focusComposer(): Promise<void> {
  await nextTick()
  composerRef.value?.querySelector('textarea')?.focus()
}

/** The slot the composer and the question card share, at the foot of the panel. */
const bottomRef = ref<HTMLElement | null>(null)

/*
 * Hand the question card's first option the keyboard (#635; accessibility.md, Focus: "the
 * composer's field, or the question card's first option while the dwarf waits on you").
 */
async function focusCard(): Promise<void> {
  await nextTick()
  bottomRef.value?.querySelector<HTMLElement>('.dm-qcard .dm-qopt')?.focus()
}

/*
 * The panel is keyed by dwarf id (App.vue, the dock slot), so MOUNTING is the moment a person
 * selected one. Never on a control the panel is already explaining as dead (#217).
 */
onMounted(() => {
  if (!props.focusOnOpen) return
  if (showsComposer.value && canReceive.value) void focusComposer()
  else if (!showsComposer.value) void focusCard()
})

/*
 * Attachments in the composer (#408), per MOUNT, which is per dwarf: moving to another dwarf
 * takes the pending files with it rather than carrying somebody else's drop into a new
 * conversation.
 */
const pending = ref<readonly DwarfAttachment[]>([])
/** Whether a drag is over the composer, for its active edge. */
const dragging = ref(false)
/** The one sentence a refused file left behind, cleared by the next attempt. */
const attachRefusal = ref<string | null>(null)

/** Whether this dwarf's channel can carry a file at all — a capability, not a guess. */
const canAttach = computed(() => canReceive.value && props.dwarf.capabilities?.attach != null)
const attachTitle = computed(() => attachHint(props.dwarf))

/* --- Message length (#431) — one block, appended -------------------------- */

/**
 * How much of a message this dwarf's own route can carry, and whether what is in the box is past
 * it (#431). The box holds whatever the person put in it, the hint says it will not fit, and
 * Enter does nothing until they have trimmed it. The number comes off the CAPABILITY, because main
 * is what decides how much a route carries.
 */
const textLimit = computed(
  () => props.dwarf.capabilities?.maxTextChars ?? maxTextCharsFor(props.dwarf.textDelivery ?? null)
)

/** The refusal, or null while the message fits — measured on the TRIMMED text, as main measures it. */
const tooLong = computed(() => {
  const length = message.value.trim().length
  if (length <= textLimit.value) return null
  return messageTooLongReason(length, textLimit.value, props.dwarf.textDelivery ?? null)
})
/* --- end of the #431 block ------------------------------------------------ */

function attachmentsOfEcho(echoId: string): readonly DwarfAttachment[] {
  return props.echoAttachments?.[echoId] ?? []
}

/**
 * Take what main said about a set of paths, and say what was refused — the one place a file
 * becomes pending, so the drop and the picker cannot grow separate rules.
 */
function absorb(picks: readonly DwarfAttachmentPick[]): void {
  const result = acceptAttachments(pending.value, picks)
  pending.value = result.attachments
  attachRefusal.value = result.refusal
}

/** Ask main what these paths are, and absorb the answer. Empty input asks nothing. */
async function describeAndAbsorb(paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return
  try {
    absorb(await window.api.describeDwarfAttachments(paths))
  } catch {
    // The bridge is the only thing that can fail here, and a file that vanished
    // without a word is exactly what this line exists to prevent.
    attachRefusal.value = ATTACH_LOST_CONTACT
  }
}

function onDragOver(): void {
  dragging.value = true
}

async function onDrop(event: DragEvent): Promise<void> {
  dragging.value = false
  // Refused here rather than after asking main, so a channel that cannot carry
  // a file never reads one: the sentence is the control's own.
  if (!canAttach.value) {
    attachRefusal.value = attachTitle.value
    return
  }
  const files = [...(event.dataTransfer?.files ?? [])]
  // `webUtils` in preload is the only thing that can turn a dropped File into a
  // path; a File carrying none — a drag out of a web page — answers '' and is
  // dropped rather than guessed at.
  const paths = files
    .map((file) => window.api.pathForDroppedFile(file))
    .filter((path) => path !== '')
  await describeAndAbsorb(paths)
}

async function onAttachClick(): Promise<void> {
  if (!canAttach.value) return
  const chosen = await window.api.chooseDwarfAttachments()
  await describeAndAbsorb(chosen)
  // The OS dialog took the keyboard; the person's next act is typing (#409).
  await focusComposer()
}

function removeAttachment(path: string): void {
  pending.value = pending.value.filter((item) => item.path !== path)
  attachRefusal.value = null
}

/** Forget every pending file. */
function clearAttachments(): void {
  pending.value = []
  attachRefusal.value = null
}

/*
 * A permission or question card is the one thing that takes the composer's OWN slot away (#203),
 * and main's next snapshot is what gives it back — never this component. That moment earns the
 * same focus the mount gives the first selection.
 */
watch(showsComposer, (shows) => {
  if (shows && canReceive.value) void focusComposer()
  // A card taking a focused composer's place takes its focus too: keyboard focus is never
  // dropped to the page (accessibility.md, Focus). Read before the composer leaves the DOM.
  else if (!shows && composerRef.value?.contains(document.activeElement)) void focusCard()
})

/** One row of the conversation as this panel draws it, with its own delivery mark (#309). */
type Row = PanelRow & { mark?: BubbleMark }

/*
 * The transcript's rows, each with the mark a prompt in the transcript wears (#635): the person's
 * words there were handed to the session, so they are at least ✓, and ✓✓ once the session was seen
 * acting after them — historyMarks, the history's own reading of the same record. The dwarf's own
 * words carry no mark.
 */
const rows = computed<Row[]>(() => {
  const messages = conversation.value.messages
  const marks = historyMarks(
    messages.map((row) => ({ ...row, author: { role: 'worker' as const, name: '' }, time: '' }))
  )
  return messages.map((row, i) => {
    const mark = marks[i]
    return mark === undefined ? row : { ...row, mark: HISTORY_MARK[mark] }
  })
})

/*
 * The messages the person just sent, as their own rows (#309), each with the mark its own verdict
 * earns — from the SAME function the sprite marker reads (#21).
 */
const echoRows = computed<Row[]>(() =>
  echoRowsOf(props.echoes ?? []).map((row) => {
    const marker = sendMarker(row.echo?.state)
    return {
      ...row,
      ...(row.echo === undefined ? {} : { at: row.echo.sentAt }),
      ...(marker === null ? {} : { mark: bubbleMark(marker) })
    }
  })
)

/*
 * A run grows only while the dwarf's turn is still going (runsHaveEnded), and the person's own
 * words, the echoes appended after the grouping included, never close it (#294, #635).
 */
const entries = computed(() =>
  mergeEchoes(groupActivity(rows.value, { ended: runsHaveEnded(props.dwarf) }), echoRows.value)
)

/** The turn outcome line under the header, with its status square, counting the run it reads. */
const outcome = computed(() =>
  messagePanelOutcome(props.dwarf, countedRunSteps(entries.value), now.value)
)

/** A row as the log draws it: a day divider, a run of steps, or something said. */
type DrawnEntry = PanelEntry<Row> | { kind: 'day'; key: string; label: string }

/*
 * The entries with a day divider in front of each day's first message (`.dm-msg__day`): TODAY for
 * today, as the design draws it over its whole sample conversation. A row the transcript gave no
 * time starts no day.
 */
const drawnEntries = computed<DrawnEntry[]>(() => {
  const now = Date.now()
  const drawn: DrawnEntry[] = []
  let lastDay: string | null = null
  for (const entry of entries.value) {
    const at = entry.kind === 'message' ? entry.message.at : entry.rows[0]?.at
    const label = at === undefined ? null : dayLabel(at, now)
    if (label !== null && label !== lastDay) {
      drawn.push({ kind: 'day', key: 'day-' + entry.key, label })
      lastDay = label
    }
    drawn.push(entry)
  }
  return drawn
})

/*
 * Which message rows arrive on THIS render (#566 T4b, `.dm-bubble.is-new` since #635) — a genuine
 * arrival at the tail, never the rows the reader was already looking at, and never a page paged
 * in ahead of them (#430), which `rowsWerePrepended` tells apart from a wholesale swap.
 */
let previousRowsForArrival = rows.value
let previousEntryKeys = entries.value.map((entry) => entry.key)
const arrivedKeys = ref<ReadonlySet<string>>(new Set())

watch(
  entries,
  (next) => {
    const nextKeys = next.map((entry) => entry.key)
    const paged = rowsWerePrepended(previousRowsForArrival, rows.value)
    arrivedKeys.value = paged ? new Set() : tailArrivals(previousEntryKeys, nextKeys)
    previousRowsForArrival = rows.value
    previousEntryKeys = nextKeys
  },
  { flush: 'pre' }
)

/*
 * Which runs this reader has unfolded, by group key — per group, and per MOUNT: closing the panel
 * and opening it again is a fresh reading. A group's key is its first line's, so a new run cannot
 * inherit an older one's state.
 */
const openRuns = ref<Record<string, true>>({})

function isRunOpen(key: string): boolean {
  return openRuns.value[key] === true
}

function toggleRun(key: string): void {
  if (isRunOpen(key)) {
    delete openRuns.value[key]
    return
  }
  openRuns.value[key] = true
}

/** A run's steps as the disclosure lists them: a read or edit step opens its own path (#279). */
function activityLines(lines: readonly Row[]) {
  return lines.map((line) => ({
    key: line.key,
    text: line.text,
    ...(line.activity && isOpenablePath(line.activity) ? { target: line.activity.target } : {})
  }))
}

/**
 * The success lines say whether the action was merely handed over or actually reacted to (#21);
 * a failure carries its own reason verbatim.
 */
const sendLine = computed(() => sendStatusLine(props.sendState))
const kickLine = computed(() => kickStatusLine(props.kickState))
const statusLine = computed(() => sendLine.value ?? kickLine.value)
const alertLine = computed(() => {
  // Ahead of both verdicts (#431): the only one about what is in the box RIGHT NOW.
  if (tooLong.value !== null) return tooLong.value
  if (props.sendState?.phase === 'failed') {
    return props.sendState.error ?? 'The message could not be delivered.'
  }
  if (props.kickState?.phase === 'failed') {
    return props.kickState.error ?? 'The kick could not be delivered.'
  }
  // A file the composer just refused speaks in the same ink and the same line (#408).
  return attachRefusal.value
})

/*
 * The composer's hint (`.dm-composer__hint`), which since #635 is also where the panel says what
 * its old rows under the composer said, one at a time: what is wrong with the text in the box or
 * with the last delivery (an alert), then what the last send or kick did — the newer fact, and
 * one that expires on its own — and then why the composer cannot receive. With none of those,
 * the keyboard hint.
 */
const hint = computed(
  () =>
    alertLine.value ??
    statusLine.value ??
    // A closed session's reason is in the well, and the hint under it stays the keyboard's, as
    // the design's composer hint always reads (screens/message.md, Copy alone on a closed session).
    (canReceive.value || closed.value ? null : refusal.value)
)

/** Send wakes once there is something to send and a session to send it to. */
const canSend = computed(
  () =>
    (message.value.trim() !== '' || pending.value.length > 0) &&
    !isSending.value &&
    canReceive.value &&
    tooLong.value === null
)

/*
 * Open on the LATEST message: the design orders a transcript oldest first. Only on mount, never
 * on a new message — the panel must not yank a reader to the bottom mid-sentence.
 */
const conversationRef = ref<HTMLElement | null>(null)

async function showLatest(): Promise<void> {
  await nextTick()
  // One frame after the panel is built (screens/message.md, As built): the host lays the panel
  // out in that frame — the dock's slot, a kit's framing — and a scroll set before it lands on a
  // box that is not the one the reader gets.
  await new Promise<void>((resolve) =>
    typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => resolve()) : resolve()
  )
  const list = conversationRef.value
  if (list === null) return
  list.scrollTop = list.scrollHeight
}

onMounted(showLatest)

/*
 * The row list growing on its own — a re-read landing, or the poll finding new activity. Two
 * watchers, because the decision needs a metric from BEFORE Vue patches the new rows in and a
 * write AFTER it has; lib/message/listScroll is the rule (#195). A page of older conversation
 * (#364) takes the other write, adding its height back to the scroll.
 */
let pendingStickToBottom = false
let pendingPrepend = false
let scrollHeightBeforePatch = 0

watch(rows, (next, previous) => {
  const list = conversationRef.value
  if (list === null) return
  pendingStickToBottom = shouldStickToBottom(
    list.scrollTop,
    list.clientHeight,
    list.scrollHeight,
    STICK_TO_BOTTOM_TOLERANCE_PX
  )
  pendingPrepend = rowsWerePrepended(previous ?? [], next)
  scrollHeightBeforePatch = list.scrollHeight
})

watch(
  rows,
  () => {
    const list = conversationRef.value
    if (list === null) return
    if (pendingPrepend) {
      pendingPrepend = false
      list.scrollTop = scrollTopAfterPrepend(
        list.scrollTop,
        scrollHeightBeforePatch,
        list.scrollHeight
      )
      return
    }
    list.scrollTop = nextScrollTop(list.scrollTop, list.scrollHeight, pendingStickToBottom)
  },
  { flush: 'post' }
)

/**
 * Report that the reader has run out of conversation to scroll back through (#364). Nothing is
 * throttled here: the store that answers refuses a second read while one is in flight.
 */
function onConversationScroll(): void {
  const list = conversationRef.value
  if (list === null) return
  if (!reachedTopOfList(list.scrollTop, TOP_OF_LIST_TOLERANCE_PX)) return
  emit('page-back')
}

/*
 * A message the person just sent is the one row the panel DOES chase them down for (#309), keyed
 * on the newest echo's ID so a tick changing on a bubble already on screen moves nothing.
 */
watch(
  () => props.echoes?.at(-1)?.id,
  (echoId) => {
    if (echoId !== undefined) void showLatest()
  }
)

function submit(): void {
  const text = message.value.trim()
  const attachments = pending.value
  // Words, files, or both — only nothing at all is refused (#408).
  if ((text === '' && attachments.length === 0) || isSending.value || !canReceive.value) return
  // Nothing is sent past the route's own ceiling, and the text is KEPT (#431).
  if (tooLong.value !== null) return
  // Always with the session's own Enter: Enter sends, and the panel has no second control to say
  // otherwise.
  emit('send', {
    text,
    pressEnter: true,
    ...(attachments.length === 0 ? {} : { attachments })
  })
  message.value = ''
  clearAttachments()
}

/** Enter sends, Shift+Enter writes a newline — the convention every composer here uses. */
function onInputKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey) return
  // An input method's own Enter picks its candidate; the text is not written yet (#635).
  if (belongsToComposition(event)) return
  event.preventDefault()
  submit()
}

/** The ⋯ menu: Open console, Mine history, and Stop dwarf…, which confirms first. */
const menu = computed(() => messagePanelMenu(action('kick')?.enabled === true))
const stopAsked = ref(false)

function onMenu(index: number): void {
  if (index === MENU_CONSOLE) emit('open-console')
  else if (index === MENU_HISTORY) emit('history')
  else if (index === MENU_STOP) stopAsked.value = true
}

/**
 * Stop dwarf… is the kick (#293), moved out of the composer into the ⋯ menu and confirmed first
 * (screens/message.md, W4·6). What the kick DOES still varies, and the action model decides it:
 * a session with an interrupt channel has its turn cut short, and one nothing can interrupt has
 * its dwarf dismissed from the board.
 */
function onStopAction(index: number): void {
  stopAsked.value = false
  if (index !== 1) return
  if (action('kick')?.enabled !== true) return
  emit('kick')
}
</script>

<template>
  <section
    class="dm-msg m-mat m-raised"
    role="dialog"
    :aria-label="`Chat with ${dwarf.name}`"
    :data-dwarf="dwarf.id"
    @keydown.escape="emit('close')"
    @click.stop
  >
    <!--
      The header (screens/message.md, W4·1). It does not drag and a double-click does nothing:
      the panel is anchored in every mode. The name renames the dwarf in place once the dwarf
      names slice lands; until then it is the title and nothing else.
    -->
    <header class="dm-msg__head">
      <DwarfPortrait
        :role="dwarf.role"
        :status="portraitStatus"
        :aria-label="sceneDwarfLabel(dwarf.name, portraitStatus)"
      />
      <div class="dm-msg__who">
        <h2 class="dm-msg__name">
          <span class="dm-msg__rename">{{ dwarf.name }}</span>
        </h2>
        <div class="dm-msg__chips">
          <MetaChip v-for="chip in chips" :key="chip" :text="chip" />
        </div>
      </div>
      <div class="dm-msg__tools">
        <ActionButton icon="history" size="sm" title="Mine history" @click="emit('history')" />
        <ActionButton
          class="dm-msg__console"
          icon="console"
          size="sm"
          title="Open console"
          @click="emit('open-console')"
        />
        <MenuButton :items="menu" size="sm" title="More" @pick="onMenu" />
        <span class="dm-m-rule"></span>
        <ActionButton
          class="dm-msg__close"
          icon="close"
          size="sm"
          title="Close chat"
          @click="emit('close')"
        />
      </div>
    </header>

    <!--
      How the dwarf's turn stands (W4·2), with the status square the design adds: what a turn
      concluded and whether a message was delivered or reacted to are two different facts
      (AGENTS.md), and this line never borrows the other's words.
    -->
    <div class="dm-msg__outcome" :data-status="outcome.status" role="status">
      <i></i>
      <span>{{ outcome.text }}</span>
    </div>

    <!-- The conversation (W4·3). It scrolls inside the panel, whose height the dock sets. -->
    <div
      ref="conversationRef"
      class="dm-msg__log"
      role="log"
      :aria-label="`Conversation with ${dwarf.name}`"
      aria-live="polite"
      :title="note"
      tabindex="0"
      @scroll="onConversationScroll"
    >
      <p v-if="shownNote !== null" class="dm-msg__note">{{ shownNote }}</p>
      <template v-for="entry in drawnEntries" :key="entry.key">
        <p v-if="entry.kind === 'day'" class="dm-msg__day">{{ entry.label }}</p>
        <ActivityDisclosure
          v-else-if="entry.kind === 'activity'"
          :label="entry.closed ? activityStepsLabel(entry.rows.length) : entry.label"
          :open="isRunOpen(entry.key)"
          :lines="activityLines(entry.rows)"
          @toggle="toggleRun(entry.key)"
          @open-path="emit('open-path', $event.target)"
        />
        <ChatBubble
          v-else
          :from="entry.message.from"
          :text="entry.message.text"
          :time="entry.message.at === undefined ? undefined : historyClock(entry.message.at)"
          :mark="entry.message.mark"
          :is-new="arrivedKeys.has(entry.key)"
          :offers-retry="entry.message.echo !== undefined && canReceive"
          :session-closed="entry.message.echo !== undefined && (closed || !canReceive)"
          @open-link="emit('open-link', $event)"
          @retry="entry.message.echo && emit('retry', entry.message.echo.id)"
          @copy="emit('copy', entry.message.text)"
        >
          <!--
            What the message was sent WITH (#408): the same pills, without their remove control —
            a message already handed over is not something an edit can be taken out of.
          -->
          <ul
            v-if="entry.message.echo && attachmentsOfEcho(entry.message.echo.id).length > 0"
            class="dm-msg__files"
          >
            <li
              v-for="item in attachmentsOfEcho(entry.message.echo.id)"
              :key="item.path"
              class="dm-composer__file"
              :title="item.name"
            >
              <PixelIcon name="attach" />
              <span>{{ item.name }}</span>
            </li>
          </ul>
        </ChatBubble>
      </template>
    </div>

    <div ref="bottomRef" class="dm-msg__bottom">
      <!--
        A dialog this panel cannot answer, and the way to the one place that can (#203): the
        composer below still takes a message, and this says the session will not read it until the
        dialog is dealt with.
      -->
      <p v-if="approval" class="dm-msg__approval" role="status">
        <span>{{ approval }}</span>
        <ActionButton
          variant="link"
          :label="JUMP_TO_TERMINAL_NAME"
          :title="CONSOLE_HINT"
          @click="emit('open-console')"
        />
      </p>
      <!--
        A permission prompt REPLACES the composer first, ahead of an ordinary ask, because it is the
        tool call this held session is blocked INSIDE right now (#203); an ask replaces it otherwise
        (W4·7). Neither is ever behind a toggle, because each is the reason the dwarf was clicked.
      -->
      <DwarfPermissionCard
        v-if="dwarf.pendingPermission"
        class="dm-msg__ask"
        :permission="dwarf.pendingPermission"
        :name="dwarf.name"
        :answer-state="answerState"
        @decide="emit('decide', $event)"
        @send-text="emit('send', $event)"
        @open-console="emit('open-console')"
      />
      <DwarfQuestionCard
        v-else-if="dwarf.pendingQuestion"
        class="dm-msg__ask"
        :question="dwarf.pendingQuestion"
        :name="dwarf.name"
        :answer-state="answerState"
        @answer="emit('answer', $event)"
        @answer-text="emit('answer-text', $event)"
        @send-text="emit('send', $event)"
        @open-console="emit('open-console')"
      />
      <!--
        The composer (W4·4, `molecules/composer`): Attach on the left and Send as the one primary
        button on the right. Dropping files anywhere on it attaches them (#408); `preventDefault`
        on both dragover and drop is the whole of the navigation guard — a file dropped on a page
        the browser may navigate REPLACES that page.
      -->
      <div
        v-else
        ref="composerRef"
        class="dm-composer"
        :class="{ 'is-dragging': dragging }"
        @dragover.prevent="onDragOver"
        @dragleave="dragging = false"
        @drop.prevent="onDrop"
      >
        <div class="dm-composer__files">
          <span
            v-for="item in pending"
            :key="item.path"
            class="dm-composer__file"
            :title="item.name"
          >
            <PixelIcon name="attach" />
            <span>{{ item.name }}</span>
            <button
              type="button"
              :aria-label="`Remove ${item.name}`"
              @click="removeAttachment(item.path)"
            >
              <PixelIcon name="close" />
            </button>
          </span>
        </div>
        <div class="dm-composer__row">
          <ActionButton
            class="dm-composer__attach"
            icon="attach"
            :title="canAttach ? 'Attach a file' : attachTitle"
            :disabled="!canAttach"
            @click="onAttachClick"
          />
          <InputField
            area
            :rows="2"
            :placeholder="closed ? SESSION_CLOSED_REASON : `Write to ${dwarf.name}…`"
            label="Message"
            :value="message"
            :disabled="!canReceive"
            :title="composerTitle"
            @update:value="message = $event"
            @keydown="onInputKeydown"
          />
          <ActionButton
            class="dm-composer__send"
            variant="primary"
            icon="send"
            label="Send"
            :disabled="!canSend"
            @click="submit"
          />
        </div>
        <p
          class="dm-composer__hint"
          :class="{ 'is-error': alertLine !== null }"
          :role="alertLine !== null ? 'alert' : hint !== null ? 'status' : undefined"
        >
          {{ hint ?? COMPOSER_HINT }}
        </p>
      </div>
    </div>

    <ModalDialog
      :open="stopAsked"
      :title="stopDwarfTitle(dwarf.name)"
      danger
      :actions="[{ label: 'Cancel' }, { label: 'Stop dwarf', variant: 'danger' }]"
      @action="onStopAction"
      @cancel="stopAsked = false"
    >
      <p>{{ STOP_DWARF_BODY }}</p>
      <!--
        What stopping THIS session actually does, in the capability model's own words (#383): an
        interrupt channel cuts the turn short, and a session nothing can interrupt has its dwarf
        dismissed. Said beside the design's sentence rather than instead of it.
      -->
      <p v-if="action('kick')?.hint">{{ action('kick')?.hint }}</p>
    </ModalDialog>
  </section>
</template>

<style scoped>
/* The design's message-panel.css, rule for rule. */
.dm-msg {
  --mat-fill: var(--wood);
  --mat-hi: var(--wood-hi);
  --mat-lo: var(--wood-lo);
  --mat-edge: var(--rock-lo);
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr) auto;
  width: 440px;
  max-width: 100%;
  height: 100%;
  min-height: 0;
  text-align: left;
}
.dm-msg__head {
  display: flex;
  gap: 8px;
  padding: 6px 4px 6px 6px;
  background: var(--wood-lo);
  box-shadow: inset 0 -2px 0 0 var(--rock-lo);
  align-items: center;
}
.dm-msg__who {
  flex: 1;
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 2px;
  contain: inline-size;
}
.dm-msg__name {
  min-width: 0;
  margin: 0;
  font: var(--fs-title) / 1 var(--f-display);
  color: var(--parchment);
}
.dm-msg__rename {
  display: block;
  width: fit-content;
  max-width: 100%;
  padding-right: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}
.dm-msg__chips {
  display: flex;
  gap: 0 2px;
  margin-left: -2px;
  flex-wrap: wrap;
}
.dm-msg__chips :deep(.dm-meta) {
  display: block;
  line-height: 20px;
}
.dm-msg__tools {
  display: flex;
  align-items: center;
}
.dm-msg__tools .dm-m-rule {
  width: 2px;
  height: 24px;
  margin: 0 4px;
  background: var(--rock-lo);
  box-shadow: 2px 0 0 0 var(--wood);
}
.dm-msg__outcome {
  display: flex;
  gap: 6px;
  padding: 6px 10px;
  font: var(--fs-meta) / 1.2 var(--f-meta);
  color: var(--ink-soft);
  box-shadow: inset 0 -2px 0 0 var(--wood-lo);
  align-items: center;
}
.dm-msg__outcome[data-status='asking'] {
  color: var(--brass);
}
.dm-msg__outcome i {
  width: 6px;
  height: 6px;
  flex: none;
  background: var(--ok);
  box-shadow: 0 0 0 2px var(--rock-lo);
}
.dm-msg__outcome[data-status='asking'] i {
  background: var(--brass);
}
.dm-msg__outcome[data-status='asleep'] i {
  background: var(--steel-lo);
}
.dm-msg__log {
  display: grid;
  gap: 6px;
  padding: 10px 8px;
  background: var(--rock);
  box-shadow: inset 2px 2px 0 0 var(--rock-lo);
  align-content: start;
  overflow-y: auto;
  scrollbar-gutter: stable;
}
.dm-msg__day {
  margin: 0;
  padding: 4px 0;
  font: var(--fs-meta) / 1.2 var(--f-meta);
  letter-spacing: 0.04em;
  color: var(--ink-faint);
  justify-self: center;
}
/* What the rows cannot say themselves, in the note face the history's own notes use. */
.dm-msg__note {
  margin: 0;
  font: var(--fs-meta) / 1.3 var(--f-meta);
  color: var(--ink-faint);
  justify-self: center;
  text-align: center;
}
.dm-msg__files {
  display: flex;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.dm-msg__bottom {
  background: var(--wood);
  box-shadow: inset 0 2px 0 0 var(--wood-hi);
}
.dm-msg__approval {
  display: flex;
  gap: 6px;
  margin: 0;
  padding: 6px 10px 0;
  font: var(--fs-meta) / 1.3 var(--f-meta);
  color: var(--ink-soft);
  align-items: center;
  flex-wrap: wrap;
}

/* The design's composer.css. */
.dm-composer {
  display: grid;
  gap: 4px;
  padding: 6px 6px 4px;
}
.dm-composer__row {
  display: flex;
  gap: 4px;
  align-items: flex-end;
}
.dm-composer__row :deep(.dm-field) {
  flex: 1;
  min-width: 0;
}
.dm-composer__row :deep(.dm-field textarea) {
  width: 0;
  max-height: 120px;
}
.dm-composer__row :deep(.dm-btn) {
  flex: none;
}
.dm-composer__row :deep(.dm-composer__send) {
  min-height: var(--hit-nav);
}
.dm-composer__hint {
  margin: 0;
  padding: 0 4px;
  font: var(--fs-meta) / 1.2 var(--f-meta);
  color: var(--ink-faint);
}
/* The hint speaking for a refusal, in the error colour the field hints use (atoms/input). */
.dm-composer__hint.is-error {
  color: var(--danger-hi);
}
.dm-composer__files {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
/* A file waiting to go, as the design's pill (`DM.ui.pill` with the attach icon). */
.dm-composer__file {
  display: inline-flex;
  gap: 4px;
  padding: 0 0 0 6px;
  font: var(--fs-meta) / 20px var(--f-meta);
  color: var(--ink-soft);
  background: var(--rock-lo);
  align-items: center;
}
.dm-composer__file button {
  width: 24px;
  height: 20px;
  display: grid;
  place-items: center;
}
/* A drag over the composer lights its well, and nothing else moves. */
.dm-composer.is-dragging :deep(.dm-field) {
  --mat-edge: var(--brass);
}
</style>
