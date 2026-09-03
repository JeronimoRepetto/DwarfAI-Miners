// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import {
  COMMAND_PLACEHOLDER,
  COMPOSER_DISABLED_PLACEHOLDER,
  COMPOSER_ENABLED_PLACEHOLDER,
  OTHER_CHOICE,
  type LaunchPhase
} from '../../lib/launch/launchState'
import { providerChips } from '../../lib/launch/providerChips'
import { MAX_DWARF_TEXT_CHARS, type AgentProviderOption } from '../../types'
import AddPanel from './AddPanel.vue'

const CLAUDE: AgentProviderOption = { provider: 'claude', installed: true, launchable: true }
const CODEX: AgentProviderOption = {
  provider: 'codex',
  installed: true,
  launchable: false,
  reason: 'Only Claude can be started from the panel today.'
}

function panel(overrides: Partial<Record<string, unknown>> = {}) {
  const chosen = (overrides.chosen ?? null) as 'claude' | 'codex' | typeof OTHER_CHOICE | null
  return mount(AddPanel, {
    props: {
      chips: providerChips([CLAUDE, CODEX], chosen),
      phase: (overrides.phase ?? 'provider-selection') as LaunchPhase,
      enabled: (overrides.enabled ?? false) as boolean,
      placeholder: (overrides.placeholder ?? COMPOSER_DISABLED_PLACEHOLDER) as string,
      command: (overrides.command ?? '') as string,
      prompt: (overrides.prompt ?? '') as string,
      refusal: (overrides.refusal ?? null) as string | null,
      error: (overrides.error ?? null) as string | null
    }
  })
}

describe('the chip row', () => {
  it('draws one chip per detected provider, with Other last', () => {
    const chips = panel().findAll('.provider-chip')

    expect(chips.map((chip) => chip.text())).toEqual(['claude', 'codex', 'Other'])
  })

  it('publishes each chip’s state, so the design’s three treatments are drawable', () => {
    const chips = panel({ chosen: 'claude' }).findAll('.provider-chip')

    expect(chips.map((chip) => chip.attributes('data-state'))).toEqual([
      'selected',
      'unselected',
      'unselected'
    ])
  })

  it('asks for the chip that was clicked and decides nothing itself', async () => {
    const wrapper = panel()

    await wrapper.findAll('.provider-chip')[1]?.trigger('click')

    expect(wrapper.emitted('choose')).toEqual([['codex']])
  })

  it('says which chip is pressed for anything not looking at it', () => {
    const chips = panel({ chosen: OTHER_CHOICE }).findAll('.provider-chip')

    expect(chips.map((chip) => chip.attributes('aria-pressed'))).toEqual(['false', 'false', 'true'])
  })
})

describe('the composer gate', () => {
  it('is disabled with the source’s instruction before a choice', () => {
    const composer = panel().get('.launch-input')

    expect(composer.attributes('disabled')).toBeDefined()
    expect(composer.attributes('placeholder')).toBe(COMPOSER_DISABLED_PLACEHOLDER)
  })

  it('is enabled and invites a prompt once the gate opens', () => {
    const composer = panel({
      chosen: 'claude',
      phase: 'known-provider-ready',
      enabled: true,
      placeholder: COMPOSER_ENABLED_PLACEHOLDER
    }).get('.launch-input')

    expect(composer.attributes('disabled')).toBeUndefined()
    expect(composer.attributes('placeholder')).toBe(COMPOSER_ENABLED_PLACEHOLDER)
  })

  it('caps the prompt at the same length a delivered message is capped at', () => {
    expect(panel().get('.launch-input').attributes('maxlength')).toBe(String(MAX_DWARF_TEXT_CHARS))
  })
})

describe('the custom-command input', () => {
  it('is absent until Other is chosen', () => {
    expect(
      panel({ chosen: 'claude', phase: 'known-provider-ready' }).find('.launch-command').exists()
    ).toBe(false)
  })

  it('appears with the source’s own placeholder when Other is chosen', () => {
    const command = panel({ chosen: OTHER_CHOICE, phase: 'other-command-required' }).get(
      '.launch-command'
    )

    expect(command.attributes('placeholder')).toBe(COMMAND_PLACEHOLDER)
  })

  it('commits on Enter and reports what was typed', async () => {
    const wrapper = panel({ chosen: OTHER_CHOICE, phase: 'other-command-required' })
    const command = wrapper.get('.launch-command')

    await command.setValue('lalolanda')
    await command.trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('command')?.at(-1)).toEqual(['lalolanda'])
    expect(wrapper.emitted('commit')).toHaveLength(1)
  })
})

describe('sending the first prompt', () => {
  function ready(overrides: Record<string, unknown> = {}) {
    return panel({
      chosen: 'claude',
      phase: 'prompt-ready',
      enabled: true,
      placeholder: COMPOSER_ENABLED_PLACEHOLDER,
      prompt: 'dig here',
      ...overrides
    })
  }

  it('submits on Enter', async () => {
    const wrapper = ready()

    await wrapper.get('.launch-input').trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('submit')).toHaveLength(1)
  })

  it('writes a newline on Shift+Enter instead of submitting', async () => {
    const wrapper = ready()

    await wrapper.get('.launch-input').trigger('keydown', { key: 'Enter', shiftKey: true })

    expect(wrapper.emitted('submit')).toBeUndefined()
  })

  it('does not submit from a composer the gate has not opened', async () => {
    const wrapper = panel({ chosen: OTHER_CHOICE, phase: 'other-command-required' })

    await wrapper.get('.launch-input').trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('submit')).toBeUndefined()
  })
})

describe('what the panel says out loud', () => {
  it('states why the chosen chip cannot start a session', () => {
    const wrapper = panel({ chosen: 'codex', phase: 'known-provider-ready', refusal: CODEX.reason })

    expect(wrapper.get('.launch-note').text()).toBe(CODEX.reason)
  })

  it('carries a refused launch’s own reason, in its own alert', () => {
    const wrapper = panel({
      chosen: 'claude',
      phase: 'prompt-ready',
      enabled: true,
      error: 'Claude Code is not installed on this machine.'
    })

    expect(wrapper.get('.launch-alert').text()).toBe(
      'Claude Code is not installed on this machine.'
    )
  })

  it('closes when its close control is used', async () => {
    const wrapper = panel()

    await wrapper.get('.launch-close').trigger('click')

    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('closes on Escape, as every panel here does', async () => {
    const wrapper = panel()

    await wrapper.get('.add-panel').trigger('keydown.escape')

    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})

describe('while the session is starting', () => {
  function spawning() {
    return panel({
      chosen: 'claude',
      phase: 'submitted-spawning',
      enabled: true,
      prompt: 'dig the east gallery'
    })
  }

  /*
   * `launch.md` step 3 — insert the submitted prompt as the conversation's
   * first message — happens here rather than being invented: between Enter and
   * the dwarf's arrival there is no MessagePanel to hold it, and this is the
   * one window in which the prompt exists nowhere else on screen. Once the
   * dwarf lands, the MessagePanel draws main's own record of it and this view
   * is gone, so it is never shown twice.
   */
  it('shows the submitted prompt where its first message belongs', () => {
    expect(spawning().get('.launch-first-message').text()).toBe('dig the east gallery')
  })

  it('says a session is starting rather than looking like nothing happened', () => {
    expect(spawning().get('.launch-note').text()).toBeTruthy()
  })

  it('takes the chips and the composer away while one is in flight', () => {
    const wrapper = spawning()

    expect(wrapper.find('.provider-chip').exists()).toBe(false)
    expect(wrapper.find('.launch-input').exists()).toBe(false)
  })

  it('can still be closed, so a launch that never lands is not a trap', async () => {
    const wrapper = spawning()

    await wrapper.get('.launch-close').trigger('click')

    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})

/*
 * The end of a launch this panel cannot watch (#168).
 *
 * A detached launch — Codex's only shape, because it has no held-session engine
 * in this app — leaves no receipt for `launchedDwarfIn` to match, so no
 * MessagePanel hand-over is coming. The panel therefore has to say what it
 * actually knows and stop, rather than sitting in the spawning view watching
 * for an arrival it knows cannot happen.
 */
describe('after a session the panel cannot watch has started', () => {
  function detached() {
    return panel({
      chosen: 'codex',
      phase: 'started-detached',
      enabled: true,
      prompt: 'dig the east gallery'
    })
  }

  it('says the session started and where its dwarf will turn up', () => {
    const note = detached().get('.launch-note').text()

    expect(note).toBeTruthy()
    expect(note.toLowerCase()).toContain('mine')
  })

  it('never claims the panel is still looking for it', () => {
    // The spawning copy promises the panel will find it. That promise cannot be
    // kept for a detached launch, so this state must not borrow the wording.
    expect(detached().get('.launch-note').text().toLowerCase()).not.toContain('as soon as')
  })

  it('takes the composer away, so the same prompt is not sent twice', () => {
    const wrapper = detached()

    expect(wrapper.find('.launch-input').exists()).toBe(false)
    expect(wrapper.find('.provider-chip').exists()).toBe(false)
  })

  it('can be closed, which is the only way out of it', async () => {
    const wrapper = detached()

    await wrapper.get('.launch-close').trigger('click')

    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})
