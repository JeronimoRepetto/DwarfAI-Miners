import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import type { DwarfId } from '@dwarfai/contracts'
import { useAgentLaunch } from './useAgentLaunch'
import { useDwarfKicking } from './useDwarfKicking'
import { useDwarfMessaging } from './useDwarfMessaging'
import { useDwarfPaging } from './useDwarfPaging'
import { useDwarfQuestion } from './useDwarfQuestion'
import { useMines, type BoardWalk } from './useMines'
import { useToasts } from './useToasts'
import { MESSAGE_COPIED } from '../lib/delivery/deliveryVerdict'
import { shouldHidePanelAfterActivation } from '../lib/delivery/activation'
import { feedMessagesOf } from '../lib/message/conversation'
import { joinFeedPages } from '../lib/message/feedPages'
import type { AskAnswer } from '../lib/question/questionAnswer'
import type {
  Dwarf,
  DwarfAttachment,
  DwarfDeliveryReport,
  DwarfFeedResult,
  DwarfKickState,
  DwarfPermissionDecision,
  DwarfSendState,
  FeedMessage,
  MessagePanelState,
  Mine,
  MinesSnapshot
} from '../types'

/**
 * The conversation and the launch, anchored in the dock's window slot (#635).
 *
 * The MessagePanel and the Add panel used to be a second BrowserWindow beside the shell (#162),
 * rooted in their own component. The decision log anchors both in the Panel ("MessagePanel and
 * Add panel anchored": never floating, never movable, no position of their own), and the PO chose
 * ONE OS window for it (2026-09-27): they mount in the shell's own dock slot, where the history
 * does, one thing at a time. So everything that window owned is this composable now, called once
 * by App and alive as long as the shell is.
 *
 * ## Why it outlives the panel
 *
 * The delivery stores are watching for reactions (#21) and expire their own verdicts on timers,
 * and the marker each verdict drives is drawn on the dwarf's sprite whether or not its chat is
 * open. A store that died with the panel would take the ✓ off a sprite the moment the chat
 * closed, and a reaction nobody was watching for could never become ✓✓. So the stores, the
 * launch and the drafts are held here, and the panel is only drawn from them.
 *
 * ## What it does NOT do any more
 *
 * It asks main for nothing about a window: which surface is open is this window's own state
 * (`surface`), because the only other reader it had was the shell, which is now the same page.
 * The delivery verdicts are read here too (`delivery`), where the report used to be published
 * across the bridge for the shell to draw.
 */
export function useMessageDock() {
  const { state: mines, onWalk } = useMines()
  const { showToast } = useToasts()
  const {
    state: messagingState,
    echoes: sentEchoes,
    echoAttachments: sentEchoAttachments,
    send: sendDwarfText,
    retry: retryDwarfText,
    observe: observeSends,
    reconcile: reconcileEchoes,
    listenHeld: listenHeldMessages,
    keepEchoesFor,
    failedSends,
    routeGone,
    messageStateFor,
    hostOldestMessageId,
    chatFeedOf,
    startChat,
    stopChat
  } = useDwarfMessaging()
  /**
   * The pages of conversation older than the newest feed (#364) — held beside `selectedFeed`
   * rather than inside it, for the reasons `useDwarfPaging` states. Everything about WHEN a page is
   * asked for lives there; this joins what it holds to the newest page for drawing, and says which
   * dwarf the pages belong to.
   */
  const { state: paging, note: pagingNote, hold: holdOlderPages, olderFromHost } = useDwarfPaging()
  const { state: kickingState, kick, observe: observeKicks } = useDwarfKicking()
  const {
    state: questionState,
    answer: answerDwarfQuestion,
    answerWithText: answerDwarfQuestionWithText,
    decide: decideDwarfPermission
  } = useDwarfQuestion()
  const launch = useAgentLaunch()

  /**
   * Which surface the dock's window slot is asked to hold (#635): nothing, the Add panel on a
   * mine, or the MessagePanel on one dwarf of a mine. Local, where it used to be main's (#162):
   * both of its readers — the panel itself and the halo on the selected sprite — are this page.
   */
  const surface = ref<MessagePanelState>({ surface: 'none', mineId: '', dwarfId: '' })

  /** Open the chat on one dwarf, in the mine it belongs to. */
  function openMessage(mineId: string, dwarfId: string): void {
    surface.value = { surface: 'message', mineId, dwarfId }
  }

  /** Open the Add panel on a mine — the launch has produced no dwarf yet. */
  function openLaunch(mineId: string): void {
    surface.value = { surface: 'launch', mineId, dwarfId: '' }
  }

  /** Let the slot go, naming neither a mine nor a dwarf. */
  function close(): void {
    surface.value = { surface: 'none', mineId: '', dwarfId: '' }
  }

  const error = ref<string | null>(null)

  /** The mine the surface belongs to, as the current snapshot reports it. */
  const currentMine = computed<Mine | undefined>(() =>
    mines.mines.find((mine) => mine.id === surface.value.mineId)
  )

  /** The dwarf the chat was asked to open on, or none. */
  const askedDwarfId = computed<string | null>(() =>
    surface.value.surface === 'message' && surface.value.dwarfId !== ''
      ? surface.value.dwarfId
      : null
  )

  /**
   * The dwarf the chat is actually open on: the one named, or the one a launch turned out to have
   * started (#86).
   *
   * DERIVED rather than assigned, and that is the whole point. The design's transition is the Add
   * panel being replaced by the MessagePanel on the new dwarf, which reads like a moment to react
   * to — but a handover carried out by a watcher is a handover that can be missed. Reading it is a
   * statement that stays true however many times it is read.
   */
  const openDwarfId = computed(() => launch.state.value.launchedDwarfId ?? askedDwarfId.value)

  /**
   * The open dwarf's chat as the Host feeds it (ISSUE-123; 14 §6.4 row `useDwarfMessaging`): the snapshot `tails`
   * and the `conversation.appended` frames over A-N01/A-N02, followed from mount (`startChat`). It replaced today's
   * pull of A-14 `getDwarfFeed` on every sign of activity (#183, #195), A-16 `setWatchedDwarf` and the feed main pushed
   * with the poll (#196): those rows are retired from the cut-1 switch, and the Host's frames are the one source.
   * `undefined` means the Host has not fed the chat yet, which the panel says out loud rather than drawing as an empty
   * conversation.
   *
   * The NEWEST rows (#364): the pages a reader scrolled back to are held separately (`useDwarfPaging`) and joined to
   * it in `pagedMessages`, so they survive a session that keeps talking.
   */
  const selectedFeed = computed<DwarfFeedResult | undefined>(() =>
    openDwarfId.value === null ? undefined : chatFeedOf(openDwarfId.value)
  )

  /**
   * What the panel DRAWS: every older page the reader has fetched, oldest first, with the newest
   * page at its foot (#364). Joined here and nowhere else, so the pages a reader scrolled back to
   * survive a session that keeps talking.
   */
  const pagedMessages = computed<FeedMessage[]>(() =>
    joinFeedPages(paging.pages, selectedFeed.value?.messages ?? [])
  )

  /**
   * The same answer `selectedFeed` carries, with the drawn conversation in place of its own page.
   * Spread rather than rebuilt so `source` rides along unchanged: the panel reads it to say which
   * claim the conversation carries (#436).
   */
  const drawnFeed = computed<DwarfFeedResult | undefined>(() =>
    selectedFeed.value === undefined
      ? undefined
      : { ...selectedFeed.value, messages: pagedMessages.value }
  )

  /** The open dwarf as the CURRENT snapshot reports it, or nothing once the board dropped it. */
  const liveSelectedDwarf = computed<Dwarf | undefined>(() =>
    openDwarfId.value === null
      ? undefined
      : currentMine.value?.dwarfs.find((dwarf) => dwarf.id === openDwarfId.value)
  )

  /**
   * The open dwarf as the board LAST reported it (#192): the chat outlives a session ending — the
   * moment its final reply lands — and is closed by the person. Every real disappearance passes
   * through 'leaving', so the kept dwarf already carries the status the panel reads as "ended".
   */
  const lastSelectedDwarf = ref<Dwarf | undefined>(undefined)

  watch(liveSelectedDwarf, (dwarf, previous) => {
    if (dwarf !== undefined) {
      lastSelectedDwarf.value = dwarf
      return
    }
    if (previous !== undefined) lastSelectedDwarf.value = { ...previous, status: 'leaving' }
  })

  const selectedDwarf = computed<Dwarf | undefined>(() => {
    if (liveSelectedDwarf.value !== undefined) return liveSelectedDwarf.value
    const last = lastSelectedDwarf.value
    return last !== undefined && last.id === openDwarfId.value ? last : undefined
  })

  /**
   * Whether the open dwarf's delivery route went away (#635, decision log, Copy alone on a closed
   * session): the panel's composer and its failed messages say the session is closed, where a
   * dwarf that never had a channel keeps the no-channel refusal.
   */
  const selectedRouteGone = computed(
    () => selectedDwarf.value !== undefined && routeGone(selectedDwarf.value)
  )

  /**
   * The pages a reader scrolled back to belong to the open dwarf: a switch to another dwarf, or to none, throws them
   * away, and every frame for the same dwarf keeps them (#364, #430).
   */
  watch(openDwarfId, (dwarfId) => holdOlderPages(dwarfId), { immediate: true })

  /**
   * One poll's whole board, as App has just stored it: a launch in flight is watching for its own
   * dwarf, which arrives on an ordinary poll like every other session's. AMENDED for ISSUE-123
   * (was: also adopting the feed main pushed with the poll, #196): the chat is the Host's.
   */
  function observeSnapshot(snapshot: MinesSnapshot): void {
    launch.observe(snapshot.mines)
  }

  /**
   * Every poll's whole board, folded into the two delivery stores (#21) — every dwarf rather than
   * one mine's crew: a session whose mine closed still deserves the verdict of the message
   * somebody sent it. Not a deep watch: the board is replaced whole on every poll.
   */
  watch(
    () => mines.mines,
    (board) => {
      const dwarfs = board.flatMap((mine) => mine.dwarfs)
      observeSends(dwarfs)
      observeKicks(dwarfs)
    },
    { immediate: true }
  )

  /**
   * Whether the Add panel is what the slot draws. The launch's own phase decides, not the surface:
   * the design keeps the launch on screen through the spawn, and only `launchArrival` knows when
   * the handover is complete.
   */
  const launchOpen = computed(
    () => launch.phase.value !== 'closed' && launch.phase.value !== 'message-panel'
  )

  /**
   * Follow the surface asked for. Opening the launch is guarded on it not already being open for
   * this mine: `open()` starts a FRESH panel, so a repeated request would silently discard a prompt
   * somebody was half-way through typing. Anything else closes the launch; the session itself is
   * untouched either way — closing the panel only lets go of the handover.
   */
  watch(
    () => [surface.value.surface, surface.value.mineId] as const,
    ([kind, mineId]) => {
      if (kind === 'launch') {
        if (launch.mineId.value === mineId && launch.phase.value !== 'closed') return
        void launch.open(mineId)
        return
      }
      if (launch.phase.value !== 'closed') launch.close()
    },
    { immediate: true }
  )

  /**
   * Adopt the dwarf a launch turned out to have started as the chat's own (#86): the handover is
   * decided by the launch's arrival rules, from the board, so the surface follows it.
   */
  watch(
    () => launch.state.value.launchedDwarfId,
    (dwarfId) => {
      if (dwarfId === null || currentMine.value === undefined) return
      if (surface.value.surface === 'message' && surface.value.dwarfId === dwarfId) return
      openMessage(currentMine.value.id, dwarfId)
    }
  )

  /**
   * Fetch the page before the oldest row on screen (#364), from the Host's message log (A-15 in its target shape from
   * the cut-1 switch, ISSUE-123; 14 §6.4 row `useDwarfPaging`): the cursor is the oldest Host row held. Refusing a
   * repeated report is `useDwarfPaging`'s.
   */
  function pageBack(): void {
    const dwarfId = openDwarfId.value
    if (dwarfId === null) return
    void olderFromHost(
      dwarfId as DwarfId,
      hostOldestMessageId(dwarfId),
      window.api.getDwarfFeedPage
    )
  }

  /**
   * The messages the chat still holds on the person's behalf, and the NEWEST page they are
   * measured against (#309, #364): an echo is words sent a moment ago, accounted for at the live
   * end of the transcript and never four pages back.
   */
  const echoTranscript = computed<readonly FeedMessage[]>(() =>
    selectedDwarf.value === undefined ? [] : feedMessagesOf(selectedDwarf.value, selectedFeed.value)
  )

  /** Drop an echo the moment the transcript accounts for it, so the words appear once (#309). */
  watch(
    [openDwarfId, echoTranscript],
    ([dwarfId, messages]) => {
      if (dwarfId === null) return
      reconcileEchoes(dwarfId, messages)
    },
    { immediate: true }
  )

  /** An echo belongs to the conversation on screen, and to no other (#309). */
  watch(openDwarfId, (dwarfId) => keepEchoesFor(dwarfId), { immediate: true })

  /**
   * Every delivery verdict, for the sprites the mine draws its markers on, and the failed sends
   * the history draws from the record of the send (#635). Read here, where it used to be published
   * across the bridge (#162): the stores and the sprites are one page now. `failed` rides along
   * only when there is any.
   */
  const delivery = computed<DwarfDeliveryReport>(() => {
    const failed = failedSends()
    return {
      send: messagingState.byDwarfId as Record<string, DwarfSendState>,
      kick: kickingState.byDwarfId as Record<string, DwarfKickState>,
      ...(Object.keys(failed).length === 0 ? {} : { failed })
    }
  })

  /**
   * One draft per dwarf (decision log, Drafts per dwarf): the half-written message the composer
   * holds for each dwarf, put back when that dwarf's chat opens again. A sent message empties it.
   * Held here rather than in the panel, which is mounted per dwarf and would lose it on a switch.
   */
  const drafts = ref<Record<string, string>>({})

  function setDraft(dwarfId: string, text: string): void {
    if (text === '') delete drafts.value[dwarfId]
    else drafts.value[dwarfId] = text
  }

  /** The composer's payload, which since #408 may carry files as well as words. */
  interface ComposerSend {
    text: string
    pressEnter: boolean
    attachments?: readonly DwarfAttachment[]
  }

  /**
   * Hand the composer's text over. Fire-and-observe: the panel stays usable, and the verdict lands
   * on the dwarf itself rather than in a modal. AMENDED for ISSUE-123 (was: then re-read the feed on
   * a delivery, #183): the words the session took arrive as Host frames, with nothing to ask for.
   */
  function sendText(dwarf: Dwarf, payload: ComposerSend): void {
    setDraft(dwarf.id, '')
    void sendDwarfText(dwarf.id, payload.text, payload.pressEnter, payload.attachments ?? [])
  }

  /**
   * Retry a failed message from its own bubble (#309, #635): the same message re-sent in place
   * (decision log, Failed delivery), with a send's aftermath.
   */
  function retryMessage(dwarf: Dwarf, echoId: string): void {
    void retryDwarfText(dwarf.id, echoId)
  }

  /**
   * Copy a failed message's words (#635, decision log, Failed delivery). Main owns the clipboard;
   * the toast says "Message copied" only once main says it copied, and a copy main refused says
   * nothing, since the design gives no sentence for one.
   */
  async function copyMessage(text: string): Promise<void> {
    try {
      const result = await window.api.copyText(text)
      if (result.copied) showToast(MESSAGE_COPIED, 'check')
    } catch {
      // The bridge failing is a copy that did not happen, and claims nothing.
    }
  }

  /** Same reasoning as sendText: fire-and-observe, the verdict lands on the dwarf itself. */
  function kickDwarf(dwarf: Dwarf): void {
    void kick(dwarf.id)
  }

  /**
   * Answer the question that dwarf's agent is blocked on (#125). The question is drawn from the
   * dwarf's own `pendingQuestion`, and only main's next snapshot may drop it.
   */
  function answerQuestion(dwarf: Dwarf, label: AskAnswer): void {
    if (dwarf.pendingQuestion === undefined) return
    void answerDwarfQuestion(dwarf.id, dwarf.pendingQuestion, label)
  }

  /** Answer that dwarf's ask in the person's own words (#481): an answer, never a message. */
  function answerQuestionInWords(dwarf: Dwarf, text: string): void {
    if (dwarf.pendingQuestion === undefined) return
    void answerDwarfQuestionWithText(dwarf.id, dwarf.pendingQuestion, text)
  }

  /** Release the tool call that dwarf's held session is blocked on (#203). */
  function decidePermission(dwarf: Dwarf, decision: DwarfPermissionDecision): void {
    if (dwarf.pendingPermission === undefined) return
    void decideDwarfPermission(dwarf.id, dwarf.pendingPermission, decision)
  }

  /** Bring the session's own console forward, and say so when it could not be (#159). */
  async function activate(dwarf: Dwarf): Promise<void> {
    error.value = null
    try {
      const result = await window.api.activateDwarf(dwarf.id)
      if (shouldHidePanelAfterActivation(result)) {
        window.api.hidePanel()
        return
      }
      if (result.focused || result.openedTerminal) return
      error.value = 'The agent terminal could not be opened; its latest activity is above.'
    } catch {
      error.value = 'The agent terminal could not be opened.'
    }
  }

  /**
   * Open an activity line's own path in the OS default app (#279), resolved and verified in main
   * against the mine's folder. The dwarf travels with the click (#348): a relative path is
   * relative to ITS session's cwd.
   */
  async function openPath(target: string): Promise<void> {
    if (currentMine.value === undefined) return
    error.value = null
    try {
      const result = await window.api.openMinePath({
        mineId: currentMine.value.id,
        target,
        ...(selectedDwarf.value === undefined ? {} : { dwarfId: selectedDwarf.value.id })
      })
      if (!result.opened) error.value = result.reason
    } catch {
      error.value = 'That file could not be opened.'
    }
  }

  /**
   * Open a link from a message bubble in the system browser (#347). Main validates it and owns the
   * only `shell.openExternal` in the app.
   */
  async function openLink(href: string): Promise<void> {
    error.value = null
    try {
      const result = await window.api.openExternalLink(href)
      if (!result.opened) error.value = result.reason
    } catch {
      error.value = 'That link could not be opened.'
    }
  }

  /**
   * The open chat when its dwarf's process closes (ISSUE-092; 07 S2.04…S2.06; US-OBS-005.AC03): the board's
   * walk-outs come only from a Host `dwarf.departed` frame (14 §4.3 rule 6), so on today's feed none arrives and
   * nothing here changes. A stopped or outside-closed dwarf's panel stays open — the board keeps it as 'leaving'
   * while it walks out, and `lastSelectedDwarf` after — so the conversation stays with the composer disabled. A
   * dwarf whose mine was removed closes its panel outright (S2.05).
   */
  function followDeparture(walk: BoardWalk): void {
    if (walk.kind !== 'walk-out' || walk.panel !== 'closed') return
    if (surface.value.surface === 'message' && openDwarfId.value === walk.dwarfId) close()
  }

  let unlistenLaunchFailures: (() => void) | undefined
  /** Main's verdict for a message it HELD (#457): the bubble waiting on it is drawn here. */
  let unlistenHeldMessages: (() => void) | undefined
  let unlistenWalks: (() => void) | undefined
  onMounted(() => {
    unlistenLaunchFailures = launch.listenFailures()
    unlistenHeldMessages = listenHeldMessages()
    unlistenWalks = onWalk(followDeparture)
    // The chats from the Host (ISSUE-123): followed for as long as the dock lives.
    void startChat()
  })
  onBeforeUnmount(() => {
    unlistenLaunchFailures?.()
    unlistenHeldMessages?.()
    unlistenWalks?.()
    stopChat()
  })

  return {
    surface: surface as Readonly<Ref<MessagePanelState>>,
    openMessage,
    openLaunch,
    close,
    openDwarfId,
    selectedDwarf,
    selectedRouteGone,
    drawnFeed,
    pagingNote,
    launchOpen,
    launch,
    messagingState,
    /*
     * The composer's verdict (#635): the last MESSAGE's, never an "Answers:" record's, whose
     * verdict is its bubble's and the dwarf's marker's (MESSAGE-QUESTIONS 20, 21).
     */
    messageStateFor,
    kickingState,
    questionState,
    sentEchoes,
    sentEchoAttachments,
    delivery,
    drafts,
    setDraft,
    error,
    observeSnapshot,
    sendText,
    retryMessage,
    copyMessage,
    kickDwarf,
    answerQuestion,
    answerQuestionInWords,
    decidePermission,
    activate,
    openPath,
    openLink,
    pageBack
  }
}
