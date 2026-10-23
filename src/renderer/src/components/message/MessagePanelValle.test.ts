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
 * BR-21: one component in every mode). Valle's part in a mode transition run is ISSUE-311's, so a chat hosted in Valle
 * offers no "▢ Open in the Panel" (only a chat risen from Veta offers it, US-MSG-010) and starts no mode-transition part
 * in the Valle window. AMENDED for ISSUE-308 (was: no Mine history either, hidden until built, BR-19): its Mine history
 * shows, in the header and the ⋯ menu, and asks the host, which shows the mine's history in its zone or the drawer
 * under the chats (07 S31.11, S36.01; US-VALLE-011.AC01). Mounted against the generated fake `window.api` (ADR-033 item 7).
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
  // AMENDED for ISSUE-308 (was: neither Mine history nor Open in the Panel, the ⋯ menu no Mine history): in Valle the
  // Mine history request opens the drawer under the chats or shows the mine's zone (07 S31.11, S36.01).
  it('[BR-19, US-MSG-010.AC02, US-VALLE-011.AC01] hosted in Valle the header offers Mine history but not Open in the Panel, and the ⋯ menu its Mine history', async () => {
    const wrapper = mount(DwarfMessagePanel, {
      props: { dwarf: defaultDwarf(), hostedIn: 'valle' }
    })
    expect(wrapper.find('[data-open-in-panel]').exists()).toBe(false)
    expect(wrapper.find('.dm-msg__tools [title="Mine history"]').exists()).toBe(true)
    expect(wrapper.find('.dm-msg__console').exists()).toBe(true)
    const items = wrapper.findComponent(MenuButton).props('items') as readonly { label: string }[]
    expect(items.map((item) => item.label)).toContain('Mine history')
    expect(items.map((item) => item.label)).toContain('Open console')
    // Either one asks the host for the mine's history.
    await wrapper.get('.dm-msg__tools [title="Mine history"]').trigger('click')
    wrapper.findComponent(MenuButton).vm.$emit(
      'pick',
      items.findIndex((item) => item.label === 'Mine history')
    )
    expect(wrapper.emitted('history')).toHaveLength(2)
  })

  it('[ADR-025, BR-19] hosted in Valle the MessagePanel starts no mode-transition part in the window (ISSUE-311 adds it)', () => {
    mount(DwarfMessagePanel, { props: { dwarf: defaultDwarf(), hostedIn: 'valle' } })
    expect(onModeTransition).not.toHaveBeenCalled()
    // The Panel's own chat does start the window's part, as ISSUE-284 built it.
    mount(DwarfMessagePanel, { props: { dwarf: defaultDwarf() } })
    expect(onModeTransition).toHaveBeenCalledTimes(1)
  })
})
