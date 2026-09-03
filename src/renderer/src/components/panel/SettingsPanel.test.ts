// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { DEFAULT_TOGGLE_ACCELERATOR } from '../../../../shared/accelerator'
import type { ShortcutState } from '../../types'
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
  return { accelerator: DEFAULT_TOGGLE_ACCELERATOR, registered: true, platform: 'win32', ...overrides }
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
