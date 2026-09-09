import { describe, expect, it } from 'vitest'
import { defaultDwarf } from '../../testing/factories'
import { PANEL_OBSERVER, type Dwarf } from '../../types'
import {
  APPROVAL_AT_TERMINAL_NOTE,
  approvalNote,
  buildActionBar,
  CHANNEL_HINT,
  DISMISS_HINT,
  ENDED_DISMISS_HINT,
  KICK_HINT,
  launchedNoInboxReason,
  NO_CHANNEL_REASON,
  NO_EFFORT_REASON,
  oneShotNoExitReason,
  OPEN_TURN_NO_INTERRUPT_HINT,
  refusalLine,
  SESSION_ENDED_REASON,
  type ActionBarEntry,
  type ActionId,
  type ActionTransientState
} from './actionBar'

const IDLE: ActionTransientState = { kicking: false }

/** A dwarf whose session supports both text delivery and cancellation. */
function capableDwarf(overrides: Partial<Dwarf> = {}): Dwarf {
  return defaultDwarf({
    textDelivery: 'terminal',
    capabilities: { sendText: 'terminal', cancel: 'terminal', adjustEffort: null },
    ...overrides
  })
}

function entryFor(id: ActionId, dwarf: Dwarf, state: ActionTransientState = IDLE): ActionBarEntry {
  const entry = buildActionBar(dwarf, state).find((action) => action.id === id)
  if (!entry) throw new Error(`the bar is missing its "${id}" action`)
  return entry
}

/**
 * The refusal the PANEL shows, rather than the one a hover reveals (#217).
 *
 * Two dead controls with no visible explanation is exactly the "it looks
 * broken" report this comes from: the composer was disabled with no sentence
 * saying why, and the kick's refusal lived only in a tooltip. The reason a
 * disabled control carries is already honest — it just had nowhere on screen
 * to be, so this is what the panel reads to put it there.
 *
 * Chat first, because the composer is the control a person is looking at when
 * they try to say something; the kick's reason surfaces when chat works and
 * the kick does not, which is every ordinary Codex thread (#97).
 */
describe('refusalLine', () => {
  it('has nothing to say when both controls work', () => {
    expect(
      refusalLine(
        defaultDwarf({
          textDelivery: 'terminal',
          capabilities: { sendText: 'terminal', cancel: 'terminal', adjustEffort: null }
        })
      )
    ).toBeNull()
  })

  it('shows why the composer is disabled, in the panel', () => {
    const dwarf = defaultDwarf({
      provider: 'codex',
      capabilities: { sendText: null, cancel: 'launched-process', adjustEffort: null }
    })
    expect(refusalLine(dwarf)).toBe(launchedNoInboxReason('codex'))
  })

  /*
   * AMENDED for #293 (was: "shows the kick's own reason when the composer works
   * and the kick does not", expecting KICK_HINT['codex-queue'] on the panel).
   * The kick on such a dwarf is no longer refused - it dismisses the dwarf - so
   * there is no refusal left to show, and the queue's own sentence would now be
   * a refusal of a control that works. What it does is on the control itself.
   */
  it('has nothing to refuse when the composer works and the kick dismisses', () => {
    const dwarf = defaultDwarf({
      provider: 'codex',
      textDelivery: 'codex-queue',
      capabilities: { sendText: 'codex-queue', cancel: null, adjustEffort: null }
    })
    expect(refusalLine(dwarf)).toBeNull()
  })

  it('says a session has ended once its agent is gone', () => {
    expect(refusalLine(defaultDwarf({ status: 'leaving' }))).toBe(SESSION_ENDED_REASON)
  })

  /*
   * REMOVED for #293: 'says nothing about a kick that is merely in flight'.
   * Its subject went with the code — `refusalLine` no longer reads the kick
   * entry at all, so it takes no transient state and there is no in-flight
   * kick for it to stay quiet about. The coverage that outlived it is
   * 'locks and reports progress while a kick is in flight' below, which is
   * where the in-flight state is now pinned in full.
   */
})

describe('buildActionBar', () => {
  it('lays out the four actions in fixed order: kick, boost, chat, console', () => {
    const ids = buildActionBar(capableDwarf(), IDLE).map((action) => action.id)
    expect(ids).toEqual(['kick', 'boost', 'chat', 'console'])
  })

  describe('kick', () => {
    // AMENDED for #329: the terminal channel's sentence says the session is
    // ended, because that is what the kick does there now.
    it('is enabled with the channel-specific hint when a cancel channel exists', () => {
      const entry = entryFor('kick', capableDwarf())
      expect(entry.enabled).toBe(true)
      expect(entry.name).toBe('Kick')
      expect(entry.hint).toBe(
        'Ends this session — the whole process, not the turn. Its terminal tab stays open.'
      )
    })

    it('names the relay-tier limitation honestly', () => {
      const entry = entryFor(
        'kick',
        capableDwarf({
          capabilities: { sendText: 'claude-relay', cancel: 'claude-relay', adjustEffort: null }
        })
      )
      expect(entry.hint).toBe('Asks the agent to stop — it decides how.')
    })

    /*
     * AMENDED for #293 (was: 'is disabled with a reason when the session has no
     * cancel channel', expecting NO_KICK_REASON - a constant that has gone with
     * it). Nothing can interrupt this session, and the person's intent when
     * they press Kick on it is not "interrupt the turn" but "I am done with
     * this one": the control stays live and dismisses the dwarf.
     */
    /*
     * AMENDED for #305, step 3: `status: 'waiting'` pinned, where the fixture
     * used to inherit `defaultDwarf`'s `'working'`. Nothing about this
     * assertion changed - the dismissal is still what a dwarf with no cancel
     * channel gets - but it is now the answer for an IDLE one only, so the test
     * has to say which it is asking about. Mid-turn is its own block at the
     * foot of this file.
     */
    it('is enabled, and says it dismisses, when the session has no cancel channel', () => {
      const entry = entryFor(
        'kick',
        capableDwarf({
          status: 'waiting',
          capabilities: { sendText: null, cancel: null, adjustEffort: null }
        })
      )
      expect(entry.enabled).toBe(true)
      expect(entry.name).toBe('Kick')
      expect(entry.hint).toBe(DISMISS_HINT)
    })

    /* AMENDED for #293, same reason as above (was: 'is disabled when ...'). */
    /* AMENDED for #305, step 3: `status: 'waiting'` pinned, same reason as above. */
    it('is enabled and dismisses when the dwarf carries no capability matrix at all', () => {
      const entry = entryFor('kick', defaultDwarf({ status: 'waiting' }))
      expect(entry.enabled).toBe(true)
      expect(entry.hint).toBe(DISMISS_HINT)
    })

    /*
     * The one click that used to be two (#293). The arm-then-confirm gesture
     * was #11's implementation choice and the design source never asked for it
     * - `screens/mine.md` listed the confirmation under Unspecified - and in
     * use it read as a kick that had not worked. The test it replaces was
     * 'asks for confirmation once armed, staying enabled for the second click'.
     */
    it('never asks for a confirmation: the name says Kick and the entry fires', () => {
      const entry = entryFor('kick', capableDwarf())
      expect(entry.enabled).toBe(true)
      expect(entry.name).toBe('Kick')
    })

    it('locks and reports progress while a kick is in flight', () => {
      const entry = entryFor('kick', capableDwarf(), { kicking: true })
      expect(entry.enabled).toBe(false)
      expect(entry.name).toBe('Kicking...')
    })

    /**
     * A Codex thread's queue delivers messages but drains only between turns,
     * so it can never interrupt one (#97). The generic reason would read as
     * "there is no way into this session at all", which is wrong here — the
     * chat action is enabled on the very same channel — so the disabled kick
     * names the queue's own limit and where a kick does still land.
     */
    /*
     * AMENDED for #293 (was: 'names the queue limit, not the generic reason,
     * when only the queue can deliver' - a disabled entry carrying
     * KICK_HINT['codex-queue']). That sentence ended by sending the reader to
     * the session console, which was true while the control did nothing and is
     * misleading now that it does something. The queue's limit is still stated;
     * it is now the first half of what Kick does instead.
     */
    /* AMENDED for #305, step 3: `status: 'waiting'` pinned, same reason as above. */
    it('offers the dismissal where only the queue can deliver, and says why', () => {
      const entry = entryFor(
        'kick',
        capableDwarf({
          status: 'waiting',
          textDelivery: 'codex-queue',
          capabilities: { sendText: 'codex-queue', cancel: null, adjustEffort: null }
        })
      )
      expect(entry.enabled).toBe(true)
      expect(entry.hint).toBe(DISMISS_HINT)
      expect(entry.hint).toContain("can't be interrupted")
      expect(entry.hint).not.toBe(KICK_HINT['codex-queue'])
    })

    /*
     * Issue #237, step 5. The same asymmetry as the queue's, from the opposite
     * direction: a held Antigravity session takes messages on the stream this
     * panel holds, and its documented input side carries no cancel event at
     * all. So `cancel` is null while `sendText` is 'held-session', and neither
     * of the two sentences already here is true for it —
     * `KICK_HINT['held-session']` promises an interrupt of the turn, which is
     * exactly what cannot happen, and the generic reason reads as a feature
     * this app has not got round to.
     */
    /*
     * AMENDED for #293 (was: 'says a held protocol has no cancel, rather than
     * promising an interrupt', expecting HELD_NO_CANCEL_REASON - a constant
     * that has gone with it). One dismissal sentence now covers every session
     * nothing can interrupt, whatever makes it so; what must still never
     * happen is this dwarf being promised the interrupt of a turn, which is
     * exactly what its protocol has no event for.
     */
    /* AMENDED for #305, step 3: `status: 'waiting'` pinned, same reason as above. */
    it('offers the dismissal for a held protocol with no cancel, never the interrupt', () => {
      const entry = entryFor(
        'kick',
        capableDwarf({
          provider: 'antigravity',
          status: 'waiting',
          textDelivery: 'held-session',
          capabilities: { sendText: 'held-session', cancel: null, adjustEffort: null }
        })
      )
      expect(entry.enabled).toBe(true)
      expect(entry.hint).toBe(DISMISS_HINT)
      expect(entry.hint).not.toBe(KICK_HINT['held-session'])
    })

    it('still promises the interrupt for a held session whose protocol has one', () => {
      const entry = entryFor(
        'kick',
        capableDwarf({
          textDelivery: 'held-session',
          capabilities: { sendText: 'held-session', cancel: 'held-session', adjustEffort: null }
        })
      )
      expect(entry.enabled).toBe(true)
      expect(entry.hint).toBe(KICK_HINT['held-session'])
    })
  })

  describe('boost', () => {
    it('is always disabled in v1: no provider can raise a running session effort', () => {
      const entry = entryFor('boost', capableDwarf())
      expect(entry.enabled).toBe(false)
      expect(entry.name).toBe('Boost')
      expect(entry.hint).toContain(NO_EFFORT_REASON)
    })

    it("names the dwarf's current effort, normalized per provider", () => {
      const entry = entryFor('boost', capableDwarf({ provider: 'claude', effort: 'xhigh' }))
      expect(entry.hint).toContain('Extra high')
    })

    it('passes a codex reasoning_effort value through unchanged', () => {
      const entry = entryFor('boost', capableDwarf({ provider: 'codex', effort: 'medium' }))
      expect(entry.hint).toContain('medium')
    })
  })

  describe('chat', () => {
    it('is enabled with the channel hint when the session can receive text', () => {
      const entry = entryFor('chat', capableDwarf({ textDelivery: 'foreman-relay' }))
      expect(entry.enabled).toBe(true)
      expect(entry.name).toBe('Chat')
      expect(entry.hint).toBe("Delivered to this worker's foreman, tagged for them.")
    })

    it('is disabled with a reason when the session cannot receive text', () => {
      const entry = entryFor('chat', capableDwarf({ textDelivery: undefined }))
      expect(entry.enabled).toBe(false)
      expect(entry.hint).toBe(NO_CHANNEL_REASON)
    })

    /**
     * The queue tier's ✓ means handed to the session's queue and nothing more
     * (#97) — the hint has to say so, because a message read between turns can
     * sit there for seconds after the panel has ticked.
     */
    it('says a queued message waits for the next turn boundary', () => {
      const entry = entryFor('chat', capableDwarf({ textDelivery: 'codex-queue' }))
      expect(entry.enabled).toBe(true)
      expect(entry.hint).toBe(CHANNEL_HINT['codex-queue'])
      expect(entry.hint).toContain('queue')
    })
  })

  /**
   * A 'leaving' dwarf's agent has already finished (#192): its pid is stale
   * and its session name no longer resolves, which is exactly why main refuses
   * to write to one. The bar says so up front, in the same words, rather than
   * offering a channel the session left behind and letting main refuse it.
   */
  describe('ended session', () => {
    it('disables chat with the ended reason, whatever channel the session used to have', () => {
      const entry = entryFor('chat', capableDwarf({ status: 'leaving' }))
      expect(entry.enabled).toBe(false)
      expect(entry.hint).toBe(SESSION_ENDED_REASON)
    })

    /*
     * AMENDED for #293 (was: 'disables kick with the ended reason: there is
     * nothing left to interrupt'). There is still nothing left to interrupt -
     * and that is the reason the kick on a finished worker means something
     * else: it ends the walk now rather than leaving the dwarf standing there
     * for the rest of its grace (#219).
     */
    it('offers kick on an ended session, to end the walk rather than interrupt it', () => {
      const entry = entryFor('kick', capableDwarf({ status: 'leaving' }))
      expect(entry.enabled).toBe(true)
      expect(entry.hint).toBe(ENDED_DISMISS_HINT)
      expect(entry.hint).toContain('has ended')
    })
  })

  /**
   * A session this panel LAUNCHED and can only end (#217). `codex exec` reads
   * one prompt from stdin and exits with its turn, so there is no inbox to
   * reach — the generic "can't receive messages yet" describes a missing
   * feature, and what this is is the shape of the session. The kick is the
   * opposite of the queue's: it is the only control that works, and it ends
   * the session rather than interrupting a turn.
   */
  describe('launched session', () => {
    function launched(overrides: Partial<Dwarf> = {}): Dwarf {
      return capableDwarf({
        provider: 'codex',
        textDelivery: undefined,
        capabilities: { sendText: null, cancel: 'launched-process', adjustEffort: null },
        ...overrides
      })
    }

    it('disables chat and names the command the session was launched with', () => {
      const entry = entryFor('chat', launched())
      expect(entry.enabled).toBe(false)
      expect(entry.hint).not.toBe(NO_CHANNEL_REASON)
      expect(entry.hint).toContain('codex exec')
      expect(entry.hint).toBe(launchedNoInboxReason('codex'))
    })

    /*
     * Never the wrong CLI's command: the detached shape is the same for both,
     * and a Codex sentence shown for a Claude launch would send somebody to
     * read the wrong program's docs (the #168 mistake, in copy).
     */
    it('names the launch command per provider', () => {
      expect(entryFor('chat', launched({ provider: 'claude' })).hint).toContain('claude -p')
      expect(launchedNoInboxReason('claude')).not.toContain('codex')
    })

    /*
     * #237, step 4. LAUNCH_COMMAND.antigravity used to name a bare
     * executable because nothing could reach it — Antigravity was observer
     * only. A detached launch exists now, so this sentence has to be true of
     * a real Antigravity dwarf rather than merely present in the map.
     */
    it("names Antigravity's launch command too, now that #237 gives it one", () => {
      // AMENDED for #237 (was: toContain('agy -p') — that flag takes a value
      // on this CLI and swallowed --input-format, breaking every detached
      // launch; see LAUNCH_COMMAND in actionBar.ts).
      expect(entryFor('chat', launched({ provider: 'antigravity' })).hint).toContain(
        'agy --input-format text'
      )
      expect(launchedNoInboxReason('antigravity')).not.toContain('codex')
      expect(launchedNoInboxReason('antigravity')).not.toContain('claude')
    })

    it('offers kick, and says it ends the session rather than interrupting a turn', () => {
      const entry = entryFor('kick', launched())
      expect(entry.enabled).toBe(true)
      expect(entry.hint).toBe(KICK_HINT['launched-process'])
      expect(entry.hint).toContain('Ends the session')
      expect(entry.hint.toLowerCase()).not.toContain('interrupts the turn')
    })
  })

  /**
   * The same session shape, without the exit (#231). A `codex exec` run this
   * panel did not start — from a terminal, or by a run of this app that has
   * restarted since and can no longer prove which process was its — has no
   * inbox for the same reason a launched one has none, and no kick either.
   *
   * The generic "this session type can't receive messages yet" is wrong twice
   * over for it: nothing is coming, and the sentence describes a gap in this
   * app rather than the session in front of the reader. Both controls carry
   * the one sentence that is true of it, because both are refused by the same
   * fact.
   */
  describe('one-shot session this panel did not start', () => {
    function foreign(overrides: Partial<Dwarf> = {}): Dwarf {
      return capableDwarf({
        provider: 'codex',
        oneShot: true,
        textDelivery: undefined,
        capabilities: { sendText: null, cancel: null, adjustEffort: null },
        ...overrides
      })
    }

    it('disables chat with the shape of the session, not the generic refusal', () => {
      const entry = entryFor('chat', foreign())
      expect(entry.enabled).toBe(false)
      expect(entry.hint).not.toBe(NO_CHANNEL_REASON)
      expect(entry.hint).toBe(oneShotNoExitReason('codex'))
      expect(entry.hint).toContain('codex exec')
    })

    /*
     * AMENDED for #293 (was: 'says outright that this panel has no exit for
     * it', a disabled kick carrying oneShotNoExitReason). This panel still has
     * no exit for the SESSION and never claims one - the dismissal is about the
     * board, and the composer beside it still carries the sentence about the
     * session, which is where that fact belongs.
     */
    /* AMENDED for #305, step 3: `status: 'waiting'` pinned, same reason as above. */
    it('offers the dismissal, without ever claiming an exit for the session', () => {
      const entry = entryFor('kick', foreign({ status: 'waiting' }))
      expect(entry.enabled).toBe(true)
      expect(entry.hint).toBe(DISMISS_HINT)
      expect(entry.hint).not.toBe(oneShotNoExitReason('codex'))
    })

    it('is the sentence the panel shows, not one a hover has to be gone looking for', () => {
      expect(refusalLine(foreign())).toBe(oneShotNoExitReason('codex'))
    })

    /*
     * The one this must never displace: a one-shot session this panel DID
     * start keeps #217's sentence, which ends with "Kick ends it" — a promise
     * the sentence above deliberately does not make.
     */
    it('leaves a launch of this panel’s own saying that Kick ends it', () => {
      const entry = entryFor(
        'chat',
        foreign({
          capabilities: { sendText: null, cancel: 'launched-process', adjustEffort: null }
        })
      )
      expect(entry.hint).toBe(launchedNoInboxReason('codex'))
      expect(entry.hint).toContain('Kick ends it')
      expect(oneShotNoExitReason('codex')).not.toContain('Kick ends it')
    })

    /*
     * Never the wrong CLI's command, for the reason the launched sentence
     * names its own: it is copy a person acts on.
     */
    it('names the command per provider', () => {
      expect(oneShotNoExitReason('claude')).toContain('claude -p')
      expect(oneShotNoExitReason('claude')).not.toContain('codex')
    })

    it("names Antigravity's command too", () => {
      // AMENDED for #237 (was: toContain('agy -p') — same fix as the launched
      // case above).
      expect(oneShotNoExitReason('antigravity')).toContain('agy --input-format text')
      expect(oneShotNoExitReason('antigravity')).not.toContain('codex')
    })

    /*
     * The field is a claim about the session, and a session with a working
     * channel is not making it. Nothing here may override a channel that
     * resolves — main is what decides there is none.
     */
    it('says nothing about a session that does have a channel', () => {
      const entry = entryFor('chat', capableDwarf({ oneShot: true }))
      expect(entry.enabled).toBe(true)
      expect(entry.hint).toBe(CHANNEL_HINT.terminal)
    })

    /*
     * The pairing #194 already drew for the launched sentence, and a real
     * invariant rather than a cast: a one-shot run is a CLI this app knows how
     * to read, so a dwarf the PANEL observes is never one, and there is no
     * launch command to name for it.
     */
    it('never names a launch command for a dwarf the panel observes itself', () => {
      const entry = entryFor('chat', foreign({ provider: PANEL_OBSERVER }))
      expect(entry.hint).toBe(NO_CHANNEL_REASON)
    })
  })

  describe('console', () => {
    it('is always available: focusing the terminal needs no delivery channel', () => {
      const entry = entryFor('console', defaultDwarf())
      expect(entry.enabled).toBe(true)
      expect(entry.name).toBe('Console')
      expect(entry.hint).toBe("Focus this session's console.")
    })
  })
})

describe('approvalNote', () => {
  const asked = defaultDwarf({ waitingReason: 'approval', textDelivery: 'terminal' })

  it('names the terminal for a session whose CLI is asking the person to approve', () => {
    expect(approvalNote(asked)).toBe(APPROVAL_AT_TERMINAL_NOTE)
  })

  it('says nothing for a dwarf that is merely waiting', () => {
    expect(approvalNote(defaultDwarf({ status: 'waiting' }))).toBeNull()
    expect(approvalNote(defaultDwarf({ waitingReason: 'user-input' }))).toBeNull()
    expect(approvalNote(defaultDwarf({ waitingReason: 'unknown' }))).toBeNull()
  })

  it('says nothing where the panel can decide the prompt itself', () => {
    // A held session's prompt is answered from the card (#246), so pointing
    // somebody at a terminal would send them away from the control that works.
    const held = defaultDwarf({
      waitingReason: 'approval',
      pendingPermission: {
        toolUseId: 'tool-1',
        toolName: 'Bash',
        title: 'Run a command',
        input: 'pnpm test',
        channel: 'held',
        askedAt: '2026-09-04T00:00:00.000Z'
      }
    })
    expect(approvalNote(held)).toBeNull()
  })

  it('says nothing once the session behind it has ended', () => {
    // The grace window freezes the last real snapshot, mark and all, and there
    // is no dialog left at that terminal to answer.
    expect(approvalNote(defaultDwarf({ waitingReason: 'approval', status: 'leaving' }))).toBeNull()
  })

  it('stands aside for an OBSERVED prompt the panel could name, too (#203)', () => {
    // The card wins wherever the request's content is known, whichever channel
    // answers it. This sentence is for the case main could NOT name — a dialog
    // the hook proved and the tail did not explain — and a card and a line
    // about one dialog read as two.
    const observed = defaultDwarf({
      waitingReason: 'approval',
      pendingPermission: {
        toolUseId: 'tool-1',
        toolName: 'Bash',
        input: 'pnpm test',
        channel: 'terminal',
        askedAt: '2026-09-05T00:00:00.000Z'
      }
    })
    expect(approvalNote(observed)).toBeNull()
  })
})

/*
 * Issue #237, step 5. The composer's own half of the same dwarf: a held
 * session that cannot be kicked is still fully writable, so nothing about the
 * chat action changes for it. Asserted because the kick's refusal above is
 * read off the SAME matrix, and a mistake there would be easiest to make by
 * disabling both.
 */
describe('a held session whose protocol has no cancel (#237, step 5)', () => {
  it('leaves the composer open, because the stream still takes a message', () => {
    const dwarf = defaultDwarf({
      provider: 'antigravity',
      textDelivery: 'held-session',
      capabilities: { sendText: 'held-session', cancel: null, adjustEffort: null }
    })
    const chat = buildActionBar(dwarf, IDLE).find((action) => action.id === 'chat')
    expect(chat?.enabled).toBe(true)
    expect(chat?.hint).toBe(CHANNEL_HINT['held-session'])
  })

  /*
   * AMENDED for #293 (was: 'shows the kick’s reason on the panel, since chat
   * is not the one refusing', expecting HELD_NO_CANCEL_REASON). Nothing about
   * this dwarf is refused any more: the composer works and the kick dismisses,
   * so a refusal row would be the panel apologising for two controls that both
   * do something.
   */
  it('draws no refusal at all, since neither control is refusing anything', () => {
    const dwarf = defaultDwarf({
      provider: 'antigravity',
      textDelivery: 'held-session',
      capabilities: { sendText: 'held-session', cancel: null, adjustEffort: null }
    })
    expect(refusalLine(dwarf)).toBeNull()
  })
})

/*
 * AMENDED for #319 (was, under #308: 'the copy for a session that relays
 * messages and interrupts at its console'). That block was built around a dwarf
 * whose two halves disagreed — `sendText: 'claude-relay'`, `cancel: 'terminal'`
 * — and asserted the send hint was the relay's ('describes the send as a
 * hand-over…') and the console hint warned it was the FALLBACK that TYPES
 * ('warns that the console tier focuses the window and types into it').
 *
 * #319 pastes the message at the console again, so that asymmetric dwarf no
 * longer exists: a named console session is 'terminal' for both halves, and its
 * send hint describes the PASTE, not the relay. The relay's own hint is still
 * asserted, on the headless session where it is now shown.
 *
 * This block is 4 tests where #308's was 5 (net -1 for the file). One removed:
 * 'keeps that warning on the composer of a session whose only channel it is'
 * asserted a terminal-only dwarf's composer hint is CHANNEL_HINT.terminal —
 * exactly what `consolePaste()` (sendText/cancel both 'terminal') is here, so
 * 'describes the send as focusing the terminal and pasting the message in'
 * covers it. Coverage folded in, not dropped.
 */
describe('the copy for a named console session that pastes messages and interrupts at its console (#319)', () => {
  function consolePaste(): Dwarf {
    return defaultDwarf({
      textDelivery: 'terminal',
      capabilities: { sendText: 'terminal', cancel: 'terminal', adjustEffort: null }
    })
  }

  function headless(): Dwarf {
    return defaultDwarf({
      textDelivery: 'claude-relay',
      capabilities: { sendText: 'claude-relay', cancel: 'claude-relay', adjustEffort: null }
    })
  }

  it('describes the send as focusing the terminal and pasting the message in', () => {
    const chat = buildActionBar(consolePaste(), IDLE).find((action) => action.id === 'chat')
    expect(chat?.enabled).toBe(true)
    expect(chat?.hint).toBe(CHANNEL_HINT.terminal)
    // Focus and paste, and NOT the typing it replaced: a person should be able
    // to predict the message landing at once, not being typed out.
    expect(CHANNEL_HINT.terminal).toMatch(/focus/i)
    expect(CHANNEL_HINT.terminal).toMatch(/paste/i)
    expect(CHANNEL_HINT.terminal).not.toMatch(/\btyp/i)
    // No longer the fallback — it is the primary channel again.
    expect(CHANNEL_HINT.terminal).not.toMatch(/fallback/i)
  })

  /*
   * AMENDED for #329 (was: "describes the kick as a keystroke at that session's
   * console"). The keystroke is gone — it could not be aimed at one tab of a
   * shared terminal window — so the sentence has to promise the act that
   * replaced it. A person told a turn was interrupted, when the session is
   * gone, has been told the wrong thing.
   */
  it('describes the kick as ending that session rather than interrupting its turn', () => {
    const kick = buildActionBar(consolePaste(), IDLE).find((action) => action.id === 'kick')
    expect(kick?.hint).toBe(KICK_HINT.terminal)
    expect(KICK_HINT.terminal).toMatch(/ends this session/i)
    expect(KICK_HINT.terminal).not.toMatch(/keystroke|interrupt/i)
  })

  it('describes the relay send as a hand-over the session reads between tool calls, and its fallback role', () => {
    const chat = buildActionBar(headless(), IDLE).find((action) => action.id === 'chat')
    expect(chat?.enabled).toBe(true)
    expect(chat?.hint).toBe(CHANNEL_HINT['claude-relay'])
    // Never a claim that anything has READ it: `delivered` means the queue,
    // and the ✓✓ is the renderer's own observed-reaction rule (reaction.ts).
    expect(CHANNEL_HINT['claude-relay']).toContain('between tool calls')
    expect(CHANNEL_HINT['claude-relay']).toMatch(/fallback/i)
  })

  it('says nothing about a console, a window or typing in the relay send hint', () => {
    // The relay's whole point is that it touches no window — its copy must not
    // borrow the console's.
    expect(CHANNEL_HINT['claude-relay']).not.toMatch(/console|typ|window|focus/i)
  })
})

/*
 * Issue #305, step 3. Kick on an OPEN turn nothing here can interrupt.
 *
 * #293 made a kick with no cancel channel a dismissal, and on a `working`
 * dwarf that reads as a control that does not work: an open turn counts as
 * activity, so the lifecycle tracker puts the dwarf straight back on the rock
 * at the next poll. The maintainer watched exactly that on a Codex thread. So
 * the dismissal is kept for the dwarfs it is honest for — idle and ended — and
 * an open turn gets a refusal that names why and where the turn can be stopped.
 */
describe('kick while a turn nothing here can interrupt is open (#305)', () => {
  /** Working, and nothing in the matrix can cut the turn short — the Codex thread's case. */
  function midTurn(overrides: Partial<Dwarf> = {}): Dwarf {
    return defaultDwarf({
      provider: 'codex',
      status: 'working',
      textDelivery: 'codex-queue',
      capabilities: { sendText: 'codex-queue', cancel: null, adjustEffort: null },
      ...overrides
    })
  }

  it('disables Kick rather than offering a dismissal the next poll would undo', () => {
    const entry = entryFor('kick', midTurn())
    expect(entry.enabled).toBe(false)
    expect(entry.name).toBe('Kick')
    expect(entry.hint).toBe(OPEN_TURN_NO_INTERRUPT_HINT)
    expect(entry.hint).not.toBe(DISMISS_HINT)
  })

  it('names the fact and the way out, in KICK_HINT’s two-clause idiom', () => {
    // The limit first, then what the control does with it — the shape every
    // other sentence in this module keeps.
    expect(OPEN_TURN_NO_INTERRUPT_HINT).toMatch(/cannot be stopped from here/i)
    expect(OPEN_TURN_NO_INTERRUPT_HINT).toMatch(/esc/i)
    expect(OPEN_TURN_NO_INTERRUPT_HINT).toMatch(/once the turn ends/i)
    // Never a promise the panel keeps: nothing here presses that key. #329
    // rules that the panel sends no keystroke into a window it cannot prove is
    // the session's own, so the Esc named here is the person's, at their
    // terminal.
    expect(OPEN_TURN_NO_INTERRUPT_HINT).not.toMatch(/sends an interrupt/i)
  })

  it('keeps the dismissal for the same dwarf once its turn is over', () => {
    const entry = entryFor('kick', midTurn({ status: 'waiting' }))
    expect(entry.enabled).toBe(true)
    expect(entry.hint).toBe(DISMISS_HINT)
  })

  it('keeps the ended dismissal for a dwarf whose session has gone', () => {
    const entry = entryFor('kick', midTurn({ status: 'leaving' }))
    expect(entry.enabled).toBe(true)
    expect(entry.hint).toBe(ENDED_DISMISS_HINT)
  })

  it('leaves a working dwarf that HAS an interrupt channel exactly as it was', () => {
    const entry = entryFor('kick', capableDwarf({ status: 'working' }))
    expect(entry.enabled).toBe(true)
    expect(entry.hint).toBe(KICK_HINT.terminal)
  })

  /*
   * The refusal is about the open turn and not about Codex: a held protocol
   * with no cancel event (#237) is in the same position mid-turn, and the
   * sentence has to be true for it too — which is why it points at where the
   * session runs rather than promising anything from here.
   */
  it('refuses the same way for a held session whose protocol carries no cancel', () => {
    const entry = entryFor(
      'kick',
      capableDwarf({
        provider: 'antigravity',
        status: 'working',
        textDelivery: 'held-session',
        capabilities: { sendText: 'held-session', cancel: null, adjustEffort: null }
      })
    )
    expect(entry.enabled).toBe(false)
    expect(entry.hint).toBe(OPEN_TURN_NO_INTERRUPT_HINT)
  })

  it('still reports an in-flight kick that was fired before the turn opened', () => {
    const entry = entryFor('kick', midTurn(), { kicking: true })
    expect(entry.enabled).toBe(false)
    expect(entry.name).toBe('Kicking...')
  })

  it('says nothing on the panel: a disabled Kick is not the composer’s refusal', () => {
    // `refusalLine` reads the chat entry alone (#293), and the composer of a
    // Codex thread works — the queue takes messages. The kick's reason stays on
    // the control.
    expect(refusalLine(midTurn())).toBeNull()
  })
})
