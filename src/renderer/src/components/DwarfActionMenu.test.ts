// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { MAX_DWARF_TEXT_CHARS } from '../../../shared/contracts'
import { defaultDwarf } from '../testing/factories'
import DwarfActionMenu from './DwarfActionMenu.vue'

function menu(props: Record<string, unknown> = {}) {
  return mount(DwarfActionMenu, {
    props: { dwarf: defaultDwarf({ textDelivery: 'terminal' }), ...props }
  })
}

describe('DwarfActionMenu', () => {
  it('offers the console and the message actions', () => {
    const wrapper = menu()
    expect(wrapper.find('.action-open').text()).toContain('Open console')
    expect(wrapper.find('.action-send').text()).toContain('Send message')
  })

  it('keeps the old click-to-focus behaviour one click away', async () => {
    const wrapper = menu()
    await wrapper.find('.action-open').trigger('click')
    expect(wrapper.emitted('open-console')).toHaveLength(1)
  })

  it('hides the composer until the message action is chosen', async () => {
    const wrapper = menu()
    expect(wrapper.find('.message-input').exists()).toBe(false)
    await wrapper.find('.action-send').trigger('click')
    expect(wrapper.find('.message-input').exists()).toBe(true)
  })

  it('sends the typed text with the Enter preference', async () => {
    const wrapper = menu()
    await wrapper.find('.action-send').trigger('click')
    await wrapper.find('.message-input').setValue('run the tests')
    await wrapper.find('.send-button').trigger('click')

    expect(wrapper.emitted('send')).toEqual([[{ text: 'run the tests', pressEnter: true }]])
  })

  it('lets the sender decide whether the session should submit the line', async () => {
    const wrapper = menu()
    await wrapper.find('.action-send').trigger('click')
    await wrapper.find('.message-input').setValue('run the tests')
    await wrapper.find('.press-enter').setValue(false)
    await wrapper.find('.send-button').trigger('click')

    expect(wrapper.emitted('send')).toEqual([[{ text: 'run the tests', pressEnter: false }]])
  })

  it('sends on Enter and adds a newline on Shift+Enter', async () => {
    const wrapper = menu()
    await wrapper.find('.action-send').trigger('click')
    await wrapper.find('.message-input').setValue('run the tests')

    await wrapper.find('.message-input').trigger('keydown', { key: 'Enter', shiftKey: true })
    expect(wrapper.emitted('send')).toBeUndefined()

    await wrapper.find('.message-input').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toHaveLength(1)
  })

  it('refuses to send an empty or blank message', async () => {
    const wrapper = menu()
    await wrapper.find('.action-send').trigger('click')
    await wrapper.find('.message-input').setValue('   ')
    await wrapper.find('.send-button').trigger('click')

    expect(wrapper.emitted('send')).toBeUndefined()
    expect(wrapper.find('.send-button').attributes('disabled')).toBeDefined()
  })

  it('caps the message at the shared delivery limit', async () => {
    const wrapper = menu()
    await wrapper.find('.action-send').trigger('click')
    expect(wrapper.find('.message-input').attributes('maxlength')).toBe(
      String(MAX_DWARF_TEXT_CHARS)
    )
  })

  it('disables the message action, with a reason, when the session cannot receive text', () => {
    const wrapper = menu({ dwarf: defaultDwarf({ textDelivery: undefined }) })
    const action = wrapper.find('.action-send')
    expect(action.attributes('disabled')).toBeDefined()
    expect(action.attributes('title')).toBe("This session type can't receive messages yet.")
  })

  it('names the channel the message will travel through', async () => {
    const wrapper = menu({ dwarf: defaultDwarf({ textDelivery: 'foreman-relay', name: 'Digger' }) })
    await wrapper.find('.action-send').trigger('click')
    expect(wrapper.find('.channel-hint').text()).toContain('foreman')
  })

  it('locks the composer while a send is in flight', async () => {
    const wrapper = menu({ sendState: { phase: 'sending' } })
    await wrapper.find('.action-send').trigger('click')
    await wrapper.find('.message-input').setValue('hi')
    expect(wrapper.find('.send-button').attributes('disabled')).toBeDefined()
  })

  it('closes on Escape', async () => {
    const wrapper = menu()
    await wrapper.find('.action-menu').trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})
