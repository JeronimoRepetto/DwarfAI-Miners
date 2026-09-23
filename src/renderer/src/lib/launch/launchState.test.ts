import { describe, expect, it } from 'vitest'
// #168 additions are asserted in their own describe at the foot of this file.
import { MAX_DWARF_TEXT_CHARS } from '../../types'
import type { JevRouteLaunchResult, JevSettings, LaunchFailedPush } from '../../types'
import { DEFAULT_JEV_PREFERENCES } from '../../types'
import {
  COMPOSER_DISABLED_PLACEHOLDER,
  COMPOSER_ENABLED_PLACEHOLDER,
  COMMAND_PLACEHOLDER,
  DETACHED_TIMEOUT_MESSAGE,
  OTHER_CHOICE,
  adoptLaunchedDwarf,
  canSubmit,
  chooseEffort,
  chooseModel,
  choosePermissionMode,
  clearJevDecision,
  closeLaunch,
  closedLaunch,
  commitCommand,
  composerEnabled,
  composerPlaceholder,
  chooseProvider,
  detachedTimedOut,
  jevAnswered,
  jevAsked,
  launchFailed,
  launchFailureMessage,
  launchPermissionMode,
  launchPhase,
  launchPrompt,
  launchTuning,
  openLaunch,
  routedByJev,
  setJevSettings,
  shouldAskJev,
  submitRefused,
  startedDetached,
  submitStarted,
  toggleJev,
  toggleJevAutoAccept,
  typeCommand,
  typePrompt
} from './launchState'

const opened = () => openLaunch(closedLaunch())
const withClaude = () => chooseProvider(opened(), 'claude')
const withOther = () => chooseProvider(opened(), OTHER_CHOICE)
const withCommand = () => commitCommand(typeCommand(withOther(), 'lalolanda'))

describe('the design’s own state model', () => {
  it('starts closed, and nothing about a past launch survives being closed', () => {
    const state = closeLaunch(typePrompt(withClaude(), 'go'))

    expect(launchPhase(state)).toBe('closed')
    expect(state).toEqual(closedLaunch())
  })

  it('opens on provider selection with no provider chosen', () => {
    expect(launchPhase(opened())).toBe('provider-selection')
  })

  it('moves a known provider straight to known-provider-ready', () => {
    expect(launchPhase(withClaude())).toBe('known-provider-ready')
  })

  it('moves Other to other-command-required instead', () => {
    expect(launchPhase(withOther())).toBe('other-command-required')
  })

  it('stays in other-command-required until Enter commits the command', () => {
    const typed = typeCommand(withOther(), 'lalolanda')

    expect(launchPhase(typed)).toBe('other-command-required')
    expect(launchPhase(commitCommand(typed))).toBe('other-command-committed')
  })

  it('refuses to commit a command with nothing in it', () => {
    expect(launchPhase(commitCommand(withOther()))).toBe('other-command-required')
    expect(launchPhase(commitCommand(typeCommand(withOther(), '   ')))).toBe(
      'other-command-required'
    )
  })

  /*
   * "Whether the command can be edited after it is committed" is Unspecified in
   * the source. The minimal reading of the gate it DOES state — enabled needs a
   * non-empty command committed with Enter — is that the gate re-checks what is
   * in the box now, so editing takes the commit with it until Enter re-commits.
   * Nothing is invented past that: the text itself is left exactly as typed.
   */
  it('un-commits an edited command until Enter commits it again', () => {
    const edited = typeCommand(withCommand(), 'lalolanda --verbose')

    expect(launchPhase(edited)).toBe('other-command-required')
    expect(edited.command).toBe('lalolanda --verbose')
    expect(launchPhase(commitCommand(edited))).toBe('other-command-committed')
  })

  it('reaches prompt-ready from either path once the composer holds a prompt', () => {
    expect(launchPhase(typePrompt(withClaude(), 'dig'))).toBe('prompt-ready')
    expect(launchPhase(typePrompt(withCommand(), 'dig'))).toBe('prompt-ready')
  })

  /*
   * "Whether whitespace-only prompts count as valid" is Unspecified. Main has
   * already answered it for itself — both launch paths trim before testing for
   * empty and refuse with "Type a prompt first." — so the panel applies the same
   * test rather than offering an Enter that main will refuse.
   */
  it('does not count a prompt of pure whitespace as one', () => {
    expect(launchPhase(typePrompt(withClaude(), '   \n  '))).toBe('known-provider-ready')
  })

  it('never reaches prompt-ready while the composer is disabled', () => {
    expect(launchPhase(typePrompt(opened(), 'dig'))).toBe('provider-selection')
    expect(launchPhase(typePrompt(withOther(), 'dig'))).toBe('other-command-required')
  })
})

describe('the composer the state model gates', () => {
  it('is disabled until a valid choice, and says what to do instead', () => {
    expect(composerEnabled(opened())).toBe(false)
    expect(composerPlaceholder(opened())).toBe(COMPOSER_DISABLED_PLACEHOLDER)
    expect(COMPOSER_DISABLED_PLACEHOLDER).toBe('Select your Dwarf supplier')
  })

  it('is enabled the moment a known provider is chosen', () => {
    expect(composerEnabled(withClaude())).toBe(true)
    expect(composerPlaceholder(withClaude())).toBe(COMPOSER_ENABLED_PLACEHOLDER)
    expect(COMPOSER_ENABLED_PLACEHOLDER).toBe('Write here...')
  })

  it('stays disabled under Other until the command is committed', () => {
    expect(composerEnabled(withOther())).toBe(false)
    expect(composerPlaceholder(withOther())).toBe(COMPOSER_DISABLED_PLACEHOLDER)
    expect(composerEnabled(withCommand())).toBe(true)
  })

  it('keeps the command box on the source’s own placeholder', () => {
    expect(COMMAND_PLACEHOLDER).toBe('Say your command...')
  })
})

describe('changing choice', () => {
  /*
   * "Provider-switch data retention" is Unspecified. Throwing away a prompt
   * somebody typed is the one outcome that loses their work, so the prompt
   * survives a switch; the command does not, because it belongs to Other and
   * a committed one still standing behind a known provider would be a gate
   * passed by a choice nobody is on.
   */
  it('keeps a typed prompt across a provider switch', () => {
    const switched = chooseProvider(typePrompt(withClaude(), 'dig'), 'codex')

    expect(switched.prompt).toBe('dig')
    expect(launchPhase(switched)).toBe('prompt-ready')
  })

  it('forgets the custom command when the choice leaves Other', () => {
    const back = chooseProvider(withCommand(), 'claude')

    expect(back.command).toBe('')
    expect(back.committedCommand).toBe('')
    expect(launchPhase(chooseProvider(back, OTHER_CHOICE))).toBe('other-command-required')
  })

  it('clears a refusal, because it was about the choice that has just changed', () => {
    const refused = submitRefused(submitStarted(typePrompt(withClaude(), 'dig')), 'no')

    expect(chooseProvider(refused, 'codex').error).toBeNull()
  })
})

describe('submitting, and what comes back', () => {
  const ready = () => typePrompt(withClaude(), '  dig here  ')

  // AMENDED for #431 (was: 'trims and caps the prompt exactly as main prepares
  // it', whose second assertion cut a long prompt at MAX_DWARF_TEXT_CHARS).
  // That ceiling is the command line a MESSAGE's channel is spawned with, and a
  // launch prompt travels on the child's stdin or straight onto a held stream —
  // so main's own prepareLaunchPrompt and prepareHeldPrompt dropped the slice
  // the same day, and a copy here that still cut would have stopped identifying
  // the dwarf this launch started. The TRIM, which is what "exactly as main
  // prepares it" is really about, is unchanged and still asserted.
  it('trims the prompt exactly as main prepares it, and cuts nothing off it', () => {
    expect(launchPrompt(ready())).toBe('dig here')
    const long = 'x'.repeat(MAX_DWARF_TEXT_CHARS + 50)
    expect(launchPrompt(typePrompt(withClaude(), long))).toBe(long)
  })

  it('moves to submitted/spawning while the launch is in flight', () => {
    expect(launchPhase(submitStarted(ready()))).toBe('submitted-spawning')
  })

  it('keeps the prompt on screen while spawning, because it is the first message', () => {
    expect(submitStarted(ready()).prompt).toBe('  dig here  ')
  })

  /*
   * A refusal returns the panel to the Add state it submitted from, with the
   * prompt still there. Clearing it would cost the user their typing for a
   * failure that is usually theirs to retry, and #86 asks for a reason and not
   * a silent no-op.
   */
  it('returns to prompt-ready carrying main’s reason when the launch is refused', () => {
    const refused = submitRefused(submitStarted(ready()), 'Claude Code is not installed.')

    expect(launchPhase(refused)).toBe('prompt-ready')
    expect(refused.error).toBe('Claude Code is not installed.')
    expect(refused.prompt).toBe('  dig here  ')
  })

  it('clears a past refusal when the next submit starts', () => {
    const retried = submitStarted(submitRefused(submitStarted(ready()), 'nope'))

    expect(retried.error).toBeNull()
  })

  it('hands over to the MessagePanel once the launched dwarf is identified', () => {
    const adopted = adoptLaunchedDwarf(submitStarted(ready()), 'claude:sess-9')

    expect(launchPhase(adopted)).toBe('message-panel')
    expect(adopted.launchedDwarfId).toBe('claude:sess-9')
  })

  it('adopts nobody while no launch is in flight', () => {
    const stray = adoptLaunchedDwarf(ready(), 'claude:sess-9')

    expect(stray.launchedDwarfId).toBeNull()
    expect(launchPhase(stray)).toBe('prompt-ready')
  })
})

/*
 * A launch the panel started and does not hold (#168, #191).
 *
 * ## AMENDED for #191
 *
 * This block used to be titled "a launch that started but cannot be watched",
 * and its argument was that `message-panel` needs a HELD conversation, so a
 * Codex launch "can never produce that receipt — no amount of waiting turns
 * one up". The first half is still true and the conclusion was too narrow: the
 * maintainer named a third source of evidence on 2026-09-04, the session's own
 * transcript, whose first human turn is the prompt that was sent. Main runs
 * that match and stamps its verdict on the dwarf, so a detached launch DOES
 * have a receipt now — main's, not the board's words.
 *
 * The state itself survives unchanged and is still not in the source's model:
 * it is where a launch waits once main has answered and before its dwarf has
 * been proved. What it no longer means is "this is as far as it goes". Every
 * claim below stands; two names and one comment said the old thing.
 */
describe('a launch that started detached', () => {
  const started = () =>
    startedDetached(submitStarted(chooseProvider(withPrompt(), 'codex')), 'receipt:1')
  const withPrompt = () => typePrompt(chooseProvider(opened(), 'codex'), 'dig here')

  it('leaves the spawning state, because main has already answered', () => {
    expect(launchPhase(started())).toBe('started-detached')
    expect(started().submitting).toBe(false)
  })

  it('claims no dwarf yet: the receipt names the launch, never a dwarf', () => {
    expect(started().launchedDwarfId).toBeNull()
  })

  it('carries main’s receipt, which is what its dwarf will be recognised by', () => {
    expect(started().launchId).toBe('receipt:1')
  })

  /*
   * A launch main opened no receipt for waits in exactly the same place, and
   * that is the honest reading of #168's original argument: the session
   * started, and nothing here can prove which dwarf it became.
   */
  it('waits in the same state when main opened no receipt at all', () => {
    const receiptless = startedDetached(submitStarted(chooseProvider(withPrompt(), 'codex')), null)

    expect(launchPhase(receiptless)).toBe('started-detached')
    expect(receiptless.launchId).toBeNull()
  })

  it('is not an error state: the session really did start', () => {
    expect(started().error).toBeNull()
  })

  it('only ever follows a submit, so nothing enters it on its own', () => {
    // Same guard adoptLaunchedDwarf holds, for the same reason: a panel nobody
    // launched from must not be taken over by something that started elsewhere.
    const stray = startedDetached(withPrompt(), 'receipt:1')

    expect(launchPhase(stray)).toBe('prompt-ready')
  })

  it('is forgotten when the panel closes, like every other launch state', () => {
    expect(launchPhase(closeLaunch(started()))).toBe('closed')
  })

  /*
   * The end of #191. A detached launch is no longer a terminal state: once its
   * dwarf is proved the panel hands over exactly as a held one does, through
   * the same field and the same phase.
   */
  it('hands over to the MessagePanel once its dwarf is proved', () => {
    const adopted = adoptLaunchedDwarf(started(), 'codex:sess-9')

    expect(launchPhase(adopted)).toBe('message-panel')
    expect(adopted.launchedDwarfId).toBe('codex:sess-9')
  })

  it('stays detached after the handover, because the session still is', () => {
    expect(adoptLaunchedDwarf(started(), 'codex:sess-9').detached).toBe(true)
  })
})

/*
 * The model/effort/permission row under the composer (#239). Additions
 * asserted in their own describe, in the same style #168's are above.
 */
describe('the model, effort and permission row (#239)', () => {
  it('starts with nothing chosen, so an untouched row sends nothing', () => {
    const state = withClaude()

    expect(state.model).toBeNull()
    expect(state.effort).toBeNull()
    expect(state.permissionMode).toBeNull()
    expect(launchTuning(state)).toEqual({})
    expect(launchPermissionMode(state)).toBeUndefined()
  })

  it('carries a chosen model and effort into launchTuning', () => {
    const state = chooseEffort(chooseModel(withClaude(), 'sonnet'), 'xhigh')

    expect(launchTuning(state)).toEqual({ model: 'sonnet', effort: 'xhigh' })
  })

  it('carries a chosen permission mode on its own, never inside launchTuning', () => {
    const state = choosePermissionMode(withClaude(), 'plan')

    expect(launchPermissionMode(state)).toBe('plan')
    // Not a launchAgent/launchHeldSession field the same way model/effort are —
    // see HeldSessionLaunchRequest.permissionMode.
    expect(launchTuning(state)).toEqual({})
  })

  it('resets every tuning field when the provider chip changes', () => {
    const tuned = choosePermissionMode(
      chooseEffort(chooseModel(withClaude(), 'sonnet'), 'xhigh'),
      'plan'
    )

    const switched = chooseProvider(tuned, 'codex')

    expect(switched.model).toBeNull()
    expect(switched.effort).toBeNull()
    expect(switched.permissionMode).toBeNull()
  })
})

/*
 * Issue #263. `started-detached` used to be a dead end with no way back: a
 * launch main answered `launched: true` for could die almost at once and the
 * panel would sit there forever with no failure channel and no timeout.
 * These two transitions are that way back.
 */
describe('a detached launch that failed after it started (#263)', () => {
  const withPrompt = () => typePrompt(chooseProvider(opened(), 'codex'), 'dig here')
  const started = (launchId: string | null = 'receipt:1') =>
    startedDetached(submitStarted(withPrompt()), launchId)

  function failure(overrides: Partial<LaunchFailedPush> = {}): LaunchFailedPush {
    return {
      launchId: 'receipt:1',
      provider: 'codex',
      mineId: 'mine-1',
      exitCode: 1,
      stderrTail: 'codex: another instance is already running',
      ...overrides
    }
  }

  describe('launchFailureMessage', () => {
    it('uses the CLI’s own words when it left any', () => {
      expect(launchFailureMessage(failure())).toBe('codex: another instance is already running')
    })

    it('trims the stderr tail rather than showing it with its own whitespace', () => {
      expect(launchFailureMessage(failure({ stderrTail: '  auth expired\n' }))).toBe('auth expired')
    })

    it('names the provider and the code when stderr wrote nothing', () => {
      expect(launchFailureMessage(failure({ stderrTail: '', exitCode: 1 }))).toBe(
        'codex exited with code 1 before it started.'
      )
    })

    it('drops the code entirely for a signal-only exit, rather than saying "code null"', () => {
      expect(launchFailureMessage(failure({ stderrTail: '', exitCode: null }))).toBe(
        'codex exited before it started.'
      )
    })
  })

  describe('launchFailed', () => {
    it('leaves detached, sets the error, and clears the receipt', () => {
      const failed = launchFailed(started(), failure())

      expect(failed.detached).toBe(false)
      expect(failed.launchId).toBeNull()
      expect(failed.error).toBe('codex: another instance is already running')
    })

    it('returns straight to prompt-ready, prompt intact, so a retry is one Enter', () => {
      const failed = launchFailed(started(), failure())

      expect(launchPhase(failed)).toBe('prompt-ready')
      expect(failed.prompt).toBe('dig here')
    })

    it('never claims a dwarf: this is a failure, not an arrival', () => {
      expect(launchFailed(started(), failure()).launchedDwarfId).toBeNull()
    })

    it('ignores a push naming a launch this panel is not waiting on', () => {
      const state = started('receipt:1')

      const untouched = launchFailed(state, failure({ launchId: 'receipt:9' }))

      expect(untouched).toBe(state)
    })

    it('ignores a push once the panel has moved on — closed, or never launched', () => {
      expect(launchFailed(closedLaunch(), failure())).toEqual(closedLaunch())
      expect(launchFailed(withPrompt(), failure())).toEqual(withPrompt())
    })

    it('never reopens a launch whose dwarf has already been proved', () => {
      // A failure arriving after adoption is a report about a session that
      // plainly did start; un-adopting it would contradict evidence this
      // panel already has.
      const adopted = adoptLaunchedDwarf(started(), 'codex:sess-9')

      const untouched = launchFailed(adopted, failure())

      expect(untouched).toBe(adopted)
      expect(launchPhase(untouched)).toBe('message-panel')
    })
  })

  describe('detachedTimedOut', () => {
    it('leaves detached with the fixed neutral sentence, same shape as a real failure', () => {
      const timedOut = detachedTimedOut(started(), 'receipt:1')

      expect(timedOut.detached).toBe(false)
      expect(timedOut.launchId).toBeNull()
      expect(timedOut.error).toBe(DETACHED_TIMEOUT_MESSAGE)
      expect(launchPhase(timedOut)).toBe('prompt-ready')
    })

    it('ignores a stale timer whose launch this panel has since left', () => {
      const state = started('receipt:1')

      expect(detachedTimedOut(state, 'receipt:0')).toBe(state)
    })

    it('never fires once the dwarf has already been proved', () => {
      const adopted = adoptLaunchedDwarf(started(), 'codex:sess-9')

      expect(detachedTimedOut(adopted, 'receipt:1')).toBe(adopted)
    })
  })
})

/*
 * Jev (#509): the Add Panel's own reading of a routed launch. Main already
 * proved the decision is launchable (`routeLaunch.ts`, T3) and never sends
 * the prompt, the key or token usage back — what is left here is entirely
 * about what the pickers show and what the person is told, both pure.
 */
describe('the Jev option (#509)', () => {
  // AMENDED for the #509 follow-up: `preferences` is now a required part of
  // JevSettings, so these fixtures carry the documented default. No
  // assertion below changed.
  const READY: JevSettings = { configured: true, preferences: DEFAULT_JEV_PREFERENCES }
  const HIDDEN: JevSettings = { configured: false, preferences: DEFAULT_JEV_PREFERENCES }
  const UNAVAILABLE: JevSettings = {
    configured: false,
    unavailableReason: 'encryption-unavailable',
    preferences: DEFAULT_JEV_PREFERENCES
  }

  // request v2 (jev-routing-profiles T3) adds `tier`/`parts` to the
  // decision arm — mechanical fixture default, T4 owns actually rendering
  // them; `overrides` can still replace either per test.
  function decision(
    overrides: Partial<Extract<JevRouteLaunchResult, { kind: 'decision' }>> = {}
  ): JevRouteLaunchResult {
    return {
      kind: 'decision',
      provider: 'codex',
      confidence: 0.9,
      truncated: false,
      tier: 'balanced',
      parts: {
        provider: { value: 'codex', confidence: 0.9, applied: 'answered' },
        tier: { value: 'balanced', confidence: 0.9, applied: 'answered' },
        trivial: { value: false, probability: 0.05 },
        largeContext: { value: false, probability: 0.05 },
        // #608: `parts` gained a `model` field — mechanical fixture update,
        // same as `tier`/`parts` above; this fixture names no `model` at the
        // top level either, so nothing was answered about it here.
        model: { applied: 'safe-default', reason: 'no-live-model' }
      },
      ...overrides
    }
  }

  function fallback(
    overrides: Partial<Extract<JevRouteLaunchResult, { kind: 'fallback' }>> = {}
  ): JevRouteLaunchResult {
    return { kind: 'fallback', reason: 'unreachable', ...overrides }
  }

  describe('availability, from main’s own settings verdict', () => {
    it('starts hidden, the honest state before main has ever answered', () => {
      expect(closedLaunch().jev.availability).toBe('hidden')
    })

    it('is hidden with no key configured and no reason given — #509’s own first option', () => {
      const state = setJevSettings(opened(), HIDDEN)

      expect(state.jev.availability).toBe('hidden')
      expect(state.jev.unavailableReason).toBeUndefined()
    })

    it('is unavailable, with the reason, when main names one', () => {
      const state = setJevSettings(opened(), UNAVAILABLE)

      expect(state.jev.availability).toBe('unavailable')
      expect(state.jev.unavailableReason).toBe('encryption-unavailable')
    })

    it('is ready once a key is configured', () => {
      expect(setJevSettings(opened(), READY).jev.availability).toBe('ready')
    })

    it('forces a stale toggle off when settings stop being ready', () => {
      const wasOn = toggleJev(setJevSettings(opened(), READY))
      expect(wasOn.jev.enabled).toBe(true)

      expect(setJevSettings(wasOn, HIDDEN).jev.enabled).toBe(false)
    })
  })

  describe('the toggle', () => {
    it('starts off — the person’s own choice for this panel session, never assumed', () => {
      expect(setJevSettings(opened(), READY).jev.enabled).toBe(false)
    })

    it('does nothing outside ready — nothing to turn on', () => {
      expect(toggleJev(setJevSettings(opened(), UNAVAILABLE)).jev.enabled).toBe(false)
      expect(toggleJev(setJevSettings(opened(), HIDDEN)).jev.enabled).toBe(false)
    })

    it('flips on and off once ready', () => {
      const ready = setJevSettings(opened(), READY)

      expect(toggleJev(ready).jev.enabled).toBe(true)
      expect(toggleJev(toggleJev(ready)).jev.enabled).toBe(false)
    })
  })

  describe('asking', () => {
    it('moves from idle to asking', () => {
      expect(jevAsked(opened()).jev.routing).toEqual({ phase: 'asking' })
    })

    it('is a no-op once already asking — one ask per submit', () => {
      const asking = jevAsked(opened())

      expect(jevAsked(asking)).toBe(asking)
    })
  })

  describe('a decision, applied to the pickers it can override', () => {
    it('applies the provider, model and effort through the same paths a click would', () => {
      const asked = jevAsked(chooseProvider(opened(), 'claude'))

      const applied = jevAnswered(
        asked,
        decision({ provider: 'codex', model: 'gpt-5.6-sol', effort: 'high' })
      )

      expect(applied.choice).toBe('codex')
      expect(applied.model).toBe('gpt-5.6-sol')
      expect(applied.effort).toBe('high')
      expect(applied.jev.routing).toEqual({
        phase: 'decided',
        decision: decision({ provider: 'codex', model: 'gpt-5.6-sol', effort: 'high' })
      })
    })

    it('leaves model and effort unset when Jev named none — say nothing, not the first option', () => {
      const asked = jevAsked(opened())

      const applied = jevAnswered(asked, decision({ provider: 'claude' }))

      expect(applied.model).toBeNull()
      expect(applied.effort).toBeNull()
    })

    it('keeps the pre-decision pickers so they can be put back', () => {
      const asked = jevAsked(
        chooseEffort(chooseModel(chooseProvider(opened(), 'claude'), 'sonnet'), 'xhigh')
      )

      const applied = jevAnswered(asked, decision({ provider: 'codex' }))

      expect(applied.jev.previousChoice).toEqual({
        choice: 'claude',
        model: 'sonnet',
        effort: 'xhigh'
      })
    })

    it('ignores an answer that is not the ask this panel is waiting on', () => {
      const idle = opened()

      expect(jevAnswered(idle, decision())).toBe(idle)
    })
  })

  describe('a fallback, which touches no picker at all', () => {
    it('records the reason and leaves the pickers exactly as they were — #509’s own acceptance criterion', () => {
      const asked = jevAsked(chooseProvider(opened(), 'claude'))

      const fellBack = jevAnswered(asked, fallback({ reason: 'timeout' }))

      expect(fellBack.choice).toBe('claude')
      expect(fellBack.jev.routing).toEqual({
        phase: 'fellBack',
        reason: 'timeout',
        confidence: undefined
      })
      expect(fellBack.jev.previousChoice).toBeNull()
    })

    it('carries confidence only when the wire type sends one', () => {
      const asked = jevAsked(opened())

      const fellBack = jevAnswered(asked, fallback({ reason: 'low-confidence', confidence: 0.2 }))

      expect(fellBack.jev.routing).toEqual({
        phase: 'fellBack',
        reason: 'low-confidence',
        confidence: 0.2
      })
    })
  })

  /*
   * jev-routing-profiles T4. When the person has configured a default launch
   * in Settings and Jev itself could not decide, that default is APPLIED to
   * the pickers exactly like a decision would be — through the same
   * chooseProvider/chooseModel/chooseEffort paths, with previousChoice kept
   * so Dismiss can put things back — rather than leaving the composer on
   * whatever it already showed. A fallback with no configured default keeps
   * the untouched-pickers behaviour pinned in the block above.
   */
  describe('a fallback with a configured default (jev-routing-profiles T4)', () => {
    it('applies the default through the same paths a decision would, and keeps the pre-fallback pickers for Dismiss', () => {
      const asked = jevAsked(
        chooseEffort(chooseModel(chooseProvider(opened(), 'claude'), 'sonnet'), 'xhigh')
      )

      const fellBack = jevAnswered(
        asked,
        fallback({
          reason: 'unreachable',
          fallbackTo: { provider: 'codex', model: 'gpt-5.6-sol', effort: 'high' }
        })
      )

      expect(fellBack.choice).toBe('codex')
      expect(fellBack.model).toBe('gpt-5.6-sol')
      expect(fellBack.effort).toBe('high')
      expect(fellBack.jev.routing).toEqual({
        phase: 'fellBack',
        reason: 'unreachable',
        confidence: undefined,
        appliedDefault: { provider: 'codex', model: 'gpt-5.6-sol', effort: 'high' }
      })
      expect(fellBack.jev.previousChoice).toEqual({
        choice: 'claude',
        model: 'sonnet',
        effort: 'xhigh'
      })
    })

    it('leaves model and effort unset when the default named none — say nothing, not the first option', () => {
      const asked = jevAsked(opened())

      const fellBack = jevAnswered(asked, fallback({ fallbackTo: { provider: 'codex' } }))

      expect(fellBack.choice).toBe('codex')
      expect(fellBack.model).toBeNull()
      expect(fellBack.effort).toBeNull()
    })

    it('is put back by Dismiss exactly like a decision', () => {
      const asked = jevAsked(chooseProvider(opened(), 'claude'))
      const fellBack = jevAnswered(
        asked,
        fallback({ fallbackTo: { provider: 'codex', effort: 'high' } })
      )

      const cleared = clearJevDecision(fellBack)

      expect(cleared.choice).toBe('claude')
      expect(cleared.jev.routing).toEqual({ phase: 'idle' })
      expect(cleared.jev.previousChoice).toBeNull()
    })

    it('records whether it will fall straight through to a launch, off autoAccept — mirrors a decision', () => {
      const READY: JevSettings = { configured: true, preferences: DEFAULT_JEV_PREFERENCES }

      const off = jevAnswered(jevAsked(opened()), fallback({ fallbackTo: { provider: 'codex' } }))
      expect(off.jev.launchedOnFallback).toBe(false)

      const withAutoAccept = jevAnswered(
        jevAsked(toggleJevAutoAccept(setJevSettings(opened(), READY))),
        fallback({ fallbackTo: { provider: 'codex' } })
      )
      expect(withAutoAccept.jev.launchedOnFallback).toBe(true)
    })
  })

  describe('clearing a decision', () => {
    it('restores the pickers a decision overwrote', () => {
      const asked = jevAsked(
        chooseEffort(chooseModel(chooseProvider(opened(), 'claude'), 'sonnet'), 'xhigh')
      )
      const applied = jevAnswered(
        asked,
        decision({ provider: 'codex', model: 'gpt-5.6-sol', effort: 'high' })
      )

      const cleared = clearJevDecision(applied)

      expect(cleared.choice).toBe('claude')
      expect(cleared.model).toBe('sonnet')
      expect(cleared.effort).toBe('xhigh')
      expect(cleared.jev.routing).toEqual({ phase: 'idle' })
      expect(cleared.jev.previousChoice).toBeNull()
    })

    it('leaves the pickers alone for a fallback — there is nothing there to restore', () => {
      const asked = jevAsked(chooseProvider(opened(), 'claude'))
      const fellBack = jevAnswered(asked, fallback())

      const cleared = clearJevDecision(fellBack)

      expect(cleared.choice).toBe('claude')
      expect(cleared.jev.routing).toEqual({ phase: 'idle' })
    })

    it('is a no-op already idle', () => {
      const state = opened()

      expect(clearJevDecision(state)).toBe(state)
    })

    it('also drops a stale ask still in flight — an edited prompt outlives no answer it never got', () => {
      const asking = jevAsked(opened())

      expect(clearJevDecision(asking).jev.routing).toEqual({ phase: 'idle' })
    })
  })

  describe('shouldAskJev', () => {
    it('is true only once ready, enabled and idle', () => {
      const ready = toggleJev(setJevSettings(opened(), READY))

      expect(shouldAskJev(ready)).toBe(true)
    })

    it('is false while unavailable, while off, or once already asked', () => {
      expect(shouldAskJev(setJevSettings(opened(), UNAVAILABLE))).toBe(false)
      expect(shouldAskJev(setJevSettings(opened(), READY))).toBe(false)

      const ready = toggleJev(setJevSettings(opened(), READY))
      expect(shouldAskJev(jevAsked(ready))).toBe(false)
    })
  })

  /* --- MCP subtask delegation: the routedByJev marker (#511) — one block, appended --- */
  describe('routedByJev', () => {
    it('is false before anything has asked Jev', () => {
      expect(routedByJev(opened())).toBe(false)
    })

    it('is false while an ask is still in flight', () => {
      expect(routedByJev(jevAsked(opened()))).toBe(false)
    })

    it('is true once a decision has been applied', () => {
      const decided = jevAnswered(jevAsked(opened()), decision())

      expect(routedByJev(decided)).toBe(true)
    })

    // #511's own honesty rule, the same one `launchedOnFallback` already
    // holds: a fallback is never "routed by Jev", even the one case that
    // still applies a configured default to the pickers before falling
    // through on autoAccept.
    it('is false for a plain fallback', () => {
      const fellBack = jevAnswered(jevAsked(opened()), fallback())

      expect(routedByJev(fellBack)).toBe(false)
    })

    it('is false for a fallback that applied a configured default', () => {
      const fellBack = jevAnswered(
        jevAsked(opened()),
        fallback({ fallbackTo: { provider: 'claude' } })
      )

      expect(routedByJev(fellBack)).toBe(false)
    })

    it('drops back to false once the decision is dismissed', () => {
      const decided = jevAnswered(jevAsked(opened()), decision())

      expect(routedByJev(clearJevDecision(decided))).toBe(false)
    })
  })
  /* --- end of the #511 block ---------------------------------------------------- */
})

/*
 * Issue #523. The toggle becomes a full entry path: Jev exists to choose the
 * provider, so demanding a provider pick before it can be asked was the gate
 * this issue exists to open. What the gate then says — the same phases a
 * chosen chip reaches, and only for as long as the toggle stands — is all
 * here; what a decision and a fallback DO from the unlocked composer is the
 * composable's own detour, tested beside it.
 */
describe('the Jev entry path (#523)', () => {
  // AMENDED for the #509 follow-up: `preferences` is now a required part of
  // JevSettings, so these fixtures carry the documented default. No
  // assertion below changed.
  const READY: JevSettings = { configured: true, preferences: DEFAULT_JEV_PREFERENCES }
  const HIDDEN: JevSettings = { configured: false, preferences: DEFAULT_JEV_PREFERENCES }
  const UNAVAILABLE: JevSettings = {
    configured: false,
    unavailableReason: 'encryption-unavailable',
    preferences: DEFAULT_JEV_PREFERENCES
  }

  const jevOn = () => toggleJev(setJevSettings(opened(), READY))

  describe('the composer the toggle unlocks', () => {
    it('opens with no provider chip at all once the toggle is on', () => {
      const state = jevOn()

      expect(state.choice).toBeNull()
      expect(composerEnabled(state)).toBe(true)
      expect(composerPlaceholder(state)).toBe(COMPOSER_ENABLED_PLACEHOLDER)
    })

    it('re-locks when the toggle comes back off, and keeps what was typed', () => {
      const off = toggleJev(typePrompt(jevOn(), 'dig the east gallery'))

      expect(composerEnabled(off)).toBe(false)
      expect(composerPlaceholder(off)).toBe(COMPOSER_DISABLED_PLACEHOLDER)
      expect(off.prompt).toBe('dig the east gallery')
      expect(launchPhase(off)).toBe('provider-selection')
    })

    it('reaches the same phases a chosen chip reaches, gate for gate', () => {
      expect(launchPhase(jevOn())).toBe('known-provider-ready')

      const typed = typePrompt(jevOn(), 'dig')
      expect(launchPhase(typed)).toBe('prompt-ready')
      expect(canSubmit(typed)).toBe(true)
    })

    it('does not unlock Other without its committed command', () => {
      const state = toggleJev(setJevSettings(withOther(), READY))

      expect(composerEnabled(state)).toBe(false)
      expect(launchPhase(state)).toBe('other-command-required')
      expect(composerEnabled(commitCommand(typeCommand(state, 'lalolanda')))).toBe(true)
    })

    it('changes nothing while the toggle is off — every gate stays as it was', () => {
      const readyOff = setJevSettings(opened(), READY)

      expect(composerEnabled(readyOff)).toBe(false)
      expect(launchPhase(readyOff)).toBe('provider-selection')
      expect(launchPhase(typePrompt(readyOff, 'dig'))).toBe('provider-selection')
    })

    it('does not unlock an unavailable Jev, however its toggle is pressed', () => {
      expect(composerEnabled(toggleJev(setJevSettings(opened(), UNAVAILABLE)))).toBe(false)
    })
  })

  describe('the auto-accept checkbox', () => {
    // request v2 (jev-routing-profiles T3): mechanical fixture update, same
    // as `decision()` above — this block only exercises the toggle, not the
    // decision's own content.
    const DECISION: JevRouteLaunchResult = {
      kind: 'decision',
      provider: 'codex',
      confidence: 0.9,
      truncated: false,
      tier: 'balanced',
      parts: {
        provider: { value: 'codex', confidence: 0.9, applied: 'answered' },
        tier: { value: 'balanced', confidence: 0.9, applied: 'answered' },
        trivial: { value: false, probability: 0.05 },
        largeContext: { value: false, probability: 0.05 },
        // #608: mechanical fixture update, same as `decision()` above.
        model: { applied: 'safe-default', reason: 'no-live-model' }
      }
    }

    it('starts off — the person’s own choice for this session, never assumed, like enabled', () => {
      expect(closedLaunch().jev.autoAccept).toBe(false)
      expect(setJevSettings(opened(), READY).jev.autoAccept).toBe(false)
    })

    it('flips on and off once ready, and does nothing outside ready', () => {
      const ready = setJevSettings(opened(), READY)

      expect(toggleJevAutoAccept(ready).jev.autoAccept).toBe(true)
      expect(toggleJevAutoAccept(toggleJevAutoAccept(ready)).jev.autoAccept).toBe(false)
      expect(toggleJevAutoAccept(setJevSettings(opened(), UNAVAILABLE)).jev.autoAccept).toBe(false)
      expect(toggleJevAutoAccept(setJevSettings(opened(), HIDDEN)).jev.autoAccept).toBe(false)
    })

    it('is pressable with the Jev toggle still off — it configures the next ask, not this one', () => {
      const state = toggleJevAutoAccept(setJevSettings(opened(), READY))

      expect(state.jev.enabled).toBe(false)
      expect(state.jev.autoAccept).toBe(true)
    })

    it('rides the same availability guard as enabled when settings stop being ready', () => {
      const wasOn = toggleJevAutoAccept(setJevSettings(opened(), READY))
      expect(wasOn.jev.autoAccept).toBe(true)

      expect(setJevSettings(wasOn, HIDDEN).jev.autoAccept).toBe(false)
      expect(setJevSettings(wasOn, UNAVAILABLE).jev.autoAccept).toBe(false)
    })

    it('survives a settings answer that keeps it ready, and a toggle of Jev itself', () => {
      const on = toggleJevAutoAccept(setJevSettings(opened(), READY))

      expect(setJevSettings(on, READY).jev.autoAccept).toBe(true)
      expect(toggleJev(on).jev.autoAccept).toBe(true)
    })

    it('is forgotten when the panel closes and reopens, like every other session choice', () => {
      const on = toggleJevAutoAccept(jevOn())

      expect(closeLaunch(on).jev.autoAccept).toBe(false)
      expect(openLaunch(on).jev.autoAccept).toBe(false)
    })

    it('collapses nothing in the pure model — the guard it drives lives in submit', () => {
      // The state says only what the person asked for; whether the Enter that
      // receives a decision stops at the card or falls through to a launch is
      // the composable's detour, asserted in useAgentLaunch.test.ts.
      const asked = jevAsked(jevOn())
      const applied = jevAnswered(asked, DECISION)

      expect(applied.jev.routing.phase).toBe('decided')
      expect(applied.choice).toBe('codex')
    })

    it('records that a decision itself accepted nothing — it carries no fallback promise', () => {
      const applied = jevAnswered(jevAsked(jevOn()), DECISION)

      expect(applied.jev.launchedOnFallback).toBe(false)
    })
  })

  describe('what a fallback line is allowed to promise', () => {
    const FALLBACK: JevRouteLaunchResult = { kind: 'fallback', reason: 'unreachable' }

    it('records that a fallback onto chosen pickers launched — #509’s original case', () => {
      const fellBack = jevAnswered(jevAsked(chooseProvider(opened(), 'claude')), FALLBACK)

      expect(fellBack.jev.routing.phase).toBe('fellBack')
      expect(fellBack.jev.launchedOnFallback).toBe(true)
    })

    it('records that a fallback with no chip launched nothing — the #523 case', () => {
      const fellBack = jevAnswered(jevAsked(jevOn()), FALLBACK)

      expect(fellBack.jev.routing.phase).toBe('fellBack')
      expect(fellBack.choice).toBeNull()
      expect(fellBack.jev.launchedOnFallback).toBe(false)
    })

    it('keeps its promise across the gates, but not across the answer it describes', () => {
      // A stale fallback line must not outlive its prompt — clearJevDecision
      // already returns the routing to idle, and the promise belongs to that
      // routing, so it goes with it.
      const fellBack = jevAnswered(jevAsked(chooseProvider(opened(), 'claude')), FALLBACK)

      expect(clearJevDecision(fellBack).jev.routing).toEqual({ phase: 'idle' })
      expect(clearJevDecision(fellBack).jev.launchedOnFallback).toBe(false)
    })

    it('is false before any fallback has ever arrived', () => {
      expect(opened().jev.launchedOnFallback).toBe(false)
      expect(chooseProvider(opened(), 'claude').jev.launchedOnFallback).toBe(false)
    })
  })
})
