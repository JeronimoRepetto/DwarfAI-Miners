// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { sendMarker } from '../../lib/delivery/deliveryVerdict'
import { bubbleMark } from '../../lib/message/panelChrome'
import {
  permissionAnswerRecord,
  questionAnswersRecord,
  wordsAnswerRecord
} from '../../lib/question/answersRecord'
import type { DwarfPermissionRequest, DwarfQuestion, DwarfSendState } from '../../types'
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

/* --- The "Answers:" record, shown literally (#635, MESSAGE-QUESTIONS 8) — one block, appended -- */

/*
 * The record shows what was asked and answered exactly as it was written: the words are the agent's
 * and the person's, and a character the bubble's Markdown would read as formatting must render as
 * itself. Only the answer's bold is the record's own. Checked through the real render path — the
 * record's text, drawn by ChatBubble's Markdown — since a string that looks escaped proves nothing
 * about what the parser makes of it.
 */
describe('ChatBubble, an "Answers:" record drawn literally (#635)', () => {
  function ask(question: string): DwarfQuestion {
    return {
      toolUseId: 'toolu_01',
      channel: 'held',
      questions: [{ question, multiSelect: false, options: [{ label: 'x' }] }]
    }
  }

  function drawn(text: string) {
    return mount(ChatBubble, { props: { from: 'user', text } }).find('.dm-bubble__text')
  }

  /** The one item's visible text, and that nothing but the answer's bold was made of it. */
  function expectLiteral(text: string, step: string, answer: string): void {
    const body = drawn(text)
    expect(body.find('p').text()).toBe('Answers:')
    const items = body.findAll('li')
    expect(items).toHaveLength(1)
    expect(items[0]!.element.textContent).toBe(`${step}: ${answer}`)
    const bold = items[0]!.findAll('strong')
    expect(bold).toHaveLength(1)
    expect(bold[0]!.element.textContent).toBe(answer)
    for (const made of [
      'em',
      'code',
      'a',
      's',
      'del',
      'ol',
      'ul ul',
      'blockquote',
      'pre',
      'table'
    ]) {
      expect(items[0]!.find(made).exists(), made).toBe(false)
    }
  }

  it.each([
    ['**bold** and *em*', '__under__ and _em_'],
    ['use `pnpm`', '```fenced```'],
    ['a [link](https://example.test) here', '[x] and ![img](https://example.test/a.png)'],
    ['~~struck~~', 'a \\ backslash \\* and \\\\'],
    ['<https://example.test> and &amp; and &#42;', '<b>tag</b>'],
    ['a | pipe | row', '1) not a list']
  ])('draws the question %j and the answer %j as they were written', (question, answer) => {
    expectLiteral(questionAnswersRecord(ask(question), [answer]), question, answer)
  })

  it.each([
    '- a dash',
    '+ a plus',
    '* a star',
    '# a heading',
    '> a quote',
    '1. a number',
    '12) a number'
  ])('draws a question opening with a block marker, %j, as text', (question) => {
    expectLiteral(questionAnswersRecord(ask(question), ['yes']), question, 'yes')
  })

  it('draws a person’s own words literally', () => {
    expectLiteral(wordsAnswerRecord(ask('Where?'), '*not* `here`'), 'Where', '*not* `here`')
  })

  it('draws a permission’s request literally, Allow still in bold', () => {
    const permission: DwarfPermissionRequest = {
      toolUseId: 'toolu_p1',
      toolName: 'Bash',
      input: 'rm -rf *.log && echo `date` > _out_',
      channel: 'held',
      askedAt: '2026-09-28T09:00:00.000Z'
    }
    expectLiteral(
      permissionAnswerRecord(permission, 'allow'),
      'Bash · rm -rf *.log && echo `date` > _out_',
      'Allow'
    )
  })
})
/* --- end of the "Answers:" record block ------------------------------------- */
