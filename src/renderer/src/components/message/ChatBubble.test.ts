// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { sendMarker } from '../../lib/delivery/deliveryVerdict'
import { bubbleMark } from '../../lib/message/panelChrome'
import type { DwarfSendState } from '../../types'
import ChatBubble from './ChatBubble.vue'

/*
 * A failed message's way out (#635, decision log, Failed delivery; components.md, Chat bubble):
 * it keeps "✕ not delivered" and, where its host offers a retry, shows Retry and Copy under it,
 * in a group named "Not delivered", each titled with what it does. Nothing retries on its own:
 * the bubble only reports the press, and its host re-sends.
 */

function bubble(phase: DwarfSendState['phase'], offersRetry = true) {
  return mount(ChatBubble, {
    props: {
      from: 'user',
      text: 'Also check that the auto-invoke table still sorts.',
      time: '09:13',
      mark: bubbleMark(sendMarker({ phase })!),
      offersRetry
    }
  })
}

describe('ChatBubble, not delivered (#635)', () => {
  it('keeps the ✕ and offers Retry then Copy in a group named Not delivered', () => {
    const wrapper = bubble('failed')
    expect(wrapper.find('.dm-bubble__mark').text()).toBe('✕ not delivered')
    const group = wrapper.find('.dm-bubble__actions')
    expect(group.attributes('role')).toBe('group')
    expect(group.attributes('aria-label')).toBe('Not delivered')
    const buttons = group.findAll('.dm-btn')
    expect(buttons.map((b) => [b.text(), b.attributes('title')])).toEqual([
      ['Retry', 'Send the same message again'],
      ['Copy', 'Copy the message text']
    ])
    expect(buttons.every((b) => b.classes().includes('dm-btn--sm'))).toBe(true)
  })

  it('draws the group after the foot, as the design orders them', () => {
    const children = [...bubble('failed').element.children].map((el) => el.className)
    expect(children.slice(-2)).toEqual(['dm-bubble__foot', 'dm-bubble__actions'])
  })

  it.each(['sending', 'delivered', 'reacted'] as const)(
    'offers neither once the mark has left ✕ (%s)',
    (phase) => {
      expect(bubble(phase).find('.dm-bubble__actions').exists()).toBe(false)
    }
  )

  it('offers neither where its host offers no retry, as the read-only history does', () => {
    expect(bubble('failed', false).find('.dm-bubble__actions').exists()).toBe(false)
  })

  it('reports Retry and Copy to its host, and retries nothing itself', async () => {
    const wrapper = bubble('failed')
    const [retry, copy] = wrapper.findAll('.dm-bubble__actions .dm-btn')
    await retry!.trigger('click')
    await copy!.trigger('click')
    expect(wrapper.emitted('retry')).toEqual([[]])
    expect(wrapper.emitted('copy')).toEqual([[]])
  })

  it('brings the buttons back when the same bubble fails again', async () => {
    const wrapper = bubble('failed')
    await wrapper.setProps({ mark: bubbleMark(sendMarker({ phase: 'sending' })!) })
    expect(wrapper.find('.dm-bubble__actions').exists()).toBe(false)
    await wrapper.setProps({ mark: bubbleMark(sendMarker({ phase: 'failed' })!) })
    expect(wrapper.find('.dm-bubble__actions').exists()).toBe(true)
  })
})

/*
 * #635, decision log, Copy alone on a closed session (MESSAGE-QUESTIONS 4) — APPENDED. On a
 * session that can no longer take text, a failed message keeps Copy alone: Retry is absent, not
 * disabled, since nothing will ever make it work there, and the group keeps its name.
 */
describe('ChatBubble, not delivered on a closed session (#635)', () => {
  function closed(phase: DwarfSendState['phase'], offersRetry = false) {
    return mount(ChatBubble, {
      props: {
        from: 'user',
        text: 'Also check that the auto-invoke table still sorts.',
        time: '09:13',
        mark: bubbleMark(sendMarker({ phase })!),
        offersRetry,
        sessionClosed: true
      }
    })
  }

  it('keeps Copy alone in the group named Not delivered, with no Retry element at all', () => {
    const group = closed('failed').find('.dm-bubble__actions')
    expect(group.attributes('role')).toBe('group')
    expect(group.attributes('aria-label')).toBe('Not delivered')
    expect(group.findAll('.dm-btn').map((b) => [b.text(), b.attributes('title')])).toEqual([
      ['Copy', 'Copy the message text']
    ])
  })

  it('keeps Copy alone even where its host would offer a retry, as the design has it win', () => {
    const buttons = closed('failed', true).findAll('.dm-bubble__actions .dm-btn')
    expect(buttons.map((b) => b.text())).toEqual(['Copy'])
  })

  it.each(['sending', 'delivered', 'reacted'] as const)(
    'offers nothing once the mark has left ✕ (%s)',
    (phase) => {
      expect(closed(phase).find('.dm-bubble__actions').exists()).toBe(false)
    }
  )

  it('reports Copy to its host', async () => {
    const wrapper = closed('failed')
    await wrapper.find('.dm-bubble__actions .dm-btn').trigger('click')
    expect(wrapper.emitted('copy')).toEqual([[]])
    expect(wrapper.emitted('retry')).toBeUndefined()
  })
})
