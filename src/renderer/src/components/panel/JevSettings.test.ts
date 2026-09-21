// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { JevSettings as JevSettingsType } from '../../types'
import JevSettings from './JevSettings.vue'

/**
 * The Jev section of the Settings screen (#509): the TypeSafe API key the
 * person enters, replaces and clears — this app never ships or generates
 * one — and the privacy notice the new outbound call requires.
 *
 * Presentational like every other settings piece: the stored verdict arrives
 * as a prop and every intent leaves as an event, so App.vue keeps owning the
 * IPC. The one thing kept LOCAL is the draft text of an unsaved key, which is
 * pure display state nothing outside this screen ever needs — the key itself
 * never reaches a store or a wire.
 */
function render(settings: JevSettingsType, props: Record<string, unknown> = {}) {
  return mount(JevSettings, { props: { settings, saving: false, ...props } })
}

describe('JevSettings — rendering, not configured', () => {
  it('names the section', () => {
    expect(render({ configured: false }).text()).toContain('Jev')
  })

  it('offers a password-type input for the key, and a Save control', () => {
    const wrapper = render({ configured: false })
    const input = wrapper.find('.jev-key-input')
    expect(input.attributes('type')).toBe('password')
    expect(wrapper.find('.jev-save').exists()).toBe(true)
  })

  it('disables Save while the field is empty', () => {
    expect(render({ configured: false }).find('.jev-save').attributes('disabled')).toBeDefined()
  })

  it('never shows the Configured state without a key', () => {
    expect(render({ configured: false }).find('.jev-configured').exists()).toBe(false)
  })

  it('states plainly what leaves this machine and when, and where the key goes', () => {
    // #509's own constraint: the prompt and the provider/model list are sent
    // to TypeSafe's API when a session launches, and the key rides along as
    // the bearer token of that same request. A vague "Jev talks to a server"
    // would not be the honest notice this feature requires — and neither
    // would claiming the key never leaves, because it does, to exactly one
    // place.
    const notice = render({ configured: false }).find('.privacy-notice').text()
    expect(notice).toContain('api.typesafe.ai')
    expect(notice).toContain('prompt')
    expect(notice.toLowerCase()).toContain('encrypted')
    expect(notice).toContain('sent only to TypeSafe')
    expect(notice).not.toContain('never leaves')
  })
})

describe('JevSettings — typing and saving a key', () => {
  it('binds the input by hand (:value/@input), never v-model', async () => {
    // Same rule AudioSettings holds for its sliders: this asks, and redraws
    // only from what it was given, so a value main never confirmed cannot
    // sit in the box as if it had been.
    const wrapper = render({ configured: false })
    const input = wrapper.find('.jev-key-input')
    ;(input.element as HTMLInputElement).value = 'sk-typesafe-abc123'
    await input.trigger('input')
    expect((input.element as HTMLInputElement).value).toBe('sk-typesafe-abc123')
  })

  it('enables Save once something is typed', async () => {
    const wrapper = render({ configured: false })
    const input = wrapper.find('.jev-key-input')
    ;(input.element as HTMLInputElement).value = 'sk-typesafe-abc123'
    await input.trigger('input')
    expect(wrapper.find('.jev-save').attributes('disabled')).toBeUndefined()
  })

  it('emits save with the typed key on submit', async () => {
    const wrapper = render({ configured: false })
    const input = wrapper.find('.jev-key-input')
    ;(input.element as HTMLInputElement).value = 'sk-typesafe-abc123'
    await input.trigger('input')
    await wrapper.find('.jev-save').trigger('click')
    expect(wrapper.emitted('save')).toEqual([['sk-typesafe-abc123']])
  })

  it('disables Save while a save is already in flight', () => {
    const wrapper = render({ configured: false }, { saving: true })
    expect(wrapper.find('.jev-save').attributes('disabled')).toBeDefined()
  })

  it('clears the draft after a confirmed save, returning to the Configured state', async () => {
    const wrapper = render({ configured: false }, { saving: true })
    const input = wrapper.find('.jev-key-input')
    ;(input.element as HTMLInputElement).value = 'sk-typesafe-abc123'
    await input.trigger('input')

    // The confirmation: main answered configured while saving settled.
    await wrapper.setProps({ saving: false, settings: { configured: true } })
    expect(wrapper.find('.jev-key-input').exists()).toBe(false)
    expect(wrapper.find('.jev-configured').exists()).toBe(true)
  })

  it('keeps the draft when a save does not take, so the person need not retype it', async () => {
    const wrapper = render({ configured: false }, { saving: true })
    const input = wrapper.find('.jev-key-input')
    ;(input.element as HTMLInputElement).value = 'sk-typesafe-abc123'
    await input.trigger('input')

    // Refused: saving settled but main still reports unconfigured.
    await wrapper.setProps({ saving: false, settings: { configured: false } })
    expect((wrapper.find('.jev-key-input').element as HTMLInputElement).value).toBe(
      'sk-typesafe-abc123'
    )
  })
})

describe('JevSettings — the Configured state', () => {
  it('shows Configured with Replace and Clear, and no input', () => {
    const wrapper = render({ configured: true })
    expect(wrapper.find('.jev-configured').exists()).toBe(true)
    expect(wrapper.find('.jev-replace').exists()).toBe(true)
    expect(wrapper.find('.jev-clear').exists()).toBe(true)
    expect(wrapper.find('.jev-key-input').exists()).toBe(false)
  })

  it('emits clear when Clear is pressed', async () => {
    const wrapper = render({ configured: true })
    await wrapper.find('.jev-clear').trigger('click')
    expect(wrapper.emitted('clear')).toHaveLength(1)
  })

  it('shows the input again from Replace, to enter a new key over the old one', async () => {
    const wrapper = render({ configured: true })
    await wrapper.find('.jev-replace').trigger('click')
    expect(wrapper.find('.jev-key-input').exists()).toBe(true)
    expect(wrapper.find('.jev-configured').exists()).toBe(false)
  })

  it('emits save with the new key from the Replace flow', async () => {
    const wrapper = render({ configured: true })
    await wrapper.find('.jev-replace').trigger('click')
    const input = wrapper.find('.jev-key-input')
    ;(input.element as HTMLInputElement).value = 'sk-typesafe-new'
    await input.trigger('input')
    await wrapper.find('.jev-save').trigger('click')
    expect(wrapper.emitted('save')).toEqual([['sk-typesafe-new']])
  })
})

describe('JevSettings — storage unavailable, no plaintext fallback', () => {
  it('shows the reason and hides the input and every control', () => {
    const wrapper = render({ configured: false, unavailableReason: 'encryption-unavailable' })
    expect(wrapper.find('.jev-key-input').exists()).toBe(false)
    expect(wrapper.find('.jev-save').exists()).toBe(false)
    expect(wrapper.find('.jev-configured').exists()).toBe(false)
    expect(wrapper.find('.jev-unavailable').exists()).toBe(true)
  })

  it('still draws the privacy notice — the section explains itself either way', () => {
    const wrapper = render({ configured: false, unavailableReason: 'encryption-unavailable' })
    expect(wrapper.find('.privacy-notice').exists()).toBe(true)
  })
})
