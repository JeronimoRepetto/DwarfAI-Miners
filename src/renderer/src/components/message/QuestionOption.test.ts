// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import QuestionOption from './QuestionOption.vue'

/*
 * The question option (#635, `molecules/question-option`): a 40px radio row, the 12px box, the
 * label and the number key on the right (components.md, Question option).
 */
describe('QuestionOption', () => {
  function option(props: Record<string, unknown> = {}) {
    return mount(QuestionOption, { props: { label: 'Postgres 16', index: 0, ...props } })
  }

  it('is a radio row that says whether it is picked', () => {
    const row = option()
    expect(row.element.tagName).toBe('BUTTON')
    expect(row.attributes('type')).toBe('button')
    expect(row.attributes('role')).toBe('radio')
    expect(row.attributes('aria-checked')).toBe('false')
    expect(option({ checked: true }).attributes('aria-checked')).toBe('true')
  })

  it('draws the box, the label and the number key, counted from one', () => {
    const row = option({ index: 2 })
    expect(row.classes()).toEqual(['dm-qopt', 'm-mat'])
    expect(row.find('.dm-qopt__box').exists()).toBe(true)
    expect(row.find('.dm-qopt__label').text()).toBe('Postgres 16')
    expect(row.find('.dm-qopt__key').text()).toBe('3')
  })

  it('marks the "Other thing…" row, and a look forced as the UI kit forces it', () => {
    expect(option({ other: true }).classes()).toContain('dm-qopt--other')
    expect(option({ state: 'hover' }).classes()).toContain('is-hover')
  })

  it('is a checkbox inside a toggling step', () => {
    expect(option({ toggle: true }).attributes('role')).toBe('checkbox')
  })

  /*
   * The design lead's ruling on MESSAGE-QUESTIONS 6 (2026-09-28): a description the agent sent
   * shows as Small text under the label, inside the same option; the row grows past 40px only for
   * it, an option without one stays the 40px row, and the key and the label keep their place.
   */
  it('shows the agent’s description under the label, and nothing where it sent none', () => {
    const described = option({ description: 'The one the API already uses.' })
    const text = described.find('.dm-qopt__text')
    expect(text.find('.dm-qopt__label').text()).toBe('Postgres 16')
    expect(text.find('.dm-qopt__desc').text()).toBe('The one the API already uses.')
    expect(described.find('.dm-qopt__key').text()).toBe('1')
    const plain = option()
    expect(plain.find('.dm-qopt__desc').exists()).toBe(false)
    expect(plain.find('.dm-qopt__text').exists()).toBe(false)
  })
})

/*
 * The permission's request block is the chat bubble's code block, no new component (decision log,
 * Permission request): the card's rule must carry every declaration of ChatBubble's `pre` rule.
 * Read off disk, as designTokens.test.ts reads its surfaces: a `<style>` block has no import a
 * test could assert against.
 */
describe('the request block', () => {
  function declarations(file: string, selector: string): string[] {
    const source = readFileSync(join(__dirname, file), 'utf8')
    const at = source.indexOf(selector + ' {')
    if (at < 0) throw new Error(`no ${selector} rule in ${file}`)
    const body = source.slice(source.indexOf('{', at) + 1, source.indexOf('}', at))
    return body
      .split(';')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter((line) => line !== '')
  }

  it('declares everything the chat bubble’s code block declares', () => {
    const bubble = declarations('ChatBubble.vue', '.dm-bubble :deep(pre)')
    const request = declarations('QuestionCard.vue', '.dm-qcard__req')
    // All but the sideways scroll, which the card replaces with wrapping (decision log,
    // Permission request; components.md: "lines wrap instead of scrolling sideways").
    for (const line of bubble.filter((l) => !l.startsWith('overflow-x'))) {
      expect(request).toContain(line)
    }
  })
})
