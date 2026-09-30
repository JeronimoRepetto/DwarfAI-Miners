// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_TOGGLE_ACCELERATOR } from '../../../../shared/accelerator'
import type { ShortcutState } from '../../types'
import {
  DEFAULT_AUDIO_PREFERENCES,
  DEFAULT_NOTIFICATIONS_ENABLED,
  /* --- Typography preferences (#370) — one block, appended ----------------- */
  DEFAULT_TYPOGRAPHY_PREFERENCES,
  /* --- end of the #370 block ----------------------------------------------- */
  /* --- Jev routing profiles: profile and defaults (#509 follow-up) — one block, appended --- */
  DEFAULT_JEV_PREFERENCES,
  /* --- end of the #509 follow-up block --------------------------------------- */
  /* --- OpenCode permission relay (#588 T6) — one block, appended ------------ */
  DEFAULT_OPENCODE_SETTINGS
  /* --- end of the #588 T6 block --------------------------------------------- */
} from '../../types'
import SettingsPanel from './SettingsPanel.vue'

/**
 * The redesigned Settings screen's container (#138, screens/settings.md):
 * the panel's own "Settings" title and divider, then every section in the
 * design's order — Panel shortcut, Position, Data Base — plus the
 * "Application" section the design itself does not draw (pin, hide panel,
 * version — #142 parked them with no design home; #138 gives them this
 * design's control styling and this explicit UNSPECIFIED placement).
 *
 * SettingsPanel stays presentational like every other settings piece: every
 * verdict arrives as a prop and every intent leaves as an event, so App.vue
 * keeps owning the IPC. The reset modal's OPEN/CLOSED state is the one
 * exception, kept local here — it is pure display state with nothing outside
 * this screen that ever needs to know it.
 */
function shortcutState(overrides: Partial<ShortcutState> = {}): ShortcutState {
  return {
    accelerator: DEFAULT_TOGGLE_ACCELERATOR,
    registered: true,
    platform: 'win32',
    ...overrides
  }
}

// AMENDED (#635): the props every render passes, apart, so a test that attaches the page to the
// document can pass the same ones.
function baseProps(): Record<string, unknown> {
  return {
    shortcutState: shortcutState(),
    shortcutError: null,
    shortcutRecording: false,
    shortcutApplying: false,
    edge: 'right',
    edgeApplying: false,
    pinned: true,
    pinTooltip: 'Pinned: the panel stays above other windows',
    versionText: '1.2.3',
    versionHint: 'Packaged build',
    resetting: false,
    resetError: null,
    audioSettings: { ...DEFAULT_AUDIO_PREFERENCES },
    // AMENDED for #316: one required prop added, the notifications switch.
    // No existing prop or assertion changed.
    notificationsEnabled: DEFAULT_NOTIFICATIONS_ENABLED,
    // AMENDED for #370: two more, the stored faces and whether a change is in
    // flight. No existing prop or assertion changed.
    typography: { ...DEFAULT_TYPOGRAPHY_PREFERENCES },
    typographyApplying: false,
    // AMENDED for #509: two more required props, the Jev API-key verdict and
    // whether a save/clear is in flight. No existing prop or assertion
    // changed.
    jevSettings: { configured: false, preferences: DEFAULT_JEV_PREFERENCES },
    jevSaving: false,
    // AMENDED for the #509 follow-up: two more required props, the
    // launchable providers and model catalogues the default-launch pickers
    // draw from. No existing prop or assertion changed.
    jevProviders: [],
    jevCatalogs: [],
    // AMENDED for #588 T6: two more required props, the OpenCode section's
    // verdict and whether a request is in flight. No existing prop or
    // assertion changed.
    openCodeSettings: { ...DEFAULT_OPENCODE_SETTINGS },
    openCodeApplying: false
  }
}

function render(props: Record<string, unknown> = {}) {
  return mount(SettingsPanel, { props: { ...baseProps(), ...props } as never })
}

/*
 * AMENDED for the redesigned Settings page (#635, screens/settings.md W6): the one long column of
 * eight sections ruled into groups became seven sections behind a vertical tablist — General
 * (Position, Panel shortcut, Always on top), Appearance, Sound, Notifications, Integrations (Jev,
 * then OpenCode), Data, About — under the page header. `render({ section })` opens a section as
 * the tabs would. Every test below keeps its guarantee in the new shape and says what it was; the
 * order tests pin the tab order, which is where each section's place now lives, and the reset
 * dialog carries every guarantee ResetMetricsModal.test.ts held (that file went with the modal).
 */
const tabs = (wrapper: ReturnType<typeof render>) =>
  wrapper.findAll('[role="tab"]').map((tab) => tab.attributes('data-s'))

describe('SettingsPanel — frame', () => {
  // AMENDED (#635): was the panel's own title and 2px divider; the page header plate is the
  // design's title for every page now, and it draws no divider under itself.
  it('draws the design’s own title and divider', () => {
    const wrapper = render()
    expect(wrapper.get('.dm-phead__title').text()).toBe('Settings')
    expect(wrapper.find('.settings-divider').exists()).toBe(false)
    expect(wrapper.attributes('aria-label')).toBe('Settings')
  })
})

describe('SettingsPanel — sections in the design’s order', () => {
  it('mounts the Panel shortcut section with the state it was given', () => {
    const wrapper = render({
      shortcutState: shortcutState({ accelerator: 'Control+Alt+M' })
    })
    expect(wrapper.find('.recorder').text()).toBe('Ctrl + Alt + M')
  })

  // AMENDED (#635): aria-checked on the radio chip, where it was aria-pressed.
  it('mounts the Position section on the given edge', () => {
    const wrapper = render({ edge: 'left' })
    expect(wrapper.find('.position-left').attributes('aria-checked')).toBe('true')
  })

  // AMENDED (#635): on the Data tab, and the action reads "Reset metrics…".
  it('mounts the Data Base section', () => {
    expect(render({ section: 'Data' }).find('.reset-metrics').text()).toBe('Reset metrics…')
  })

  // AMENDED (#635): on the Sound tab; the slider speaks whole percentages.
  it('mounts the Audio section with the settings it was given', () => {
    const wrapper = render({
      section: 'Sound',
      audioSettings: { ...DEFAULT_AUDIO_PREFERENCES, musicVolume: 0.4 }
    })
    expect((wrapper.find('.music-volume input').element as HTMLInputElement).value).toBe('40')
  })

  // AMENDED (#635): was "draws Audio after Position and before Data Base" in the one column; the
  // same order is the tab order now (Sound after General, before Data).
  it('draws Audio after Position and before Data Base', () => {
    const order = tabs(render())
    expect(order.indexOf('Sound')).toBeGreaterThan(order.indexOf('General'))
    expect(order.indexOf('Sound')).toBeLessThan(order.indexOf('Data'))
  })

  // AMENDED (#635): on the Notifications tab, and a switch (aria-checked).
  it('mounts the Notifications section in the state it was given', () => {
    expect(
      render({ section: 'Notifications', notificationsEnabled: false })
        .find('.notifications-enabled')
        .attributes('aria-checked')
    ).toBe('false')
  })

  // AMENDED (#635): the tab order, as above.
  it('draws Notifications after Audio and before Data Base', () => {
    const order = tabs(render())
    expect(order.indexOf('Notifications')).toBeGreaterThan(order.indexOf('Sound'))
    expect(order.indexOf('Notifications')).toBeLessThan(order.indexOf('Data'))
  })

  // AMENDED (#635): on the Appearance tab, the stored font style checked.
  it('mounts the Typography section with the faces it was given', () => {
    const wrapper = render({
      section: 'Appearance',
      typography: {
        style: 'readable',
        faces: { display: 'roboto', label: 'roboto', meta: 'roboto', talk: 'roboto' }
      }
    })
    expect(wrapper.get('.dm-fontstyle__opt[data-id="readable"]').attributes('aria-checked')).toBe(
      'true'
    )
  })

  // AMENDED (#635): the tab order: Appearance after General, before Sound.
  it('draws Typography after Position and before Audio', () => {
    const order = tabs(render())
    expect(order.indexOf('Appearance')).toBeGreaterThan(order.indexOf('General'))
    expect(order.indexOf('Appearance')).toBeLessThan(order.indexOf('Sound'))
  })

  // AMENDED (#635): the Font style rows, on the Appearance tab.
  it('locks the Typography segments while a change is in flight', () => {
    const wrapper = render({ section: 'Appearance', typographyApplying: true })
    expect(
      wrapper.get('.dm-fontstyle__opt[data-id="readable"]').attributes('disabled')
    ).toBeDefined()
  })

  // AMENDED (#635): on the Integrations tab.
  it('mounts the Jev section with the settings it was given', () => {
    const wrapper = render({ section: 'Integrations', jevSettings: { configured: true } })
    expect(wrapper.find('.jev-configured').exists()).toBe(true)
  })

  // AMENDED (#635): the tab order: Integrations after Notifications, before Data.
  it('draws Jev after Notifications and before Data Base', () => {
    const order = tabs(render())
    expect(order.indexOf('Integrations')).toBeGreaterThan(order.indexOf('Notifications'))
    expect(order.indexOf('Integrations')).toBeLessThan(order.indexOf('Data'))
  })

  // AMENDED (#635): on the Integrations tab, by the name people know the tool by.
  it('passes the launchable providers through to the default-launch picker', () => {
    const wrapper = render({
      section: 'Integrations',
      jevSettings: { configured: true, preferences: DEFAULT_JEV_PREFERENCES },
      jevProviders: [{ provider: 'claude', installed: true, launchable: true }]
    })
    const options = wrapper
      .find('[aria-label="Default provider"]')
      .findAll('option')
      .map((node) => node.text())
    expect(options).toEqual(['None', 'Claude'])
  })

  it('lists the seven sections, General first and open, as a vertical tablist', () => {
    const wrapper = render()
    const list = wrapper.get('[role="tablist"]')
    expect(list.attributes('aria-orientation')).toBe('vertical')
    expect(list.attributes('aria-label')).toBe('Settings sections')
    expect(tabs(wrapper)).toEqual([
      'General',
      'Appearance',
      'Sound',
      'Notifications',
      'Integrations',
      'Data',
      'About'
    ])
    expect(wrapper.get('[aria-selected="true"]').text()).toBe('General')
    expect(wrapper.get('.dm-settings__h').text()).toBe('General')
  })

  it('draws General as Position, the Panel shortcut and Always on top, in that order', () => {
    const labels = render()
      .findAll('.dm-srow__label')
      .map((label) => label.text())
    expect(labels).toEqual(['Position', 'Panel shortcut', 'Always on top'])
  })

  it('opens a section from its tab, showing its name as the heading', async () => {
    const wrapper = render()
    await wrapper.get('[data-s="Sound"]').trigger('click')
    expect(wrapper.get('[data-s="Sound"]').attributes('aria-selected')).toBe('true')
    expect(wrapper.get('[data-s="Sound"]').attributes('tabindex')).toBe('0')
    expect(wrapper.get('[data-s="General"]').attributes('tabindex')).toBe('-1')
    expect(wrapper.get('.dm-settings__h').text()).toBe('Sound')
    expect(wrapper.find('.music-at-startup').exists()).toBe(true)
    expect(wrapper.find('.recorder').exists()).toBe(false)
  })

  it('moves through the sections with the up and down arrows, wrapping, the focus on the tab', async () => {
    const wrapper = mount(SettingsPanel, { props: baseProps() as never, attachTo: document.body })
    await wrapper.get('[role="tablist"]').trigger('keydown', { key: 'ArrowUp' })
    await flushPromises()
    expect(wrapper.get('.dm-settings__h').text()).toBe('About')
    expect(document.activeElement).toBe(wrapper.get('[data-s="About"]').element)
    await wrapper.get('[role="tablist"]').trigger('keydown', { key: 'ArrowDown' })
    await flushPromises()
    expect(wrapper.get('.dm-settings__h').text()).toBe('General')
    // Walking back to General through the tabs leaves the focus on the tab, not the recorder.
    expect(document.activeElement).toBe(wrapper.get('[data-s="General"]').element)
    wrapper.unmount()
  })

  it('ties the section panel to the tab that shows it', () => {
    const wrapper = render({ section: 'Data' })
    const panel = wrapper.get('[role="tabpanel"]')
    const tab = wrapper.get('[data-s="Data"]')
    expect(panel.attributes('aria-labelledby')).toBe(tab.attributes('id'))
    expect(tab.attributes('aria-controls')).toBe(panel.attributes('id'))
  })

  it('draws Integrations as the Jev rows, then OpenCode, then the privacy notice', () => {
    const wrapper = render({
      section: 'Integrations',
      jevSettings: { configured: false, unavailableReason: 'encryption-unavailable' }
    })
    const panel = wrapper.get('[role="tabpanel"]').element
    const order = [...panel.querySelectorAll('.jev-settings, .opencode-settings, .privacy-notice')]
    expect(order.map((element) => element.classList[element.classList.length - 1])).toEqual([
      'jev-settings',
      'opencode-settings',
      'privacy-notice'
    ])
    // The notice stands whatever the Jev rows show, storage unavailable included.
    expect(wrapper.get('.privacy-notice').text()).toContain('api.typesafe.ai')
  })
})

describe('SettingsPanel — a shortcut that did not register', () => {
  it('puts a warning dot on the General tab and opens General with the banner', () => {
    const wrapper = render({ shortcutState: shortcutState({ registered: false }) })
    expect(wrapper.get('[data-s="General"] .dm-warn-dot').attributes('aria-label')).toBe('warning')
    expect(wrapper.get('.dm-banner').attributes('role')).toBe('alert')
    expect(wrapper.get('.dm-banner').text()).toBe(
      'Ctrl + Alt + Shift + P is already in use by another application.'
    )
  })

  it('draws neither while the shortcut works, nor while it is still being read', () => {
    for (const state of [shortcutState(), null]) {
      const wrapper = render({ shortcutState: state })
      expect(wrapper.find('.dm-warn-dot').exists()).toBe(false)
      expect(wrapper.find('.dm-banner').exists()).toBe(false)
    }
  })
})

describe('SettingsPanel — forwarding intents up (App owns the IPC)', () => {
  it('forwards the shortcut recorder’s events untouched', async () => {
    const wrapper = render()
    await wrapper.find('.recorder').trigger('click')
    expect(wrapper.emitted('start-recording')).toHaveLength(1)
  })

  it('forwards a position choice as select-edge', async () => {
    const wrapper = render({ edge: 'right' })
    await wrapper.find('.position-left').trigger('click')
    expect(wrapper.emitted('select-edge')).toEqual([['left']])
  })

  it('forwards the pin toggle', async () => {
    const wrapper = render()
    await wrapper.find('.pin').trigger('click')
    expect(wrapper.emitted('toggle-pin')).toHaveLength(1)
  })

  // AMENDED (#635): from the About tab.
  it('forwards hide panel', async () => {
    const wrapper = render({ section: 'About' })
    await wrapper.find('.hide-panel').trigger('click')
    expect(wrapper.emitted('hide-panel')).toHaveLength(1)
  })

  // AMENDED (#635): from the Sound tab.
  it('forwards an Audio change as audio-change, carrying only the field that moved', async () => {
    const wrapper = render({ section: 'Sound' })
    await wrapper.find('.music-at-startup').trigger('click')
    expect(wrapper.emitted('audio-change')).toEqual([[{ musicAtStartup: false }]])
  })

  // APPENDED for #316. AMENDED (#635): from the Notifications tab.
  it('forwards the notifications switch as notifications-change', async () => {
    const wrapper = render({ section: 'Notifications', notificationsEnabled: true })
    await wrapper.find('.notifications-enabled').trigger('click')
    expect(wrapper.emitted('notifications-change')).toEqual([[false]])
  })

  // APPENDED for #370. AMENDED (#635): was "…carrying only the role that moved"; a press asks
  // for the whole choice now, which is the font style it picks with that style's faces.
  it('forwards a Typography choice as typography-change, carrying only the role that moved', async () => {
    const wrapper = render({ section: 'Appearance' })
    await wrapper.get('.dm-fontstyle__opt[data-id="readable"]').trigger('click')
    expect(wrapper.emitted('typography-change')).toEqual([
      [
        {
          style: 'readable',
          faces: { display: 'roboto', label: 'roboto', meta: 'roboto', talk: 'roboto' }
        }
      ]
    ])
  })

  // APPENDED for #509. AMENDED (#635): from the Integrations tab, the design's input.
  it('forwards a Jev save as jev-save, carrying the typed key', async () => {
    const wrapper = render({ section: 'Integrations' })
    const input = wrapper.find('.jev-key-input input')
    ;(input.element as HTMLInputElement).value = 'sk-typesafe-abc123'
    await input.trigger('input')
    await wrapper.find('.jev-save').trigger('click')
    expect(wrapper.emitted('jev-save')).toEqual([['sk-typesafe-abc123']])
  })

  it('forwards a Jev clear as jev-clear', async () => {
    const wrapper = render({ section: 'Integrations', jevSettings: { configured: true } })
    await wrapper.find('.jev-clear').trigger('click')
    expect(wrapper.emitted('jev-clear')).toHaveLength(1)
  })

  // APPENDED for the #509 follow-up.
  it('forwards a routing profile choice as jev-preferences-change, carrying the whole document', async () => {
    const wrapper = render({
      section: 'Integrations',
      jevSettings: { configured: true, preferences: DEFAULT_JEV_PREFERENCES }
    })
    const options = wrapper.findAll('.profile-option')
    await options[2]?.trigger('click')
    expect(wrapper.emitted('jev-preferences-change')).toEqual([
      [{ profile: 'premium', default: {}, delegation: false }]
    ])
  })
})

// AMENDED (#635): the Application section's three controls found homes in the design — Always on
// top in General, the version and Hide panel in About.
describe('SettingsPanel — the Application section (#142 relocations, #138 restyled)', () => {
  it('draws the pin, hide panel and version controls', () => {
    expect(render().find('.pin').exists()).toBe(true)
    const about = render({ section: 'About' })
    expect(about.find('.hide-panel').exists()).toBe(true)
    expect(about.find('.version').text()).toBe('DwarfAI-Miners · version 1.2.3')
    expect(about.find('.version').attributes('title')).toBe('Packaged build')
  })

  it('renders no version element when none was given, rather than a placeholder', () => {
    const wrapper = render({ section: 'About', versionText: null })
    expect(wrapper.find('.version').exists()).toBe(false)
  })
})

/*
 * The reset-metrics confirmation. AMENDED (#635): the modal is the design's dialog now
 * (molecules/dialog, over its scrim in <body>), opened from Data: titled "Reset metrics", its body
 * today's sentence, Cancel then the danger action, which stays disabled until "yes" is typed.
 * ResetMetricsModal.test.ts went with ResetMetricsModal.vue; each of its guarantees is below,
 * marked with the test it was, and lib/settings/resetConfirmation's cases with it.
 */
describe('SettingsPanel — the reset-metrics modal', () => {
  const mounted: { unmount: () => void }[] = []
  afterEach(() => {
    for (const wrapper of mounted.splice(0)) wrapper.unmount()
    document.body.innerHTML = ''
  })

  async function opened(props: Record<string, unknown> = {}) {
    const wrapper = mount(SettingsPanel, {
      props: { ...baseProps(), section: 'Data', ...props } as never,
      attachTo: document.body
    })
    mounted.push(wrapper)
    await wrapper.get('.reset-metrics').trigger('click')
    await flushPromises()
    return wrapper
  }
  const dialog = () => document.body.querySelector<HTMLElement>('.dm-scrim [role="dialog"]')
  const field = () => dialog()!.querySelector<HTMLInputElement>('input')!
  const actions = () => [
    ...dialog()!.querySelectorAll<HTMLButtonElement>('.dm-dialog__actions button')
  ]
  async function type(value: string): Promise<void> {
    field().value = value
    field().dispatchEvent(new Event('input'))
    await flushPromises()
  }

  // AMENDED (#635): was "mounts the reset modal through the shared vertical panel transition";
  // the dialog brings its own entrance (motion.md, Overlays: the scrim fades, the card rises).
  it('mounts the reset modal through the shared vertical panel transition', async () => {
    await opened()
    expect(document.body.querySelector('.dm-scrim')).not.toBeNull()
    expect(dialog()!.getAttribute('aria-modal')).toBe('true')
  })

  it('starts closed', () => {
    expect(render({ section: 'Data' }).find('.reset-modal').exists()).toBe(false)
    expect(document.body.querySelector('.dm-scrim')).toBeNull()
  })

  // AMENDED (#635): the dialog's title; ResetMetricsModal.test's "gives the title and message
  // exactly as the design states them" with it.
  it('opens from the Data Base section', async () => {
    await opened()
    expect(dialog()!.querySelector('.dm-dialog__title')!.textContent).toBe('Reset metrics')
    expect(dialog()!.textContent).toContain(
      'Are you sure you want to delete your data? Type "yes" to confirm.'
    )
    expect(dialog()!.classList).toContain('dm-dialog--danger')
  })

  // AMENDED (#635): was the modal's x; the dialog's Cancel, first of its actions (and
  // ResetMetricsModal.test's "has a close (x) control" and "emits close from the x control").
  it('closes from its own close control', async () => {
    await opened()
    const [cancel] = actions()
    expect(cancel!.textContent).toBe('Cancel')
    cancel!.click()
    await flushPromises()
    expect(document.body.querySelector('.dm-scrim')).toBeNull()
  })

  it('forwards a confirmed reset as reset-confirm', async () => {
    const wrapper = await opened()
    await type('yes')
    actions()[1]!.click()
    expect(wrapper.emitted('reset-confirm')).toHaveLength(1)
  })

  // AMENDED (#635): the confirm action locks while a reset is in flight (the field is the
  // dialog's own and stays editable), and the reason shows as an alert.
  it('passes resetting and resetError through to the modal', async () => {
    await opened({ resetting: true, resetError: 'Nothing was deleted.' })
    await type('yes')
    expect(actions()[1]!.disabled).toBe(true)
    expect(dialog()!.querySelector('[role="alert"]')!.textContent).toBe('Nothing was deleted.')
  })

  // From ResetMetricsModal.test: "uses real buttons, so every control is keyboard operable".
  it('uses real buttons, so every control is keyboard operable', async () => {
    await opened()
    for (const button of actions()) expect(button.type).toBe('button')
  })

  // From ResetMetricsModal.test: "starts disabled with nothing typed".
  it('starts the confirm action disabled with nothing typed', async () => {
    await opened()
    expect(actions()[1]!.disabled).toBe(true)
  })

  // From ResetMetricsModal.test: "stays disabled for %s", with resetConfirmation's rejections.
  it.each(['n', 'ye', 'no', 'yes please', 'yess', 'y', '', '   '])(
    'stays disabled for %j',
    async (value) => {
      await opened()
      await type(value)
      expect(actions()[1]!.disabled).toBe(true)
    }
  )

  // From ResetMetricsModal.test: "enables once %s is typed", with resetConfirmation's cases.
  it.each(['yes', 'Yes', 'YES', 'yEs', ' yes ', '  Yes  '])(
    'enables once %j is typed',
    async (value) => {
      await opened()
      await type(value)
      expect(actions()[1]!.disabled).toBe(false)
    }
  )

  // From ResetMetricsModal.test: "emits confirm only when the gate is open".
  it('emits confirm only when the gate is open', async () => {
    const wrapper = await opened()
    await type('no')
    actions()[1]!.click()
    expect(wrapper.emitted('reset-confirm')).toBeUndefined()
    await type('yes')
    actions()[1]!.click()
    expect(wrapper.emitted('reset-confirm')).toHaveLength(1)
  })

  // From ResetMetricsModal.test: "has no alert when nothing went wrong".
  it('has no alert when nothing went wrong', async () => {
    await opened()
    expect(dialog()!.querySelector('[role="alert"]')).toBeNull()
  })

  // From ResetMetricsModal.test: "emits close on Escape".
  it('closes on Escape', async () => {
    await opened()
    dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(document.body.querySelector('.dm-scrim')).toBeNull()
  })

  it('closes once a reset went through, and stays open with the reason when it did not', async () => {
    const wrapper = await opened()
    await wrapper.setProps({ resetting: true })
    await wrapper.setProps({ resetting: false, resetError: 'Nothing was deleted.' })
    await flushPromises()
    expect(document.body.querySelector('.dm-scrim')).not.toBeNull()
    await wrapper.setProps({ resetting: true, resetError: null })
    await wrapper.setProps({ resetting: false })
    await flushPromises()
    expect(document.body.querySelector('.dm-scrim')).toBeNull()
  })
})

/*
 * AMENDED (#635): was "SettingsPanel section grouping" — rules between groups of sections in the
 * one column (maintainer request, 2026-09-21). The sections are tabs now (screens/settings.md W6:
 * "Sections in place of one long scroll"), which is the grouping, and the rules went with the
 * column. Each test keeps its intent against the tabs.
 */
describe('SettingsPanel section grouping', () => {
  // AMENDED (#635): was the sequence of headings and rules; now the sections are the tabs, with
  // the two Panel rows (shortcut, position) together in General.
  it('rules between groups, leaving the two Panel sections together', () => {
    const wrapper = render()
    expect(tabs(wrapper)).toHaveLength(7)
    const general = wrapper.findAll('.dm-srow__label').map((label) => label.text())
    expect(general.slice(0, 2)).toEqual(['Position', 'Panel shortcut'])
  })

  // AMENDED (#635): no rule anywhere, under the title least of all.
  it('draws no rule directly under the title, which has its own', () => {
    expect(render().find('.group-divider').exists()).toBe(false)
  })

  // AMENDED (#635): the panel's last row draws no rule under itself (the row's :last-child rule).
  it('never ends on a rule, which would underline the panel', () => {
    const rows = render().findAll('[role="tabpanel"] .dm-srow')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.at(-1)!.element.nextElementSibling).toBeNull()
  })

  // AMENDED (#635): nothing presentational stands between sections now; the warning dot, the one
  // mark a tab carries, names itself.
  it('marks every group rule presentational, since it names nothing', () => {
    const wrapper = render({ shortcutState: shortcutState({ registered: false }) })
    expect(wrapper.findAll('[role="presentation"]')).toHaveLength(0)
    expect(wrapper.get('.dm-warn-dot').attributes('aria-label')).toBe('warning')
  })
})

/*
 * AMENDED (#635): was "SettingsPanel press and hover feedback" — the pin and Hide panel as
 * motion.buttons carrying the shared variants (#566 T4). They are the design's atoms now: Always
 * on top a switch (atoms/toggle), Hide panel a button (atoms/button), whose press and hover are
 * their own stylesheets'.
 */
describe('SettingsPanel press and hover feedback', () => {
  it('routes both application controls through motion.button carrying the shared variants', () => {
    expect(render().get('.pin').classes()).toContain('dm-toggle')
    expect(render({ section: 'About' }).get('.hide-panel').classes()).toContain('dm-btn')
  })

  // AMENDED (#635): the pin's name is its row's, "Always on top" (was "Keep panel on top"), and
  // its state is aria-checked on the switch (was aria-pressed); the hint and the press are kept.
  it('leaves both buttons with the name, pressed state, hint and press they had', async () => {
    const wrapper = render({
      pinned: true,
      pinTooltip: 'Pinned: the panel stays above other windows'
    })

    const pin = wrapper.get('.pin')
    expect(pin.element.tagName).toBe('BUTTON')
    expect(pin.attributes('type')).toBe('button')
    expect(pin.attributes('aria-label')).toBe('Always on top')
    expect(pin.attributes('aria-checked')).toBe('true')
    expect(pin.attributes('title')).toBe('Pinned: the panel stays above other windows')
    await pin.trigger('click')
    expect(wrapper.emitted('toggle-pin')).toHaveLength(1)
    // Held: the switch shows the pin main reports, not the press.
    expect(pin.attributes('aria-checked')).toBe('true')

    const about = render({ section: 'About' })
    const hide = about.get('.hide-panel')
    expect(hide.element.tagName).toBe('BUTTON')
    expect(hide.attributes('title')).toBe('Hide the panel; the shortcut or the tray brings it back')
    await hide.trigger('click')
    expect(about.emitted('hide-panel')).toHaveLength(1)
  })
})

/* --- OpenCode permission relay (#588 T6) — one block, appended ------------ */
describe('SettingsPanel — the OpenCode section (#588 T6)', () => {
  // AMENDED (#635): in Integrations, after the Jev rows (Data is its own tab after it).
  it('draws OpenCode after Jev and before Data Base', () => {
    const wrapper = render({ section: 'Integrations' })
    const panel = wrapper.get('[role="tabpanel"]').element
    const jev = panel.querySelector('.jev-settings')!
    const openCode = panel.querySelector('.opencode-settings')!
    expect(jev.compareDocumentPosition(openCode) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const order = tabs(wrapper)
    expect(order.indexOf('Integrations')).toBeLessThan(order.indexOf('Data'))
  })

  // AMENDED (#635): a switch (aria-checked), on the Integrations tab.
  it('mounts the section with the settings it was given', () => {
    const wrapper = render({
      section: 'Integrations',
      openCodeSettings: { ...DEFAULT_OPENCODE_SETTINGS, pluginEnabled: true }
    })
    expect(wrapper.find('.opencode-plugin-enabled').attributes('aria-checked')).toBe('true')
  })

  it('forwards the relay switch as opencode-plugin-change', async () => {
    const wrapper = render({ section: 'Integrations' })
    await wrapper.find('.opencode-plugin-enabled').trigger('click')
    expect(wrapper.emitted('opencode-plugin-change')).toEqual([[true]])
  })

  it('forwards a password save as opencode-password-save, and a clear as opencode-password-clear', async () => {
    const wrapper = render({ section: 'Integrations' })
    await wrapper.find('.opencode-password-input input').setValue('hunter2')
    await wrapper.find('.opencode-password-save').trigger('click')
    expect(wrapper.emitted('opencode-password-save')).toEqual([['hunter2']])

    const stored = render({
      section: 'Integrations',
      openCodeSettings: { ...DEFAULT_OPENCODE_SETTINGS, passwordConfigured: true }
    })
    await stored.find('.opencode-password-clear').trigger('click')
    expect(stored.emitted('opencode-password-clear')).toHaveLength(1)
  })
})
/* --- end of the #588 T6 block --------------------------------------------- */
