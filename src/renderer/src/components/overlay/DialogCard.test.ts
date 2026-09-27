// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import DialogCard from './DialogCard.vue'

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
