<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import {
  ATTACH_ICON_SRC,
  BOOST_ICON_SRC,
  CLOSE_ICON_SRC,
  KICK_ICON_SRC,
  PORTRAIT_SRC,
  USER_PORTRAIT_SRC,
  maskImageValue
} from '../../lib/art'
import {
  CONSOLE_HINT,
  JUMP_TO_TERMINAL_NAME,
  approvalNote,
  buildActionBar,
  refusalLine
} from '../../lib/delivery/actionBar'
/* --- Message attachments (#408) — one block, appended -------------------- */
import { ATTACH_LOST_CONTACT, acceptAttachments, attachHint } from '../../lib/delivery/attachments'
/* --- end of the #408 block ----------------------------------------------- */
import {
  SEND_AGAIN_LABEL,
  SEND_AGAIN_TITLE,
  kickStatusLine,
  sendMarker,
  sendStatusLine,
  type DeliveryMarker
} from '../../lib/delivery/deliveryVerdict'
import { groupActivity } from '../../lib/message/activityGroup'
import {
  authorOf,
  conversationEnded,
  conversationOf,
  latestText
} from '../../lib/message/conversation'
import { echoRowsOf, mergeEchoes, type MessageEcho, type PanelRow } from '../../lib/message/echo'
import { isOpenablePath } from '../../lib/message/openablePath'
import { turnOutcomeLine } from '../../lib/message/turnOutcome'
import { dwarfWorkplaceLabel } from '../../lib/worktree'
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
  MESSAGE_PANEL_MAX_HEIGHT,
  clampPanelHeight,
  initialPanelHeight
} from '../../lib/message/panelHeight'
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
  type DwarfSendState,
  type MessageIssuer
} from '../../types'
import DwarfPermissionCard from '../dwarf/DwarfPermissionCard.vue'
import DwarfQuestionCard from '../dwarf/DwarfQuestionCard.vue'
import MarkdownBubble from './MarkdownBubble.vue'

/**
 * The design's MessagePanel (#159): the surface a selected dwarf opens at the
 * bottom of the screen, carrying its portrait, the conversation, the input,
 * the history tab and the kick/boost/close controls. It replaces the interim
 * icon action bar entirely, and the question cards (#128) move into the place
 * the design drew for them, directly above the input.
 *
 * Thin, like every component here. Which words may be shown and what the panel
 * claims they are is lib/message/conversation's; the four sizing rules are
 * lib/message/panelHeight's; which controls are live and what a disabled one
 * says is lib/delivery/actionBar's — the capability model the old bar was only
 * ever a rendering of, which is why that module outlived the component.
 *
 * ## Two things it deliberately does not do
 *
 * It does not resize itself when a message arrives. `screens/mine.md` is
 * explicit: the height derives from the latest message when the panel OPENS,
 * and once open new messages leave it alone — a panel that grew under a reader
 * mid-sentence would be worse than one that scrolls, which is exactly why the
 * messages scroll independently.
 *
 * And it never clears the question or permission card on its own, for the
 * reason DwarfQuestionCard states at length: only main's next snapshot may
 * drop a `pendingQuestion` or a `pendingPermission`.
 */

const props = defineProps<{
  dwarf: Dwarf
  /**
   * The transcript read for this dwarf, for a session this panel only
   * OBSERVES. Undefined while the read is in flight, which is its own answer
   * rather than an empty one (see conversationOf).
   */
  feed?: DwarfFeedResult
  /**
   * The one line to say about paging back through this conversation (#364) —
   * that a page is being read, that this is where it begins, or that it cannot
   * be paged at all. Absent means nothing has been asked for.
   *
   * A sentence handed down rather than a state to interpret, like every other
   * claim this panel makes: which of the three is true belongs to
   * `useDwarfPaging`, and the words themselves to `lib/message/feedPages`.
   */
  pagingNote?: string
  sendState?: DwarfSendState
  /**
   * The messages this panel has sent and the transcript has yet to carry
   * (#309), oldest first — each with its own verdict, so a bubble can show
   * what happened to the words it holds rather than to the dwarf.
   *
   * A prop and not a store read, like everything else here: which messages are
   * still pending is the delivery store's decision, and this component only
   * draws them.
   */
  echoes?: readonly MessageEcho[]
  /**
   * The files each of those messages was sent with, by echo id (#408).
   *
   * A second prop rather than a field on `MessageEcho` because that shape
   * belongs to `lib/message/echo`, whose subject is matching the panel's own
   * bubbles against the transcript — a job attachments play no part in. The
   * delivery store holds both, and drops both together.
   */
  echoAttachments?: Readonly<Record<string, readonly DwarfAttachment[]>>
  kickState?: DwarfKickState
  /**
   * The verdict of the last answer or decision given for this dwarf, whatever
   * prompt it named (see DwarfQuestionCard and DwarfPermissionCard) — the two
   * share one store, because a verdict is about a toolUseId either way.
   */
  answerState?: DwarfAnswerState
}>()

const emit = defineEmits<{
  /**
   * `attachments` is present only when there are some (#408), so a text-only
   * message emits the exact payload it always did — an empty array on every
   * message would be a new field for every caller to reason about.
   */
  send: [payload: { text: string; pressEnter: boolean; attachments?: readonly DwarfAttachment[] }]
  kick: []
  close: []
  /** One of the agent's own option labels, once Enter confirmed it. */
  answer: [label: string]
  /**
   * An answer in the person's own words, for the row the session's own picker
   * offers for exactly that (#481). A sibling of `answer` and not of `send`:
   * both release the agent's blocked tool call, and neither is a message.
   */
  'answer-text': [text: string]
  /** One of Claude Code's own two answers to a permission prompt (#203). */
  decide: [decision: DwarfPermissionDecision]
  /**
   * Send a failed message again (#309) — its own echo id, never the text: the
   * same words may be pending twice, and only the store knows which bubble
   * this is.
   */
  'send-again': [echoId: string]
  /** Focus this session's console — where the old bar's fourth icon went. */
  'open-console': []
  /**
   * An `edit`/`read` activity line's own path was clicked (#279) — the exact
   * `FeedActivity.target` string, never the display text. Opening happens in
   * MAIN: this component only reports the click, exactly as `open-console`
   * reports one without itself trying to focus anything.
   */
  'open-path': [target: string]
  /**
   * A link inside a bubble was pressed (#347) — the address exactly as the
   * transcript wrote it, already known to be `http:` or `https:` because
   * nothing else is ever drawn as a link at all.
   *
   * Reported and not opened, for the reason `open-path` is: opening happens in
   * MAIN, which validates the address a second time and owns the only
   * `shell.openExternal` in the app. A renderer's word is never a permission.
   */
  'open-link': [href: string]
  /**
   * The reader has scrolled back to the oldest row this panel holds (#364) —
   * so the page before it is worth fetching.
   *
   * A report and not a request: it carries no cursor, because which row the
   * page is asked for is decided from the wire messages behind these rows (see
   * `feedPageCursorOf`), and a `PanelMessage` has spent its timestamp on a list
   * key. Fired on every scroll that lands at the top, however many times: one
   * read at a time and no read at all once the start is reached are
   * `useDwarfPaging`'s to refuse, exactly as this panel reports a press without
   * deciding whether anything opens.
   */
  'page-back': []
}>()

const message = ref('')
const historyOpen = ref(false)

const conversation = computed(() => conversationOf(props.dwarf, props.feed))

/**
 * The panel's one note row, with whatever there is to say about paging in front
 * of it (#364).
 *
 * Prefixed rather than substituted, exactly as `conversationOf` puts
 * ENDED_NOTE in front of the claim it does not replace: "this is the start of
 * the conversation" and "latest activity, read from this session's own
 * transcript" are two true statements about the same rows, and the second is
 * the one the row exists for.
 */
const note = computed(() =>
  props.pagingNote === undefined
    ? conversation.value.note
    : `${props.pagingNote} ${conversation.value.note}`
)

/*
 * The opening height, taken ONCE. Read during setup and never recomputed: the
 * panel is mounted per selection, so closing and reopening is a fresh mount
 * and therefore a fresh calculation — which is the design's third rule getting
 * itself for free, and its second rule (new messages do not resize) holding
 * because nothing here watches the conversation.
 */
const height = ref(
  initialPanelHeight(
    latestText(conversation.value),
    props.dwarf.pendingQuestion !== undefined || props.dwarf.pendingPermission !== undefined
  )
)
/** The height to give back when the history tab closes again. */
const collapsedHeight = ref(height.value)

/*
 * Which worktree this dwarf is in, beside its name in the header (#348).
 *
 * A mine is a project, and every worktree of that project folds into it — so a
 * crew can be spread over several folders, and the header is where you find
 * out which one you are talking to. Empty for a dwarf working in the mine's own
 * folder, which is most of them; see lib/worktree for branch versus folder.
 */
const workplaceLabel = computed(() => dwarfWorkplaceLabel(props.dwarf.workplace))

/**
 * How the dwarf's last turn ended (#510), directly off the prop already on
 * this panel — no new IPC and no composable, because `Dwarf.lastTurn` rides
 * every snapshot this component already receives. `turnOutcomeLine` is the
 * pure read of what it may say; this component only draws it. Absent for a
 * dwarf that has not finished a turn yet, which is the honest silence rather
 * than a placeholder sentence.
 */
const turnOutcome = computed(() => turnOutcomeLine(props.dwarf.lastTurn))

const transient = computed(() => ({ kicking: isKicking.value }))
const actions = computed(() => buildActionBar(props.dwarf, transient.value))
/*
 * Why a disabled control is disabled, on screen (#217). The `title` attributes
 * below carry the same sentence and always did — a tooltip is a refusal
 * somebody has to go looking for, and the report this comes from is a person
 * meeting a dead composer and a dead kick with nothing said. Which sentence it
 * is belongs to lib/delivery/actionBar, like every other thing this panel says
 * about a capability.
 */
const refusal = computed(() => refusalLine(props.dwarf))
/*
 * Where a permission dialog this panel cannot answer is being held open, and
 * therefore where the person has to go (#203). Its own line rather than the
 * refusal row's: nothing is refused here — the composer still works, the
 * session simply has a dialog up somewhere else — and the row below the
 * composer is for what a control will not do.
 */
const approval = computed(() => approvalNote(props.dwarf))
function action(id: 'kick' | 'boost' | 'chat') {
  return actions.value.find((entry) => entry.id === id)
}

// Off the capability model rather than off `textDelivery` directly: a leaving
// dwarf still carries the channel it had, and the model is what knows the
// session behind it has ended (#192).
const canReceive = computed(() => action('chat')?.enabled === true)
const isSending = computed(() => props.sendState?.phase === 'sending')
const isKicking = computed(() => props.kickState?.phase === 'kicking')

/**
 * The composer text box (#409). Main gives the PANEL WINDOW its OS focus on
 * the same selection (see `setMessagePanel` in `main/shell/window.ts`); this
 * is the other half — which control inside that window gets the keyboard.
 */
const composerRef = ref<HTMLTextAreaElement | null>(null)

/*
 * Whether THIS render draws the ordinary composer rather than one of the two
 * cards that take its slot instead (#203) — the same test the template's
 * v-if/v-else-if/v-else chain makes below, read back here so a permission or
 * question clearing can be told apart from every other prop change.
 */
const showsComposer = computed(
  () => props.dwarf.pendingPermission === undefined && props.dwarf.pendingQuestion === undefined
)

/** Hand the composer the keyboard, once Vue has actually drawn it (#409). */
async function focusComposer(): Promise<void> {
  await nextTick()
  composerRef.value?.focus()
}

/*
 * The panel is keyed by dwarf id (MessagePanelWindow.vue), so MOUNTING is the
 * moment a person selected one. Never on a control the panel is already
 * explaining as dead (#217): focusing a disabled textarea is a no-op, and the
 * refusal line beside it already says why it cannot receive.
 */
onMounted(() => {
  if (showsComposer.value && canReceive.value) void focusComposer()
})

/*
 * Attachments in the composer (#408).
 *
 * Everything here is per MOUNT, which is per dwarf: the panel is keyed by dwarf
 * id, so moving to another dwarf takes the pending files with it rather than
 * carrying somebody else's drop into a new conversation. That is also what
 * releases the previews — they are data URLs main rendered, held nowhere but in
 * these two refs, so a closed panel is a released one with nothing to revoke.
 */
const pending = ref<readonly DwarfAttachment[]>([])
/** The preview for each pending path, when main could draw one. */
const thumbnails = ref<Record<string, string>>({})
/** Whether a drag is over the composer, for the design's active border. */
const dragging = ref(false)
/** The one sentence a refused file left behind, cleared by the next attempt. */
const attachRefusal = ref<string | null>(null)

/** Whether this dwarf's channel can carry a file at all — a capability, not a guess. */
const canAttach = computed(() => canReceive.value && props.dwarf.capabilities?.attach != null)
const attachTitle = computed(() => attachHint(props.dwarf))

/* --- Message length (#431) — one block, appended -------------------------- */

/**
 * How much of a message this dwarf's own route can carry, and whether what is
 * in the box is past it (#431).
 *
 * The box used to carry `:maxlength="MAX_DWARF_TEXT_CHARS"`, which cut a long
 * paste at the end without a word — the first of the two silent applications of
 * a 4,000-character keystroke budget the issue is about, the second being a
 * second cut in `sendDwarfText` that still reported the remainder delivered.
 * The attribute is gone: the box holds whatever the person put in it, the
 * sentence below says it will not fit, and Enter does nothing until they have
 * trimmed it. Their words stay theirs.
 *
 * The number comes off the CAPABILITY rather than from the wire ceiling,
 * because main is what decides how much a route carries and the panel must
 * refuse exactly what main refuses. The routes agreed on one number for one
 * release (#433) and disagree again since #437: a Codex dwarf is told the
 * queue's command-line bound and everybody else the wire's sanity ceiling, so
 * the sentence below names the ROUTE's number rather than the app's.
 * `maxTextCharsFor` is the fallback for a matrix that carries no such member
 * (see DwarfCapabilities.maxTextChars), never a second opinion about a dwarf
 * main has already answered for.
 */
const textLimit = computed(
  () => props.dwarf.capabilities?.maxTextChars ?? maxTextCharsFor(props.dwarf.textDelivery ?? null)
)

/**
 * The refusal, or null while the message fits — measured on the TRIMMED text,
 * which is what `submit` sends and what main measures on the other side of the
 * wire, so the two cannot disagree about a message with trailing newlines.
 */
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
 * Take what main said about a set of paths, and say what was refused.
 *
 * The one place a file becomes pending, so the drop and the picker cannot grow
 * separate rules — which is the issue's "same validation path" in the form the
 * renderer can actually hold it in.
 */
function absorb(picks: readonly DwarfAttachmentPick[]): void {
  const result = acceptAttachments(pending.value, picks)
  pending.value = result.attachments
  attachRefusal.value = result.refusal
  for (const pick of picks) {
    if (pick.thumbnail !== undefined) thumbnails.value[pick.path] = pick.thumbnail
  }
}

/** Ask main what these paths are, and absorb the answer. Empty input asks nothing. */
async function describeAndAbsorb(paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return
  try {
    absorb(await window.api.describeDwarfAttachments(paths))
  } catch {
    // The bridge is the only thing that can fail here, and a file that vanished
    // without a word is exactly what this row exists to prevent.
    attachRefusal.value = ATTACH_LOST_CONTACT
  }
}

function onDragOver(): void {
  dragging.value = true
}

async function onDrop(event: DragEvent): Promise<void> {
  dragging.value = false
  // Refused here rather than after asking main, so a channel that cannot carry
  // a file never reads one: the sentence is the control's own, so a drop and a
  // disabled button say the same thing.
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
  delete thumbnails.value[path]
  attachRefusal.value = null
}

/** Forget every pending file and the previews they held. */
function clearAttachments(): void {
  pending.value = []
  thumbnails.value = {}
  attachRefusal.value = null
}

/*
 * A permission or question card is the one thing that takes the composer's
 * OWN slot away (#203), and main's next snapshot is what gives it back —
 * never this component, on its own initiative (see the module comment). That
 * moment is a second selection in every way that matters here, so it earns
 * the same focus the mount above gives the first one.
 */
watch(showsComposer, (shows) => {
  if (shows && canReceive.value) void focusComposer()
})

/**
 * One row of the conversation as this panel draws it: whatever the transcript
 * (or a pending echo) carried, plus the two things resolved per row here —
 * whose portrait it takes (#175) and, for an echo only, its delivery marker
 * (#309). Named because the two lists below have to be the SAME row type for
 * the echoes to be appended to the entries the rest were grouped into.
 */
type Row = PanelRow & { author: MessageIssuer; marker?: DeliveryMarker | null }

/*
 * Each row with the agent it belongs to already resolved (#175). Usually this
 * dwarf, and for a prompt another agent issued the agent that issued it — which
 * `authorOf` decides, like everything else about who said what here.
 */
const rows = computed<Row[]>(() =>
  conversation.value.messages.map((message) => ({
    ...message,
    author: authorOf(message, props.dwarf)
  }))
)

/*
 * The rows as they are DRAWN: every run of consecutive tool calls folded into
 * one disclosure row under the bubble above it (#294). The rule is
 * lib/message/activityGroup's, like every other decision about what the panel
 * shows; whether the trailing run is still growing is the one fact this
 * component has to supply, and it comes off the board's own reading of the
 * session rather than out of a timer.
 *
 * Deliberately independent of which runs are OPEN: the two stick-to-bottom
 * watchers below watch `rows`, so a reader unfolding a run changes nothing
 * they watch and the list stays exactly where they left it (#195, #243).
 */
/*
 * The messages the person just sent, as their own rows (#309) — the same
 * author treatment every other row gets, so the human's portrait is decided in
 * one place. An echo has no issuer, which is exactly what says the human wrote
 * it (see MessageIssuer).
 */
const echoRows = computed(() =>
  echoRowsOf(props.echoes ?? []).map((row) => ({
    ...row,
    author: authorOf(row, props.dwarf),
    /*
     * The bubble's tick, from the SAME function the sprite marker in the shell
     * reads (#21). Resolved on the row rather than in the template so the
     * glyph, the class and the hover sentence are one reading of one verdict.
     */
    marker: sendMarker(row.echo?.state)
  }))
)

const entries = computed(() =>
  mergeEchoes(groupActivity(rows.value, { ended: conversationEnded(props.dwarf) }), echoRows.value)
)

/*
 * Which runs this reader has unfolded, by group key — per group, and per MOUNT
 * for the reason the opening height is taken once: closing the panel and
 * opening it again is a fresh mount and therefore a fresh reading, and a run
 * left open on a dwarf nobody is looking at is not state worth keeping.
 *
 * Keyed rather than indexed so a new run cannot inherit an older one's state:
 * a group's key is its first line's, which is the one thing about a run that
 * does not move as the run grows.
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

/**
 * The success lines say whether the action was merely handed over or actually
 * reacted to (issue #21); a failure carries its own reason verbatim, in its
 * own alert row.
 */
const sendLine = computed(() => sendStatusLine(props.sendState))
const kickLine = computed(() => kickStatusLine(props.kickState))
const statusLine = computed(() => sendLine.value ?? kickLine.value)
const alertLine = computed(() => {
  // Ahead of both verdicts below (#431), because it is the only one of the
  // three about what is in the box RIGHT NOW: the person is holding text the
  // panel will not send, and a failure from a previous message must not hide
  // the reason Enter is doing nothing.
  if (tooLong.value !== null) return tooLong.value
  if (props.sendState?.phase === 'failed') {
    return props.sendState.error ?? 'The message could not be delivered.'
  }
  if (props.kickState?.phase === 'failed') {
    return props.kickState.error ?? 'The kick could not be delivered.'
  }
  // A file the composer just refused speaks in the same ink and the same row
  // (#408), and yields to a delivery failure above it for the reason that row
  // already orders itself: the message that failed is the newer fact.
  return attachRefusal.value
})

/*
 * Open on the LATEST message. The design orders a transcript oldest first, so
 * an unscrolled panel would open on the message furthest from whatever just
 * happened — and the height it opened at was derived from the newest one.
 *
 * Only on mount and when the history expands, never on a new message: the
 * panel must not yank a reader to the bottom mid-sentence, which is the same
 * reason a new message does not resize it.
 */
const conversationRef = ref<HTMLElement | null>(null)

async function showLatest(): Promise<void> {
  await nextTick()
  const list = conversationRef.value
  if (list === null) return
  list.scrollTop = list.scrollHeight
}

onMounted(showLatest)

/*
 * The row list growing on its own — a re-read landing, or the poll finding
 * new activity — is the case `showLatest` above cannot reach: it only ever
 * runs once, on mount, and mount can easily find nothing yet (App.vue reads a
 * newly-selected dwarf's feed asynchronously, so the first render here is
 * often an empty list). Two watchers rather than one, deliberately, because
 * the decision needs a metric from BEFORE Vue patches the new rows in and a
 * write AFTER it has: `pending` is filled in by the first, on the default
 * ('pre') flush that runs ahead of the render it is watching for, and spent by
 * the second, on the 'post' flush that runs once that render has landed.
 * `lib/message/listScroll` is the actual rule; this is only the plumbing that
 * feeds it real DOM numbers (#195).
 */
let pendingStickToBottom = false
/*
 * The other half of that snapshot, since #364: whether the rows that are about
 * to land go ABOVE everything on screen, and how tall the list was before they
 * did.
 *
 * A page of older conversation is the one growth the rule above cannot decide.
 * A reader who scrolled up is by definition not sticking to the bottom, so its
 * verdict is "leave the scroll alone" — and leaving it alone is not leaving the
 * reader alone at all: the page lands in front of them and slides the sentence
 * they were half-way through down the panel by its own height. So a prepend
 * takes the other write, adding that height back to the scroll in the same
 * tick. `lib/message/listScroll` is the rule for both; this is the plumbing
 * that feeds it real DOM numbers.
 */
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
 * Report that the reader has run out of conversation to scroll back through
 * (#364), so the page before it can be fetched.
 *
 * On the list's own scroll rather than on an observer: the gesture IS a scroll,
 * and the panel already owns this element's scrollTop for the two rules above.
 * Nothing is throttled here — every landing at the top reports, and the store
 * that answers refuses a second read while one is in flight and every read once
 * the start is reached.
 */
function onConversationScroll(): void {
  const list = conversationRef.value
  if (list === null) return
  if (!reachedTopOfList(list.scrollTop, TOP_OF_LIST_TOLERANCE_PX)) return
  emit('page-back')
}

/*
 * A message the person just sent is the one row the panel DOES chase them down
 * for (#309).
 *
 * The rule above is deliberately conservative — a row arriving from the
 * session must not yank a reader mid-sentence — and this is the case it does
 * not cover: the reader is the author, they pressed Enter a moment ago, and a
 * bubble drawn somewhere they cannot see is the same disappearance #309 exists
 * to end. Keyed on the newest echo's ID and nothing else, so a tick changing
 * on a bubble already on screen moves nothing: the verdict is news about a
 * message, not a new message.
 */
watch(
  () => props.echoes?.at(-1)?.id,
  (echoId) => {
    if (echoId !== undefined) void showLatest()
  }
)

function toggleHistory(): void {
  historyOpen.value = !historyOpen.value
  void showLatest()
  if (historyOpen.value) {
    collapsedHeight.value = height.value
    height.value = MESSAGE_PANEL_MAX_HEIGHT
    return
  }
  height.value = collapsedHeight.value
}

/*
 * Vertical only, from the panel's own top edge — the one direction the source
 * allows, and the one gesture a bottom-docked panel has: dragging the edge UP
 * makes it taller, so the delta is subtracted rather than added.
 *
 * Pointer events rather than mouse, so a trackpad, a pen and a touchscreen all
 * work from one handler; the capture keeps the drag alive when the pointer
 * outruns a 6px strip. Nothing here reads clientX, because there is no width
 * for it to change.
 */
const dragFrom = ref<{ y: number; height: number } | null>(null)

function startResize(event: PointerEvent): void {
  dragFrom.value = { y: event.clientY, height: height.value }
  ;(event.target as HTMLElement | null)?.setPointerCapture?.(event.pointerId)
}

function resize(event: PointerEvent): void {
  const from = dragFrom.value
  if (from === null) return
  height.value = clampPanelHeight(from.height + (from.y - event.clientY))
  if (historyOpen.value) collapsedHeight.value = height.value
}

function endResize(): void {
  dragFrom.value = null
}

/** The same resize for a keyboard, which cannot grab a handle at all. */
const KEYBOARD_RESIZE_STEP = 20
function resizeByKey(event: KeyboardEvent): void {
  const step =
    event.key === 'ArrowUp'
      ? KEYBOARD_RESIZE_STEP
      : event.key === 'ArrowDown'
        ? -KEYBOARD_RESIZE_STEP
        : 0
  if (step === 0) return
  event.preventDefault()
  height.value = clampPanelHeight(height.value + step)
  if (historyOpen.value) collapsedHeight.value = height.value
}

function submit(): void {
  const text = message.value.trim()
  const attachments = pending.value
  // Words, files, or both — only nothing at all is refused (#408), which is the
  // same test `sendDwarfText` applies on the other side of the wire.
  if ((text === '' && attachments.length === 0) || isSending.value || !canReceive.value) return
  // Nothing is sent past the route's own ceiling, and the text is KEPT (#431):
  // the alert row is already saying why, and clearing the box would throw away
  // the paste the person now has to trim.
  if (tooLong.value !== null) return
  // Always with the session's own Enter: `screens/mine.md` says Enter sends,
  // and the panel it draws has no second control to say otherwise.
  emit('send', {
    text,
    pressEnter: true,
    // Absent rather than empty, so a text-only message emits exactly the
    // payload it always did and no caller grows a field to read.
    ...(attachments.length === 0 ? {} : { attachments })
  })
  message.value = ''
  clearAttachments()
}

/** Enter sends, Shift+Enter writes a newline — the convention every composer here uses. */
function onInputKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey) return
  event.preventDefault()
  submit()
}

/**
 * One click kicks (#293).
 *
 * It used to arm on the first click and fire on the second, with the button's
 * own name carrying the question ("Confirm kick?"). Nothing in the design asked
 * for that — `screens/mine.md` listed the confirmation under Unspecified — and
 * what it produced in use was a kick that read as not having worked. What the
 * control DOES still varies, and the action model is where that is decided:
 * a session with an interrupt channel has its turn cut short, and one nothing
 * can interrupt has its dwarf dismissed from the board.
 */
function onKick(): void {
  if (action('kick')?.enabled !== true) return
  emit('kick')
}
</script>

<template>
  <section
    class="message-panel"
    :class="{ 'is-history': historyOpen }"
    :style="{ height: `${height}px` }"
    :aria-label="`Messages with ${dwarf.name}`"
    @keydown.escape="emit('close')"
    @click.stop
  >
    <!-- Vertical-only resize, on the panel's own top edge. -->
    <div
      class="panel-resize"
      role="separator"
      aria-orientation="horizontal"
      :aria-label="`Resize the message panel for ${dwarf.name}`"
      tabindex="0"
      @pointerdown="startResize"
      @pointermove="resize"
      @pointerup="endResize"
      @pointercancel="endResize"
      @keydown="resizeByKey"
    ></div>

    <!--
      `data-window-drag` marks this row as the handle that moves the panel's
      own WINDOW (#296). Only a marker: the gesture and the geometry belong to
      MessagePanelWindow.vue and to main, and the three controls below stay
      controls — see lib/shell/windowDrag.
    -->
    <header class="panel-bar" data-window-drag>
      <!--
        The design draws the dwarf's name here and no fourth icon, so the name
        IS the control that focuses this session's console — which is where
        the old action bar's console icon went.
      -->
      <span class="panel-who">
        <button
          class="panel-agent"
          type="button"
          :title="CONSOLE_HINT"
          @click="emit('open-console')"
        >
          {{ dwarf.name }}
        </button>
        <!--
          Which worktree this dwarf is in (#348). Text, never a control: a mine
          folded from several worktrees has a crew in several folders, and this
          is the only place that says which one you are talking to. Absent for a
          dwarf working in the mine's own folder, which is most of them.
        -->
        <span v-if="workplaceLabel" class="panel-workplace">· {{ workplaceLabel }}</span>
      </span>
      <button
        class="panel-history"
        type="button"
        :aria-expanded="historyOpen"
        :aria-label="historyOpen ? 'Collapse message history' : 'Expand message history'"
        @click="toggleHistory"
      >
        <span class="history-arrow" aria-hidden="true"></span>
      </button>
      <button class="panel-close" type="button" aria-label="Close messages" @click="emit('close')">
        <span
          class="close-glyph"
          :style="{ '--close-icon': maskImageValue(CLOSE_ICON_SRC) }"
          aria-hidden="true"
        ></span>
      </button>
    </header>

    <!--
      How the last turn ended (#510) — directly under the header, and its own
      row rather than a rewrite of the note below the composer: what a turn
      concluded and whether a message was delivered or reacted to are two
      different facts (AGENTS.md), and this one never borrows the other's
      words. Absent for a dwarf with no `lastTurn` yet, same as every other
      conditional row in this panel.
    -->
    <template v-if="turnOutcome">
      <p
        class="panel-turn-outcome"
        :class="`is-${turnOutcome.kind}`"
        role="status"
        :title="turnOutcome.text"
      >
        {{ turnOutcome.headline
        }}<template v-if="turnOutcome.text">: {{ turnOutcome.text }}</template>
      </p>
      <p v-if="turnOutcome.trimmed" class="panel-turn-outcome-trimmed">(trimmed)</p>
    </template>

    <!--
      Independently scrollable, which is a rule and not a convenience: the
      source says history can be inspected here without expanding the tab.
    -->
    <div
      ref="conversationRef"
      class="panel-conversation"
      tabindex="0"
      :aria-label="note"
      @scroll="onConversationScroll"
    >
      <!--
        #332: silence says nothing about a dwarf's rank, and a dwarf that has
        not spoken still has a face — `dwarf.role` is on the prop, not on the
        transcript. Drawn as an agent row like any other so the first real
        message lands under it without a jump; the note takes the bubble's
        place rather than its surface, because nothing was actually said.
      -->
      <article v-if="conversation.messages.length === 0" class="message is-agent">
        <img
          class="portrait"
          :src="PORTRAIT_SRC[dwarf.role]"
          :alt="`${dwarf.name}, ${dwarf.role}`"
          :title="`${dwarf.name}, ${dwarf.role}`"
          draggable="false"
        />
        <p class="panel-empty">{{ conversation.note }}</p>
      </article>
      <template v-for="entry in entries" :key="entry.key">
        <!--
          AMENDED for #294 (was: one line per tool call, always drawn). A run of
          consecutive tool calls is now ONE disclosure row under the bubble it
          follows, closed on arrival — an agent acts far more often than it
          speaks, and thirty lines between two replies leave no conversation to
          read. Nothing is hidden: the same lines are one press away, and the
          run is still the same rows in the panel's window.

          The label is lib/message/activityGroup's; the triangle is the
          design's own history-tab affordance reused rather than an icon
          invented for it (`screens/mine.md`'s #294 amendment).
        -->
        <template v-if="entry.kind === 'activity'">
          <button
            type="button"
            class="activity-disclosure"
            :class="{ 'is-open': isRunOpen(entry.key) }"
            :aria-expanded="isRunOpen(entry.key)"
            :title="entry.label"
            @click="toggleRun(entry.key)"
          >
            <span class="disclosure-arrow" aria-hidden="true"></span>
            <span class="disclosure-label">{{ entry.label }}</span>
          </button>
          <!--
            One tool call, drawn as a line rather than a turn (#240): the
            design's own summary rule spoken in the past tense, in the panel's
            muted meta ink, with no icon, no bubble surface and no portrait.
          -->
          <!--
            AMENDED for #279 (was: always a `<p>`). An `edit`/`read` target is a
            FILE, so it draws as a button styled as text rather than an anchor
            (`screens/mine.md`'s own amendment: keyboard reachable, same ink,
            underline only on hover/focus) — `run` and `search` stay the plain
            paragraph #240 drew.
          -->
          <template v-if="isRunOpen(entry.key)">
            <template v-for="line in entry.rows" :key="line.key">
              <button
                v-if="line.activity && isOpenablePath(line.activity)"
                type="button"
                class="activity-line is-openable"
                :title="line.text"
                @click="emit('open-path', line.activity.target)"
              >
                {{ line.text }}
              </button>
              <p v-else class="activity-line" :title="line.text">{{ line.text }}</p>
            </template>
          </template>
        </template>
        <article
          v-else
          class="message"
          :class="entry.message.from === 'agent' ? 'is-agent' : 'is-user'"
        >
          <!--
            Whose face this is, from lib/message/conversation (#175). A prompt an
            agent issued is drawn as that agent — its rank picks the portrait and
            its name is the alt text and the tooltip, because the design draws no
            per-message label and inventing chrome the source does not specify is
            the one thing `ui-rebuild` refuses.
          -->
          <img
            v-if="entry.message.from === 'agent'"
            class="portrait"
            :src="PORTRAIT_SRC[entry.message.author.role]"
            :alt="`${entry.message.author.name}, ${entry.message.author.role}`"
            :title="`${entry.message.author.name}, ${entry.message.author.role}`"
            draggable="false"
          />
          <!--
            The bubble is the one surface here that is PROSE (#347): an agent
            writes Markdown, and showing the delimiters was showing the ink
            rather than the writing. The component builds vnodes from a tree
            (see lib/message/markdown); this file still owns the surface, which
            is why the class stays here.

            The person's own rows and echoes go through it too — the
            maintainer's ruling on the one thing the issue left open. A panel
            that renders half its conversation would make the same words look
            like two different kinds of message.
          -->
          <MarkdownBubble
            class="bubble"
            :text="entry.message.text"
            @open-link="emit('open-link', $event)"
          />
          <!--
            The verdict of a message this panel sent, beside the words it is
            about (#309). Drawn only on an echo: a row read off a transcript is
            a message the session HAS, and a tick on it would be an unfounded
            claim about a delivery nobody watched.

            Glyph, class and hover sentence all come from `sendMarker` — the
            same reading the marker on the dwarf's sprite is drawn from — so
            the two can never say different things about one delivery. A ✕
            keeps its bubble and offers the one control that sends the words
            again, and only where the session can still be written to at all.
          -->
          <!--
            What the message was sent WITH, under its words (#408): the same
            chips, without their remove control — a message already handed over
            is not something an edit can be taken out of. So the person can see
            what was submitted, and `Send again` resends exactly it.
          -->
          <ul
            v-if="entry.message.echo && attachmentsOfEcho(entry.message.echo.id).length > 0"
            class="bubble-attachments"
          >
            <li
              v-for="item in attachmentsOfEcho(entry.message.echo.id)"
              :key="item.path"
              class="composer-chip bubble-attachment"
              :title="item.name"
            >
              <span class="chip-glyph" aria-hidden="true"></span>
              <span class="chip-name">{{ item.name }}</span>
            </li>
          </ul>
          <span v-if="entry.message.echo" class="bubble-verdict">
            <span
              v-if="entry.message.marker"
              class="bubble-marker"
              :class="entry.message.marker.cls"
              :title="entry.message.marker.title"
              >{{ entry.message.marker.glyph }}</span
            >
            <button
              v-if="entry.message.echo.state.phase === 'failed' && canReceive"
              class="bubble-retry"
              type="button"
              :title="SEND_AGAIN_TITLE"
              @click="emit('send-again', entry.message.echo.id)"
            >
              {{ SEND_AGAIN_LABEL }}
            </button>
          </span>
          <img
            v-if="entry.message.from === 'user'"
            class="portrait"
            :src="USER_PORTRAIT_SRC"
            alt="You"
            draggable="false"
          />
        </article>
      </template>
    </div>

    <!--
      A dialog this panel cannot answer, and the way to the one place that can
      (#203). Above the composer, because it is about the session rather than
      about a control: the composer below still takes a message, and this says
      the session will not read it until the dialog is dealt with.

      The jump repeats the console channel the dwarf's own name already carries
      in the header. Repeated rather than pointed at, because a sentence that
      names a terminal and then asks somebody to find the control for it has
      only moved the search.
    -->
    <p v-if="approval" class="panel-approval" role="status">
      <span>{{ approval }}</span>
      <button
        class="approval-jump"
        type="button"
        :title="CONSOLE_HINT"
        @click="emit('open-console')"
      >
        {{ JUMP_TO_TERMINAL_NAME }}
      </button>
    </p>

    <!--
      Dropping files anywhere on the composer attaches them (#408).

      `preventDefault` on BOTH dragover and drop is the whole of the navigation
      guard, and it is not a nicety: a file dropped on a page the browser may
      navigate REPLACES that page with the file, and this window has no way
      back. A regression test pins it by name.

      The listeners sit on the composer rather than the section so that a drag
      over the transcript does not light the border of an input the person is
      not aiming at — the design lights the composer, and nothing else moves.
    -->
    <div
      class="panel-composer"
      :class="{ 'is-dragging': dragging }"
      @dragover.prevent="onDragOver"
      @dragleave="dragging = false"
      @drop.prevent="onDrop"
    >
      <!--
        A permission prompt REPLACES the composer first, ahead of an ordinary
        ask, because it is the tool call this held session is blocked INSIDE
        right now (#203) — the ask can wait a turn, the permission cannot. The
        ask reappears on its own once the permission is decided: main's next
        snapshot drops `pendingPermission`, and this component clears neither
        on its own initiative (see the module comment).

        Absent that, the ask REPLACES the composer while one is open, which is
        what the design's two question exports draw: the option cards, then
        `Other Thing` and the card's own box where the panel's input would be.
        Neither is ever behind a toggle, because each is the reason the dwarf
        was clicked.

        A free-form reply leaves on the ordinary message channel either way,
        because neither channel takes back anything but its own fixed answers.
      -->
      <DwarfPermissionCard
        v-if="dwarf.pendingPermission"
        class="panel-ask"
        :permission="dwarf.pendingPermission"
        :answer-state="answerState"
        @decide="emit('decide', $event)"
        @send-text="emit('send', $event)"
        @open-console="emit('open-console')"
      />
      <DwarfQuestionCard
        v-else-if="dwarf.pendingQuestion"
        class="panel-ask"
        :question="dwarf.pendingQuestion"
        :answer-state="answerState"
        @answer="emit('answer', $event)"
        @answer-text="emit('answer-text', $event)"
        @send-text="emit('send', $event)"
        @open-console="emit('open-console')"
      />
      <!--
        The design's own composition: the chips sit ABOVE the input and INSIDE
        its white surface, so a pending file reads as part of the message rather
        than as a row floating beside it. That is why the surface moved out to
        this wrapper — the textarea keeps the typing and the field keeps the
        look, and the ask cards above are untouched by either.
      -->
      <div v-else class="panel-field">
        <ul v-if="pending.length > 0" class="composer-chips">
          <li v-for="item in pending" :key="item.path" class="composer-chip" :title="item.name">
            <!--
              A preview main rendered, never a path this renderer loaded. The
              panel is given a bounded data URL precisely so that a chip can
              never become a reason to read something off the disk.
            -->
            <img
              v-if="thumbnails[item.path]"
              class="chip-thumb"
              :src="thumbnails[item.path]"
              alt=""
              draggable="false"
            />
            <span v-else class="chip-glyph" aria-hidden="true"></span>
            <span class="chip-name">{{ item.name }}</span>
            <button
              class="chip-remove"
              type="button"
              :aria-label="`Remove ${item.name}`"
              @click="removeAttachment(item.path)"
            >
              ×
            </button>
          </li>
        </ul>
        <textarea
          ref="composerRef"
          v-model="message"
          class="panel-input is-selectable"
          rows="2"
          :disabled="!canReceive"
          :title="action('chat')?.hint"
          placeholder="Write here..."
          :aria-label="`Message ${dwarf.name}`"
          @keydown="onInputKeydown"
        ></textarea>
      </div>
      <div class="panel-controls">
        <!--
          The design puts attach at the LEADING edge of the control row, which
          in this vertical stack is above Kick. Disabled rather than hidden
          wherever the channel cannot carry a file, with the reason in its
          title — the action bar's own rule, and the one the whole capability
          exists to serve: the panel never accepts a file it would drop.
        -->
        <button
          class="control-attach"
          type="button"
          :disabled="!canAttach"
          aria-label="Attach a file"
          :title="attachTitle"
          @click="onAttachClick"
        >
          <span
            class="control-glyph"
            :style="{ '--control-icon': maskImageValue(ATTACH_ICON_SRC) }"
            aria-hidden="true"
          ></span>
        </button>
        <button
          class="control-kick"
          type="button"
          :disabled="action('kick')?.enabled !== true"
          :aria-label="action('kick')?.name"
          :title="action('kick')?.hint"
          @click="onKick"
        >
          <span
            class="control-glyph"
            :style="{ '--control-icon': maskImageValue(KICK_ICON_SRC) }"
            aria-hidden="true"
          ></span>
        </button>
        <!--
          Boost is drawn where the design puts it and does nothing, on purpose.
          No provider exposes a channel to change a running session's effort
          (DwarfCapabilities.adjustEffort is the literal null), and the SDK's
          own `applyFlagSettings` resolves as a silent no-op without a
          supportsEffort guard — so a live button here would answer a click
          with silence, which is a worse lie than a disabled one that says why.
        -->
        <button
          class="control-boost"
          type="button"
          disabled
          :aria-label="action('boost')?.name"
          :title="action('boost')?.hint"
        >
          <span
            class="control-glyph"
            :style="{ '--control-icon': maskImageValue(BOOST_ICON_SRC) }"
            aria-hidden="true"
          ></span>
        </button>
      </div>
    </div>

    <!--
      Its own row rather than the note's: what the panel may claim about a
      transcript and why a control is disabled are two different facts, and
      neither may take the other's place. Silent while an alert is up — a
      failure the user just caused takes the floor over a standing refusal.
    -->
    <p v-if="refusal && !alertLine" class="panel-refusal" role="status">{{ refusal }}</p>
    <p v-if="alertLine" class="panel-alert" role="alert">{{ alertLine }}</p>
    <p v-else-if="statusLine" class="panel-status" role="status">{{ statusLine }}</p>
    <p v-else class="panel-note">{{ note }}</p>
  </section>
</template>

<style scoped>
/*
 * The design's panel: 990px, 12px radius, a 2px accent border, #2b2119 and
 * elevation 5 — every one of them a token rather than a literal.
 *
 * `min()` against the width available is what is left of #159's
 * reconciliation, and it now means something else (#162). The panel has a
 * WINDOW of its own beside the shell, the way the design's own
 * mine-and-message mock draws it, and main sizes that window to the design's
 * 990 — so `100%` is normally 990 and the `min()` does nothing.
 *
 * It still earns its place: main shrinks the window when the display has no
 * 990 beside the shell (see messagePanelWidth in main/shell/panelBounds.ts),
 * and this is what makes the panel fit the room it was given rather than hang
 * off the side of it.
 */
.message-panel {
  position: relative;
  z-index: 60;
  display: flex;
  flex-direction: column;
  /* The height is fixed, so nothing inside it may spill past the border. */
  overflow: hidden;
  width: min(var(--size-message-panel-width), 100%);
  border: var(--border-active);
  border-radius: var(--radius-default);
  background: var(--color-panel);
  box-shadow: var(--elevation-5);
  font-size: var(--text-meta);
  text-align: left;
}
/*
 * The grab strip, on the top edge. Sized in the border radius so it cannot
 * cover a corner, and drawn only on hover/focus: the design shows no handle,
 * so the affordance appears when it is being reached for.
 */
.panel-resize {
  position: absolute;
  top: -3px;
  right: var(--radius-default);
  left: var(--radius-default);
  height: 7px;
  border-radius: 4px;
  cursor: ns-resize;
  touch-action: none;
}
.panel-resize:hover,
.panel-resize:focus-visible {
  outline: none;
  background: var(--color-accent);
}
/*
 * The design's own title row: the agent's name at the start, the history tab
 * CENTRED, the close at the end. A grid rather than a flex row, because
 * centring the middle child of three unequal ones is what a grid does without
 * a spacer element on each side.
 */
.panel-bar {
  display: grid;
  flex: none;
  grid-template-columns: 1fr auto 1fr;
  gap: var(--space-nav-gap);
  align-items: center;
  padding: 4px 8px;
}
/*
 * The name and, when there is one, the worktree beside it (#348). One grid
 * cell so the header stays the three-column row it was: the label rides with
 * the name rather than taking a column of its own.
 */
.panel-who {
  display: flex;
  min-width: 0;
  gap: 4px;
  align-items: baseline;
  justify-self: start;
}
.panel-agent {
  max-width: 100%;
  overflow: hidden;
  padding: 0;
  border: 0;
  color: var(--color-cream);
  cursor: pointer;
  background: transparent;
  font: inherit;
  letter-spacing: 0.06em;
  text-align: left;
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}
.panel-agent:hover {
  color: var(--color-accent);
}
/*
 * The meta size and the panel s muted note ink, the same pair every other
 * aside in this panel takes. Text, never a control: it says where the dwarf is,
 * and there is nothing to press.
 */
.panel-workplace {
  overflow: hidden;
  color: var(--color-tooltip-text);
  font-size: var(--text-meta);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.panel-history {
  justify-self: center;
}
.panel-close {
  justify-self: end;
}
.panel-history,
.panel-close {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  cursor: pointer;
  background: transparent;
}
/* The design's own small triangle, pointing at the history it opens. */
.history-arrow {
  width: 0;
  height: 0;
  border-right: 6px solid transparent;
  border-bottom: 7px solid var(--color-cream);
  border-left: 6px solid transparent;
}
.is-history .history-arrow {
  rotate: 180deg;
}
.panel-close {
  background: var(--color-cream);
}
.close-glyph {
  display: block;
  width: 70%;
  height: 70%;
  background: var(--color-panel);
  mask: var(--close-icon) center / contain no-repeat;
}
.panel-history:focus-visible,
.panel-close:focus-visible,
.panel-agent:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
/*
 * How the last turn ended (#510), directly under the header. The design
 * source (`docs/dwarfai-miners-design/`) is not on this machine, so this
 * introduces no per-kind palette: same muted ink and meta size as the
 * header's own `.panel-workplace`, the header's typography rather than a
 * fourth invented one. `flex: none` for the reason every other row here is:
 * the fixed panel height gives up pixels from the flexible conversation list
 * above the composer, never from the composer itself.
 *
 * Clamped to a few lines with the SAME idiom `.activity-line` already uses —
 * overflow hidden, an ellipsis, the full text left in `title` for a hover —
 * carried to several lines with `-webkit-line-clamp` because a turn's own
 * words run far longer than one tool-call summary ever does.
 */
.panel-turn-outcome {
  display: -webkit-box;
  flex: none;
  overflow: hidden;
  margin: 0;
  padding: 2px 8px 0;
  color: var(--color-tooltip-text);
  font-size: var(--text-meta);
  line-height: 1.3;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  text-overflow: ellipsis;
}
/*
 * A failed turn is the one kind this row treats as a problem rather than as
 * plain narration — the same danger ink `.panel-alert` already carries for a
 * send or a kick failure, not a colour invented for this row alone.
 */
.panel-turn-outcome.is-errored {
  color: var(--danger-ink);
}
/*
 * Whether the WIRE cut the text at its own bound (`boundTurnText`), never the
 * panel's visual clamp above — the two truncations are independent, so this
 * stays outside the clamped paragraph and is never itself cut off by it.
 */
.panel-turn-outcome-trimmed {
  flex: none;
  margin: 0;
  padding: 0 8px 0;
  color: var(--color-tooltip-text);
  font-size: var(--text-meta);
  opacity: 0.75;
}
/*
 * The messages, with their own scroll — a stated rule, so that history can be
 * read here without expanding the tab.
 */
.panel-conversation {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--space-nav-gap);
  overflow-y: auto;
  min-height: 0;
  padding: 0 8px 8px;
}
/*
 * #332: no longer a standalone centered line — it now stands where a
 * bubble's text would, in the agent row the portrait always draws, so the
 * first real message lands under it without a jump. Same note ink as
 * before; only the alignment changed, to match the bubble it sits beside.
 */
.panel-empty {
  margin: 0;
  padding: 8px 10px;
  color: var(--color-tooltip-text);
  line-height: 1.35;
}
.message {
  display: flex;
  flex: none;
  gap: var(--space-nav-gap);
  align-items: flex-start;
}
.message.is-user {
  justify-content: flex-end;
}
/*
 * One tool-call line (#240): the meta size and the panel's muted ink, with no
 * bubble surface, no icon and no portrait. Offset by the portrait's own width
 * plus the row gap so it lines up with the BUBBLE, not with where a portrait
 * would sit — there is no portrait beside it to align with instead. Truncated
 * to one line with an ellipsis at the panel's width; the full text is `title`.
 */
.activity-line,
.activity-disclosure {
  flex: none;
  margin: 0;
  margin-left: calc(var(--size-portrait) + var(--space-nav-gap));
  overflow: hidden;
  color: var(--color-tooltip-text);
  font-size: var(--text-meta);
  text-overflow: ellipsis;
  white-space: nowrap;
}
/*
 * The folded run (#294): the activity line's own ink, size and bubble
 * alignment — it stands where the lines it replaces stood — as a button styled
 * as text, like #279's openable line beside it.
 *
 * NOT underlined on hover, deliberately: #279 spends that on "this one opens a
 * file", and a row that only unfolds must not borrow the promise. The triangle
 * is the design's own history-tab affordance at the panel's own scale, and the
 * ink brightening to the panel's primary cream is the hover tell —
 * `screens/mine.md`'s #294 amendment, since the source draws no disclosure.
 */
.activity-disclosure {
  display: flex;
  gap: 6px;
  align-items: center;
  /*
   * No explicit width, on purpose (#307): this row also carries the
   * bubble-alignment margin-left above, and as a flex item it already
   * stretches to the list's width MINUS that margin. `width: 100%` added the
   * margin on top and scrolled the whole conversation sideways.
   */
  padding: 0;
  border: none;
  cursor: pointer;
  background: none;
  font-family: inherit;
  text-align: left;
}
.disclosure-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.disclosure-arrow {
  flex: none;
  width: 0;
  height: 0;
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  border-left: 5px solid currentcolor;
}
.activity-disclosure.is-open .disclosure-arrow {
  rotate: 90deg;
}
.activity-disclosure:hover,
.activity-disclosure:focus-visible {
  color: var(--color-cream);
}
.activity-disclosure:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
/*
 * `screens/mine.md`'s own amendment (#279): a button styled as text, not an
 * anchor. Same ink as the plain line above — no new colour — until the
 * reader's pointer or keyboard focus finds it, when it underlines; the
 * pointer cursor is the only other tell that this one opens something.
 */
.activity-line.is-openable {
  display: block;
  /*
   * No explicit width, on purpose (#307): this row also carries the
   * bubble-alignment margin-left above, and as a flex item it already
   * stretches to the list's width MINUS that margin. `width: 100%` added the
   * margin on top and scrolled the whole conversation sideways.
   */
  padding: 0;
  border: none;
  background: none;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
.activity-line.is-openable:hover,
.activity-line.is-openable:focus-visible {
  text-decoration: underline;
}
/* 100px, 12px radius, 2px accent border — the source's own portrait treatment. */
.portrait {
  flex: none;
  width: var(--size-portrait);
  height: var(--size-portrait);
  border: var(--border-active);
  border-radius: var(--radius-default);
  object-fit: cover;
  image-rendering: pixelated;
  user-select: none;
}
/*
 * Both bubbles use the same surface and the same ink; only the alignment
 * differs, exactly as the design has it.
 *
 * AMENDED for #347, twice. It was `--font-pixel` at the panel's meta size:
 * what a dwarf or the person SAYS is now the conversation face at the
 * conversation size, the one surface in this panel that is prose rather than
 * chrome and the only one Tiny5's single weight could not draw.
 *
 * And it held `white-space: pre-wrap` over the raw text, which moved INTO
 * MarkdownBubble onto the paragraphs it builds. A bubble is a stack of blocks
 * now, and pre-wrap out here would turn the gaps between them into blank
 * lines. Everything below is still the surface, which is this file's; the
 * shape of what stands on it is the component's.
 */
.bubble {
  /*
   * A flex item of the row above, so its intrinsic width would otherwise win:
   * a fenced code block inside it is wider than the panel on purpose, and
   * without this the whole conversation column scrolls sideways instead of the
   * block scrolling inside its bubble (#307, from the other direction).
   */
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
  padding: 8px 10px;
  border: var(--border-active);
  border-radius: var(--radius-default);
  color: var(--color-panel);
  background: var(--color-cream);
  font-family: var(--font-conversation);
  font-size: var(--text-conversation);
  line-height: 1.35;
  user-select: text;
  -webkit-user-select: text;
}
/*
 * A sent message's own verdict, at the trailing edge of its bubble (#309).
 *
 * `screens/mine.md` lists delivery/error/retry states under Unspecified, so
 * this is the maintainer-approved amendment rather than a reading of the
 * source — and it is drawn with what the panel already has. Beside the bubble
 * rather than inside it, so the cream surface keeps the message and nothing
 * else: the marker stands on the panel's own dark ground and takes the panel's
 * primary ink and meta size, and the four states are told apart by the GLYPH —
 * the app's existing vocabulary (`…`, ✓, ✓✓, ✕ from
 * lib/delivery/deliveryVerdict) — rather than by four new colours.
 *
 * Two exceptions, both existing tokens: a message still in flight is the
 * muted ink the panel's own notes take, because it is not a verdict yet, and
 * a failure is the danger ink the alert row below already speaks in.
 * Bottom-aligned so a marker sits against the last line of a long message
 * rather than floating beside its first.
 */
.bubble-verdict {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 2px;
  align-items: flex-end;
  align-self: flex-end;
}
.bubble-marker {
  color: var(--color-cream);
  font-size: var(--text-meta);
  font-weight: 700;
  line-height: 1;
  letter-spacing: -1px;
}
.bubble-marker.is-sending {
  color: var(--color-tooltip-text);
  opacity: 0.6;
  font-weight: 400;
  letter-spacing: normal;
}
.bubble-marker.is-failed {
  color: var(--danger-ink);
}
/*
 * The retry, drawn as the text button #279 established for this panel: no new
 * colour, the accent ink the design reserves for a control, underlined so it
 * reads as the one thing here that can be pressed.
 */
.bubble-retry {
  padding: 0;
  border: 0;
  color: var(--color-accent);
  cursor: pointer;
  background: transparent;
  font: inherit;
  font-size: var(--text-meta);
  text-decoration: underline;
  white-space: nowrap;
}
.bubble-retry:focus-visible {
  outline: 2px solid var(--color-cream);
  outline-offset: 2px;
}
/*
 * The approval row introduces no new type, colour or spacing either: it is the
 * note's own rule with the accent ink the design reserves for a control, and
 * the jump beside it is drawn as the link it is rather than as a fourth button
 * the design does not have.
 */
.panel-approval {
  display: flex;
  flex: none;
  gap: 6px;
  align-items: baseline;
  margin: 0;
  padding: 0 8px 4px;
  color: var(--color-tooltip-text);
  font-size: var(--text-helper);
  line-height: 1.3;
}
.approval-jump {
  padding: 0;
  border: 0;
  color: var(--color-accent);
  background: transparent;
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}
.approval-jump:focus-visible {
  outline: 2px solid var(--color-cream);
  outline-offset: 2px;
}
/*
 * The composer row: whichever input is current — the ordinary box, or the ask
 * that replaces it — with the two controls stacked at its right edge, which is
 * where every one of the design's exports puts them.
 */
.panel-composer {
  display: flex;
  flex: none;
  gap: var(--space-nav-gap);
  align-items: flex-end;
  min-height: 0;
  padding: 0 8px 4px;
}
/* The re-homed question card takes the composer's whole width. */
.panel-ask {
  flex: 1;
  min-width: 0;
  max-width: var(--size-message-input-width);
}
/*
 * The design's input: 865px, white, 12px radius, accent border, start-aligned
 * dark text. It is capped rather than fixed for the same reason the panel is.
 *
 * The SURFACE is the field (#408) and the textarea sits inside it, because the
 * amendment puts pending chips above the input and inside its white ground.
 * The textarea keeps the typing; the field keeps the look.
 */
.panel-field {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 4px;
  max-width: var(--size-message-input-width);
  padding: 8px 10px;
  border: var(--border-active);
  border-radius: var(--radius-default);
  background: var(--color-white);
}
/* The design's active ink at full opacity while a drag is over the composer. */
.panel-composer.is-dragging .panel-field {
  border-color: var(--color-accent);
}
.panel-input {
  width: 100%;
  padding: 0;
  border: 0;
  color: var(--color-panel);
  background: transparent;
  font: inherit;
  font-size: var(--text-meta);
  resize: none;
  text-align: left;
}
/*
 * Pending attachments (#408): a wrapping row of chips above the input, each a
 * 40px thumbnail or a file glyph, the name truncated to 160px, and a remove
 * control at the trailing edge. The full name is the chip's own hover text.
 */
.composer-chips,
.bubble-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.bubble-attachments {
  margin-top: 4px;
}
.composer-chip {
  display: flex;
  gap: 4px;
  align-items: center;
  max-width: 220px;
  padding: 2px 4px;
  border: 1px solid var(--color-control);
  border-radius: var(--radius-default);
  color: var(--color-panel);
  font-size: var(--text-meta);
}
.bubble-attachment {
  border-color: var(--color-cream);
  color: var(--color-cream);
}
.chip-thumb {
  width: 40px;
  height: 40px;
  border-radius: var(--radius-default);
  object-fit: cover;
}
/* The file glyph: a plain square at the thumbnail's own scale, no new asset. */
.chip-glyph {
  display: block;
  width: 16px;
  height: 16px;
  border: 1px solid currentcolor;
  border-radius: 2px;
}
.chip-name {
  overflow: hidden;
  max-width: 160px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chip-remove {
  padding: 0 2px;
  border: 0;
  color: inherit;
  cursor: pointer;
  background: transparent;
  font: inherit;
  line-height: 1;
}
/* A stated rule of its own: the input's text must stay selectable. */
.panel-input.is-selectable {
  user-select: text;
  -webkit-user-select: text;
}
.panel-input:disabled {
  color: #6b5a44;
  cursor: not-allowed;
  background: #e4d7bd;
}
.panel-input:focus-visible {
  outline: 2px solid var(--color-cream);
  outline-offset: 1px;
}
/* Kick above, boost below, at the input's right edge — the design's own stack. */
.panel-controls {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 4px;
}
.control-attach,
.control-kick,
.control-boost {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  cursor: pointer;
  background: transparent;
}
.control-glyph {
  display: block;
  width: 100%;
  height: 100%;
  background: var(--color-cream);
  mask: var(--control-icon) center / contain no-repeat;
}
.control-attach:hover:not(:disabled) .control-glyph,
.control-kick:hover:not(:disabled) .control-glyph,
.control-boost:hover:not(:disabled) .control-glyph {
  background: var(--color-accent);
}
/* An armed kick turns hostile-red until it is confirmed. */
.control-attach:disabled,
.control-kick:disabled,
.control-boost:disabled {
  cursor: not-allowed;
}
.control-attach:disabled .control-glyph,
.control-kick:disabled .control-glyph,
.control-boost:disabled .control-glyph {
  opacity: 0.4;
}
.control-attach:focus-visible,
.control-kick:focus-visible,
.control-boost:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
/*
 * One line under the input, and it is never decoration: it says what the
 * messages above ARE when nothing is in flight, and the delivery verdict when
 * something is — a ✓ and a ✓✓ are different facts and the copy keeps them
 * apart (see lib/delivery/deliveryVerdict).
 */
.panel-note,
.panel-refusal,
.panel-status,
.panel-alert {
  flex: none;
  margin: 0;
  padding: 0 8px 8px;
  font-size: var(--text-helper);
  line-height: 1.3;
}
/*
 * The refusal row introduces no new type, colour or spacing: it is the note's
 * own rule, because it is the same kind of prose about the same session. Only
 * its opacity is the note's rather than lower — a standing refusal is the one
 * sentence in the panel a person needs to be able to read.
 */
.panel-note,
.panel-refusal {
  color: var(--color-tooltip-text);
  opacity: 0.75;
}
.panel-refusal {
  padding-bottom: 4px;
}
.panel-status {
  color: #8fd07a;
}
.panel-alert {
  color: var(--danger-ink);
}
</style>
