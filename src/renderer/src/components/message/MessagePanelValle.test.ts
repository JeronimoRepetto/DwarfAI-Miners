// @vitest-environment jsdom
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeWindowApi } from '../../../../contracts/ipc/testing/fakeWindowApi'
import { modeTransitionPart } from '../../composables/useModeTransition'
import { defaultDwarf } from '../../testing/factories'
import MenuButton from '../overlay/MenuButton.vue'
import DwarfMessagePanel from './DwarfMessagePanel.vue'

/*
 * The MessagePanel hosted in Valle's pins and panes (a Valle package gap resolved in development, EPIC-20 task TVC;
 * BR-21: one component in every mode). Valle's mine history drawer is ISSUE-308's and Valle's part in a mode transition
 * run ISSUE-311's, so a chat hosted in Valle offers no Mine history (hidden until built, BR-19; 21 §1 item 8), no
 * "▢ Open in the Panel" (only a chat risen from Veta offers it, US-MSG-010) and starts no mode-transition part in the
 * Valle window. Mounted against the generated fake `window.api` (ADR-033 item 7).
 */

enableAutoUnmount(afterEach)

const onModeTransition = vi.fn(() => () => undefined)

beforeEach(() => {
  onModeTransition.mockClear()
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: createFakeWindowApi({ onModeTransition })
  })
})

afterEach(() => {
  modeTransitionPart().dispose()
  Reflect.deleteProperty(window, 'api')
})

describe('the MessagePanel hosted in Valle (TVC)', () => {
  it('[BR-19, US-MSG-010.AC02] hosted in Valle the header offers neither Mine history nor Open in the Panel, and the ⋯ menu no Mine history', () => {
    const wrapper = mount(DwarfMessagePanel, {
      props: { dwarf: defaultDwarf(), hostedIn: 'valle' }
    })
    expect(wrapper.find('[data-open-in-panel]').exists()).toBe(false)
    expect(wrapper.find('.dm-msg__tools [title="Mine history"]').exists()).toBe(false)
    expect(wrapper.find('.dm-msg__console').exists()).toBe(true)
    const items = wrapper.findComponent(MenuButton).props('items') as readonly { label: string }[]
    expect(items.map((item) => item.label)).not.toContain('Mine history')
    expect(items.map((item) => item.label)).toContain('Open console')
  })

  it('[ADR-025, BR-19] hosted in Valle the MessagePanel starts no mode-transition part in the window (ISSUE-311 adds it)', () => {
    mount(DwarfMessagePanel, { props: { dwarf: defaultDwarf(), hostedIn: 'valle' } })
    expect(onModeTransition).not.toHaveBeenCalled()
    // The Panel's own chat does start the window's part, as ISSUE-284 built it.
    mount(DwarfMessagePanel, { props: { dwarf: defaultDwarf() } })
    expect(onModeTransition).toHaveBeenCalledTimes(1)
  })
})
