// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { DEFAULT_OPENCODE_SETTINGS, type OpenCodeSettings as Settings } from '../../types'
import OpenCodeSettings from './OpenCodeSettings.vue'

/**
 * Settings' OpenCode section (#588 T6): the consent to the permission relay,
 * and the optional server password. Presentational like every settings
 * piece — main's verdict in, intents out.
 *
 * AMENDED (#635): drawn as the design's two rows of Settings › Integrations. The switch is a
 * switch (aria-checked), the consent and the password hint are the rows' help lines, and the
 * field is the design's input, its native control inside the `.opencode-password-input` well.
 */
const CONSENT = '.opencode-settings .dm-srow__help'
const PASSWORD_HINT = '.opencode-password .dm-srow__help'
const FIELD = '.opencode-password-input input'
function render(settings: Partial<Settings> = {}, applying = false) {
  return mount(OpenCodeSettings, {
    props: { settings: { ...DEFAULT_OPENCODE_SETTINGS, ...settings }, applying }
  })
}

describe('OpenCodeSettings — the relay consent (#588 T6)', () => {
  it('names the section and draws the switch in the state main stored', () => {
    expect(render().text()).toContain('OpenCode')
    expect(render().find('.opencode-plugin-enabled').attributes('aria-checked')).toBe('false')
    expect(
      render({ pluginEnabled: true }).find('.opencode-plugin-enabled').attributes('aria-checked')
    ).toBe('true')
  })

  // AMENDED (ISSUE-264, DG-22): the consent paragraph is design's to deliver again. The old one
  // said the plugin file holds the token Claude Code's route trusts; under ADR-016 item 1 the
  // Host's writer bakes the plugin channel's own `openCodePluginToken`
  // (host/modules/preferences/adapters/external-config/openCodePlugin/pluginArtifact.ts), so the
  // row keeps the marker key and never the old sentence (US-SET-009.AC01, TC-264-03).
  it('says what turning it on writes, and where, before the person consents', () => {
    const consent = render().find(CONSENT).text()
    expect(consent).toMatch(/COPY NEEDED: DG-22/)
    expect(consent).toMatch(/OpenCode/)
  })

  // AMENDED (ISSUE-264, DG-22): was "states the token coupling in the consent itself (#588 T3
  // finding D4)". The coupling D4 found is gone in the Host's writer (ADR-016 item 1: one token
  // per channel), so the row must no longer claim it.
  it('never claims the plugin file holds the token Claude Code’s route trusts (ADR-016 item 1)', () => {
    const consent = render().find(CONSENT).text()
    expect(consent).not.toMatch(/plain text/i)
    expect(consent).not.toMatch(/same token/i)
    expect(consent).not.toMatch(/Claude Code/)
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
    const hint = render().find(PASSWORD_HINT).text()
    expect(hint).toContain('OPENCODE_SERVER_PASSWORD')
    expect(hint).toMatch(/empty/i)
  })

  it('offers a masked input while none is stored, and submits what was typed', async () => {
    const wrapper = render()
    const input = wrapper.find(FIELD)
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
    expect(wrapper.find(FIELD).exists()).toBe(false)
    expect(wrapper.text()).toContain('Password stored')
    await wrapper.find('.opencode-password-clear').trigger('click')
    expect(wrapper.emitted('password-clear')).toHaveLength(1)
    await wrapper.find('.opencode-password-replace').trigger('click')
    expect(wrapper.find(FIELD).exists()).toBe(true)
  })

  it('says why the field cannot be set on a machine that offers no encryption', () => {
    const wrapper = render({ passwordUnavailableReason: 'encryption-unavailable' })
    expect(wrapper.find(FIELD).exists()).toBe(false)
    expect(wrapper.find('.password-unavailable').text()).toMatch(/encrypt/i)
  })
})

/*
 * ISSUE-264 (EPIC-16) — APPENDED: the permission-requests help paragraph (US-SET-009.AC01). The
 * design's paragraph (DwarfAI-Miners-Design d12d3fc, settings.js:195) is not shipped: its second
 * sentence is false under ADR-016 item 1, so the row shows the DG-22 marker key until design
 * delivers the paragraph (DR-06; TC-264-03).
 */
describe('OpenCodeSettings — the DG-22 help paragraph (ISSUE-264)', () => {
  it("[US-SET-009.AC01] the OpenCode permission-requests help paragraph is the design's delivered string", () => {
    const wrapper = render({ pluginEnabled: true })
    expect(wrapper.get('.opencode-settings .dm-srow__label').text()).toBe(
      'OpenCode · permission requests'
    )
    expect(wrapper.get(CONSENT).text()).toBe(
      '⟦COPY NEEDED: DG-22 OpenCode permission-requests help paragraph⟧'
    )
    expect(wrapper.get('.opencode-plugin-enabled').attributes('aria-label')).toBe(
      'Answer OpenCode permission requests from the panel'
    )
  })
})
