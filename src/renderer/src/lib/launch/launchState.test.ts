import { describe, expect, it } from 'vitest'
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
