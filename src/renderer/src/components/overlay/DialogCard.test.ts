// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import DialogCard from './DialogCard.vue'
import dialogCardSource from './DialogCard.vue?raw'

const typedActions = [
  { label: 'Cancel' },
  { label: 'Reset metrics', variant: 'danger' as const, confirms: true }
]

describe('DialogCard', () => {
  it('is a dialog named by its title, its body, then its actions in order', () => {
    const card = mount(DialogCard, {
      props: {
        title: 'Remove alpha?',
        body: 'The mine leaves the valley.',
        danger: true,
        actions: [{ label: 'Cancel' }, { label: 'Remove mine', variant: 'danger' }]
      }
    })
    expect(card.attributes()).toMatchObject({
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'Remove alpha?'
    })
    expect(card.get('.dm-dialog__title').text()).toBe('Remove alpha?')
    expect(card.get('.dm-dialog__body').text()).toBe('The mine leaves the valley.')
    expect(card.findAll('.dm-dialog__actions button').map((b) => b.text())).toEqual([
      'Cancel',
      'Remove mine'
    ])
    expect(card.classes()).toContain('dm-dialog--danger')
  })

  it('reports which action was pressed', async () => {
    const card = mount(DialogCard, {
      props: { title: 'T', actions: [{ label: 'Cancel' }, { label: 'Go', variant: 'primary' }] }
    })
    await card.findAll('.dm-dialog__actions button')[1]!.trigger('click')
    expect(card.emitted('action')).toEqual([[1]])
  })

  it('holds a confirming action until the typed word matches, trimmed and in any case', async () => {
    const card = mount(DialogCard, {
      props: { title: 'Reset all metrics?', typed: 'yes', actions: typedActions }
    })
    expect(card.get('.dm-dialog__typed').text()).toBe('Type "yes" to confirm')
    const confirm = card.findAll('.dm-dialog__actions button')[1]!
    expect(confirm.attributes('disabled')).toBeDefined()
    await card.get('input').setValue(' YES ')
    expect(confirm.attributes('disabled')).toBeUndefined()
  })

  it('confirms on Enter in the field only once the word matches', async () => {
    const card = mount(DialogCard, {
      props: { title: 'Reset all metrics?', typed: 'yes', actions: typedActions }
    })
    const field = card.get('input')
    await field.trigger('keydown', { key: 'Enter' })
    expect(card.emitted('action')).toBeUndefined()
    await field.setValue('yes')
    await field.trigger('keydown', { key: 'Enter' })
    expect(card.emitted('action')).toEqual([[1]])
  })

  it('drawn in place, it is not modal', () => {
    const card = mount(DialogCard, { props: { title: 'T', actions: [], static: true } })
    expect(card.attributes('aria-modal')).toBeUndefined()
    expect(card.classes()).toContain('dm-dialog--static')
  })
})

/*
 * Owner's rule (2026-10-02): a popup never scrolls sideways; its text wraps to fit the card, whatever its words. jsdom
 * lays nothing out, so this holds the card's declared CSS to that contract; stop-everything-ui.e2e.ts measures it on
 * the built app (scrollWidth <= clientWidth).
 */
describe('DialogCard never scrolls sideways', () => {
  const style = dialogCardSource.slice(dialogCardSource.indexOf('<style'))
  /** The declarations of the first rule whose selector list is exactly `selector`. */
  const rule = (selector: string): string => {
    const at = style.indexOf(`${selector} {`)
    expect(at, `a rule for ${selector}`).toBeGreaterThanOrEqual(0)
    return style.slice(at, style.indexOf('}', at))
  }

  it('[NFR-A11Y-03] the card holds one column no wider than itself and hides nothing sideways', () => {
    expect(rule('.dm-dialog')).toContain('grid-template-columns: minmax(0, 1fr)')
    expect(rule('.dm-dialog')).toMatch(/overflow-x: hidden/)
    expect(style).not.toMatch(/overflow-x: (auto|scroll)/)
  })

  it('[NFR-A11Y-03] the title, the body and the action labels wrap, a long word included', () => {
    for (const part of ['.dm-dialog__title', '.dm-dialog__body']) {
      expect(rule(part)).toContain('overflow-wrap: anywhere')
    }
    const buttons = rule('.dm-dialog__actions :deep(.dm-btn)')
    expect(buttons).toContain('white-space: normal')
    expect(buttons).toContain('overflow-wrap: anywhere')
    expect(buttons).toContain('max-width: 100%')
    expect(style).not.toContain('white-space: nowrap')
  })
})
