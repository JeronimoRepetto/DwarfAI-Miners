import { describe, expect, it } from 'vitest'
import type { AgentProviderOption } from '../../types'
import { OTHER_CHOICE } from './launchState'
import { OTHER_CHIP_LABEL, OTHER_NOT_BUILT, launchRefusal, providerChips } from './providerChips'

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
   * The engine has no custom-command path at all: both launch channels carry a
   * mine and a prompt, and resolve the CLI themselves. So Other is offered
   * exactly as the design draws it and refuses at the point of submission with
   * the reason, rather than being silently absent or silently inert.
   */
  it('refuses a custom command, because no engine takes one', () => {
    expect(launchRefusal([claude], OTHER_CHOICE)).toBe(OTHER_NOT_BUILT)
  })

  it('refuses a provider that is not on the detected list at all', () => {
    expect(launchRefusal([], 'claude')).not.toBeNull()
  })
})
