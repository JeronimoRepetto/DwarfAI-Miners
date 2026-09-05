import { describe, expect, it } from 'vitest'
// #168 additions are asserted in their own describe at the foot of this file.
import { MAX_DWARF_TEXT_CHARS } from '../../types'
import {
  COMPOSER_DISABLED_PLACEHOLDER,
  COMPOSER_ENABLED_PLACEHOLDER,
  COMMAND_PLACEHOLDER,
  OTHER_CHOICE,
  adoptLaunchedDwarf,
  closeLaunch,
  closedLaunch,
  commitCommand,
  composerEnabled,
  composerPlaceholder,
  chooseProvider,
  launchPhase,
  launchPrompt,
  openLaunch,
  submitRefused,
  startedDetached,
  submitStarted,
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

  it('trims and caps the prompt exactly as main prepares it', () => {
    expect(launchPrompt(ready())).toBe('dig here')
    expect(
      launchPrompt(typePrompt(withClaude(), 'x'.repeat(MAX_DWARF_TEXT_CHARS + 50)))
    ).toHaveLength(MAX_DWARF_TEXT_CHARS)
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
