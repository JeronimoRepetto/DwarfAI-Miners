import { describe, expect, it } from 'vitest'
import type { AgentProviderOption } from '../../types'
import { OTHER_CHOICE } from './launchState'
import { NOT_DETECTED, OTHER_CHIP_LABEL, launchRefusal, providerChips } from './providerChips'

/*
 * ## Two tests were REPLACED here, for #194
 *
 * `docs/custom-launch-command.md` ruled in #168 that the panel would not start
 * a command of your own, and two tests below pinned that ruling and its copy:
 *
 * - "refuses a custom command, because nothing could observe what it started"
 * - "gives the refusal a reason, not a promise that it is coming"
 *
 * The maintainer reversed the ruling on 2026-09-04: the panel observes
 * terminals AND is a terminal itself, so a process the panel HOLDS needs no
 * session file to be observed. `OTHER_NOT_LAUNCHABLE` is gone from
 * providerChips.ts, and neither test has a subject any more — the first
 * asserted a refusal that must not happen, and the second asserted the wording
 * of a constant that no longer exists.
 *
 * They are replaced rather than deleted: the case they covered — what Enter on
 * Other does — is still tested, and now asserts a launch instead of a no. What
 * the old ruling was FOR is preserved in the doc, which states the reversal and
 * what the new behaviour does not promise.
 */

const claude: AgentProviderOption = { provider: 'claude', installed: true, launchable: true }
const codex: AgentProviderOption = {
  provider: 'codex',
  installed: true,
  launchable: false,
  reason: 'Only Claude can be started from the panel today.'
}
const absentCodex: AgentProviderOption = { provider: 'codex', installed: false, launchable: false }

describe('which chips the Add Panel draws', () => {
  it('draws a chip for each DETECTED provider and never for an absent one', () => {
    const chips = providerChips([claude, absentCodex], null)

    expect(chips.map((chip) => chip.choice)).toEqual(['claude', OTHER_CHOICE])
  })

  it('appends Other even when nothing at all was detected', () => {
    const chips = providerChips([], null)

    expect(chips).toHaveLength(1)
    expect(chips[0]?.choice).toBe(OTHER_CHOICE)
    expect(chips[0]?.label).toBe(OTHER_CHIP_LABEL)
  })

  /*
   * The v2 mockup's six names are illustrative — `components.md` says so in as
   * many words, because runtime detection controls which known providers
   * appear. A hardcoded row would be a screenshot, not a panel.
   */
  it('takes the list from detection rather than from the mockup', () => {
    expect(providerChips([codex], null).map((chip) => chip.label)).toEqual(['codex', 'Other'])
  })
})

describe('the three chip states the design specifies', () => {
  it('draws every chip in its default state before any choice', () => {
    expect(providerChips([claude, codex], null).map((chip) => chip.state)).toEqual([
      'default',
      'default',
      'default'
    ])
  })

  it('draws the chosen chip selected and dims the rest once a choice is made', () => {
    expect(providerChips([claude, codex], 'claude').map((chip) => chip.state)).toEqual([
      'selected',
      'unselected',
      'unselected'
    ])
  })

  it('selects Other like any other chip', () => {
    expect(providerChips([claude], OTHER_CHOICE).map((chip) => chip.state)).toEqual([
      'unselected',
      'selected'
    ])
  })
})

describe('what a chip cannot actually start', () => {
  it('refuses nothing while a launchable provider is chosen', () => {
    expect(launchRefusal([claude], 'claude')).toBeNull()
  })

  it('refuses nothing before a choice is made', () => {
    expect(launchRefusal([claude], null)).toBeNull()
  })

  /*
   * A detected provider with no launch path is still drawn, because the design
   * draws detected providers. What it does not do is answer Enter with silence:
   * main already said why it cannot start, and that reason is repeated rather
   * than reworded here — the panel renders what main verified.
   */
  it('repeats main’s own reason for a detected provider it cannot start', () => {
    expect(launchRefusal([claude, codex], 'codex')).toBe(codex.reason)
  })

  /*
   * The reversal (#194) — this is what replaces the two tests named in the
   * block at the top of this file. Other has no chip-level refusal at all: the
   * things that can go wrong with a custom command are only knowable once there
   * IS one, and main answers every one of them with the string in hand.
   */
  it('refuses nothing for a custom command, because the command is main’s to judge', () => {
    expect(launchRefusal([claude], OTHER_CHOICE)).toBeNull()
  })

  it('refuses nothing for Other even when no provider was detected at all', () => {
    // The chip is always there, so it must be launchable in the state the
    // design guarantees is always reachable: nothing installed, Other alone.
    expect(launchRefusal([], OTHER_CHOICE)).toBeNull()
  })

  it('still refuses a detected provider main said it cannot start', () => {
    // The reversal is about Other and nothing else. A chip-level refusal that
    // repeats main's reason is unchanged.
    expect(launchRefusal([absentCodex], 'codex')).toBe(NOT_DETECTED)
  })

  it('refuses a provider that is not on the detected list at all', () => {
    expect(launchRefusal([], 'claude')).not.toBeNull()
  })
})
