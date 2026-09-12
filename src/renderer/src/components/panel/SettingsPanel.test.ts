// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { DEFAULT_TOGGLE_ACCELERATOR } from '../../../../shared/accelerator'
import type { ShortcutState } from '../../types'
import { DEFAULT_AUDIO_PREFERENCES, DEFAULT_NOTIFICATIONS_ENABLED } from '../../types'
import PanelTransition from '../shell/PanelTransition.vue'
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

function render(props: Record<string, unknown> = {}) {
  return mount(SettingsPanel, {
    props: {
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
      ...props
    }
  })
}

describe('SettingsPanel — frame', () => {
  it('draws the design’s own title and divider', () => {
    const wrapper = render()
    expect(wrapper.find('.settings-title').text()).toBe('Settings')
    expect(wrapper.find('.settings-divider').exists()).toBe(true)
  })
})

describe('SettingsPanel — sections in the design’s order', () => {
  it('mounts the Panel shortcut section with the state it was given', () => {
    const wrapper = render({
      shortcutState: shortcutState({ accelerator: 'Control+Alt+M' })
    })
    expect(wrapper.find('.recorder').text()).toBe('Ctrl + Alt + M')
  })

  it('mounts the Position section on the given edge', () => {
    const wrapper = render({ edge: 'left' })
    expect(wrapper.find('.position-left').attributes('aria-pressed')).toBe('true')
  })

  it('mounts the Data Base section', () => {
    expect(render().find('.reset-metrics').text()).toBe('Reset metrics')
  })

  /*
   * The Audio section (#174), a maintainer-specified extension of
   * `screens/settings.md`. It sits between Position and Data Base — after the
   * two sections the design draws, before the destructive one that #138's own
   * comment already carries to the bottom of the panel. #316 adds a
   * notifications switch beside it, and the same gap is where that lands.
   */
  it('mounts the Audio section with the settings it was given', () => {
    const wrapper = render({
      audioSettings: { ...DEFAULT_AUDIO_PREFERENCES, musicVolume: 0.4 }
    })
    expect((wrapper.find('.music-volume').element as HTMLInputElement).value).toBe('0.4')
  })

  it('draws Audio after Position and before Data Base', () => {
    const sections = render()
      .findAll('section')
      .map((section) => section.classes()[0])
    expect(sections.indexOf('audio-settings')).toBeGreaterThan(
      sections.indexOf('position-settings')
    )
    expect(sections.indexOf('audio-settings')).toBeLessThan(sections.indexOf('data-base-settings'))
  })

  /*
   * APPENDED for #316. The Notifications section is the second extension of
   * `screens/settings.md` and lands in the same gap Audio opened — the source
   * file itself already names it as joining that gap.
   */
  it('mounts the Notifications section in the state it was given', () => {
    expect(
      render({ notificationsEnabled: false })
        .find('.notifications-enabled')
        .attributes('aria-pressed')
    ).toBe('false')
  })

  it('draws Notifications after Audio and before Data Base', () => {
    const sections = render()
      .findAll('section')
      .map((section) => section.classes()[0])
    expect(sections.indexOf('notification-settings')).toBeGreaterThan(
      sections.indexOf('audio-settings')
    )
    expect(sections.indexOf('notification-settings')).toBeLessThan(
      sections.indexOf('data-base-settings')
    )
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

  it('forwards hide panel', async () => {
    const wrapper = render()
    await wrapper.find('.hide-panel').trigger('click')
    expect(wrapper.emitted('hide-panel')).toHaveLength(1)
  })

  it('forwards an Audio change as audio-change, carrying only the field that moved', async () => {
    const wrapper = render()
    await wrapper.find('.music-at-startup').trigger('click')
    expect(wrapper.emitted('audio-change')).toEqual([[{ musicAtStartup: false }]])
  })

  // APPENDED for #316.
  it('forwards the notifications switch as notifications-change', async () => {
    const wrapper = render({ notificationsEnabled: true })
    await wrapper.find('.notifications-enabled').trigger('click')
    expect(wrapper.emitted('notifications-change')).toEqual([[false]])
  })
})

describe('SettingsPanel — the Application section (#142 relocations, #138 restyled)', () => {
  it('draws the pin, hide panel and version controls', () => {
    const wrapper = render()
    expect(wrapper.find('.pin').exists()).toBe(true)
    expect(wrapper.find('.hide-panel').exists()).toBe(true)
    expect(wrapper.find('.version').text()).toBe('1.2.3')
  })

  it('renders no version element when none was given, rather than a placeholder', () => {
    const wrapper = render({ versionText: null })
    expect(wrapper.find('.version').exists()).toBe(false)
  })
})

describe('SettingsPanel — the reset-metrics modal', () => {
  it('mounts the reset modal through the shared vertical panel transition', async () => {
    const wrapper = render()
    await wrapper.find('.reset-metrics').trigger('click')

    const transition = wrapper.findComponent(PanelTransition)
    expect(transition.exists()).toBe(true)
    expect(transition.props('axis')).toBe('vertical')
  })

  it('starts closed', () => {
    expect(render().find('.reset-modal').exists()).toBe(false)
  })

  it('opens from the Data Base section', async () => {
    const wrapper = render()
    await wrapper.find('.reset-metrics').trigger('click')
    expect(wrapper.find('.modal-title').text()).toBe('Reset metrics')
  })

  it('closes from its own close control', async () => {
    const wrapper = render()
    await wrapper.find('.reset-metrics').trigger('click')
    await wrapper.find('.modal-close').trigger('click')
    expect(wrapper.find('.reset-modal').exists()).toBe(false)
  })

  it('forwards a confirmed reset as reset-confirm', async () => {
    const wrapper = render()
    await wrapper.find('.reset-metrics').trigger('click')
    await wrapper.find('.modal-input').setValue('yes')
    await wrapper.find('.modal-confirm').trigger('click')
    expect(wrapper.emitted('reset-confirm')).toHaveLength(1)
  })

  it('passes resetting and resetError through to the modal', async () => {
    const wrapper = render({ resetting: true, resetError: 'Nothing was deleted.' })
    await wrapper.find('.reset-metrics').trigger('click')
    expect(wrapper.find('.modal-input').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[role="alert"]').text()).toBe('Nothing was deleted.')
  })
})
