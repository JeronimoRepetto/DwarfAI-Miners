// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { DEFAULT_OPENCODE_SETTINGS, type OpenCodeSettings as Settings } from '../../types'
import OpenCodeSettings from './OpenCodeSettings.vue'

/**
 * Settings' OpenCode section (#588 T6): the consent to the permission relay,
 * and the optional server password. Presentational like every settings
 * piece — main's verdict in, intents out.
 */
function render(settings: Partial<Settings> = {}, applying = false) {
  return mount(OpenCodeSettings, {
    props: { settings: { ...DEFAULT_OPENCODE_SETTINGS, ...settings }, applying }
  })
}

describe('OpenCodeSettings — the relay consent (#588 T6)', () => {
  it('names the section and draws the switch in the state main stored', () => {
    expect(render().text()).toContain('OpenCode')
    expect(render().find('.opencode-plugin-enabled').attributes('aria-pressed')).toBe('false')
    expect(
      render({ pluginEnabled: true }).find('.opencode-plugin-enabled').attributes('aria-pressed')
    ).toBe('true')
  })

  it('says what turning it on writes, and where, before the person consents', () => {
    const consent = render().find('.consent').text()
    expect(consent).toMatch(/plugin file/i)
    expect(consent).toMatch(/OpenCode/)
  })

  it('states the token coupling in the consent itself (#588 T3 finding D4)', () => {
    // The file holds, in plain text, the token the Claude route also trusts:
    // reading it is enough to forge Claude events. That has to be said where
    // the person decides, not only in a code comment.
    const consent = render().find('.consent').text()
    expect(consent).toMatch(/plain text/i)
    expect(consent).toMatch(/same token/i)
    expect(consent).toMatch(/Claude Code/)
  })

  it('asks for the opposite state when pressed, and never while a request is in flight', async () => {
    const wrapper = render({ pluginEnabled: false })
    await wrapper.find('.opencode-plugin-enabled').trigger('click')
    expect(wrapper.emitted('plugin-change')).toEqual([[true]])

    const busy = render({ pluginEnabled: false }, true)
    expect(busy.find('.opencode-plugin-enabled').attributes('disabled')).toBeDefined()
  })

  it('shows why the relay could not be turned on', () => {
    const wrapper = render({ pluginError: 'Port 47821 could not be opened: EADDRINUSE' })
    expect(wrapper.find('.plugin-error').text()).toContain('EADDRINUSE')
    expect(wrapper.find('.plugin-error').attributes('role')).toBe('alert')
  })
})

describe('OpenCodeSettings — the server password (#588 T6, F1)', () => {
  it('is optional: an empty field says no password is needed by default', () => {
    const hint = render().find('.password-hint').text()
    expect(hint).toContain('OPENCODE_SERVER_PASSWORD')
    expect(hint).toMatch(/empty/i)
  })

  it('offers a masked input while none is stored, and submits what was typed', async () => {
    const wrapper = render()
    const input = wrapper.find('.opencode-password-input')
    expect(input.attributes('type')).toBe('password')
    await input.setValue('hunter2')
    await wrapper.find('.opencode-password-save').trigger('click')
    expect(wrapper.emitted('password-save')).toEqual([['hunter2']])
  })

  it('never offers to save an empty field', () => {
    expect(render().find('.opencode-password-save').attributes('disabled')).toBeDefined()
  })

  it('once stored, shows only that one is stored -- never the password -- with replace and clear', async () => {
    const wrapper = render({ passwordConfigured: true })
    expect(wrapper.find('.opencode-password-input').exists()).toBe(false)
    expect(wrapper.text()).toContain('Password stored')
    await wrapper.find('.opencode-password-clear').trigger('click')
    expect(wrapper.emitted('password-clear')).toHaveLength(1)
    await wrapper.find('.opencode-password-replace').trigger('click')
    expect(wrapper.find('.opencode-password-input').exists()).toBe(true)
  })

  it('says why the field cannot be set on a machine that offers no encryption', () => {
    const wrapper = render({ passwordUnavailableReason: 'encryption-unavailable' })
    expect(wrapper.find('.opencode-password-input').exists()).toBe(false)
    expect(wrapper.find('.password-unavailable').text()).toMatch(/encrypt/i)
  })
})
