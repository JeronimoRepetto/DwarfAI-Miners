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
  /*
   * AMENDED for #635 (the design drew the ruling since, decision log, Question option description;
   * was: the label and description stacked in a `.dm-qopt__text` wrapper, the app's own reading).
   * The design's row is `.dm-qopt--desc`, a grid with the box, the label, the description and the
   * key as its direct children, in that order.
   */
  it('shows the agent’s description under the label, and nothing where it sent none', () => {
    const described = option({ description: 'The one the API already uses.' })
    expect(described.classes()).toContain('dm-qopt--desc')
    const parts = described.findAll(':scope > span').map((part) => part.classes().join(' '))
    expect(parts).toEqual(['dm-qopt__box', 'dm-qopt__label', 'dm-qopt__desc', 'dm-qopt__key'])
    expect(described.find('.dm-qopt__label').text()).toBe('Postgres 16')
    expect(described.find('.dm-qopt__desc').text()).toBe('The one the API already uses.')
    expect(described.find('.dm-qopt__key').text()).toBe('1')
    const plain = option()
    expect(plain.find('.dm-qopt__desc').exists()).toBe(false)
    expect(plain.classes()).not.toContain('dm-qopt--desc')
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

/* --- ISSUE-260: the option rows under the C-08 rule (ISSUE-251 follow-up) — one block, appended --- */

/*
 * An option's label and description are the agent's words, an ask payload (18 §5.1, C-08): drawn
 * without their controls and escapes, each inside a bidi-isolated text node of its own, so an
 * override inside one cannot reorder the row's number key or the next row.
 */
describe('QuestionOption untrusted strings (C-08)', () => {
  it('[NFR-SEC-07] draws a hostile label and description stripped, each inside its own bdi', () => {
    const row = mount(QuestionOption, {
      props: {
        label: '\u001b[31mAllow\u202E exe.txt\u0000\u001b[0m',
        index: 0,
        description: 'Runs \u2066it\u2069 now\u0007'
      }
    })
    expect(row.find('.dm-qopt__label').element.textContent).toBe('Allow exe.txt')
    expect(row.find('.dm-qopt__desc').element.textContent).toBe('Runs it now')
    const label = row.find('.dm-qopt__label > bdi')
    expect(label.exists(), 'no <bdi> around the label').toBe(true)
    expect(label.element.textContent).toBe('Allow exe.txt')
    const description = row.find('.dm-qopt__desc > bdi')
    expect(description.exists(), 'no <bdi> around the description').toBe(true)
    expect(description.element.textContent).toBe('Runs it now')
  })
})
