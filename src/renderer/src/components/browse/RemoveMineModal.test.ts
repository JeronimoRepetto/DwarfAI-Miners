// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { motion } from 'motion-v'
import { popVariants, pressHoverVariants } from '../../lib/shell/presence'
import RemoveMineModal from './RemoveMineModal.vue'

function modal(props: Record<string, unknown> = {}) {
  return mount(RemoveMineModal, {
    props: { name: 'Lalo-Test', removing: false, error: null, ...props }
  })
}

/**
 * The per-mine removal confirmation (#169).
 *
 * It reuses components.md's shared Confirmation modal, which the design source
 * only ever fills in with Settings' metrics wipe. What it does NOT reuse is the
 * typed `yes`: that gate exists because the metrics wipe is irreversible, and
 * this is the one destructive action in the app that can be undone by adding
 * the folder again. Asking for typing here would misdescribe the act.
 */
describe('RemoveMineModal', () => {
  it('names the mine it is about to remove', () => {
    expect(modal().get('.modal-message').text()).toContain('Lalo-Test')
  })

  it('says the ore is kept and the mine can come back', () => {
    // The one thing a user cannot see and must be told: this is not the
    // metrics wipe. Nothing mined is lost, and the folder can be added again.
    const text = modal().get('.modal-message').text()
    expect(text).toMatch(/mined|ore|material/i)
    expect(text).toMatch(/add/i)
  })

  it('reports the confirmed intent, once', async () => {
    const wrapper = modal()
    await wrapper.get('.modal-confirm').trigger('click')
    expect(wrapper.emitted('confirm')).toHaveLength(1)
  })

  it('reports a dismissal without confirming anything', async () => {
    const wrapper = modal()
    await wrapper.get('.modal-close').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
    expect(wrapper.emitted('confirm')).toBeUndefined()
  })

  it('closes on Escape, like every other panel that floats', async () => {
    const wrapper = modal()
    await wrapper.get('.remove-modal').trigger('keydown.escape')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('locks Confirm while the removal is in flight, so it cannot fire twice', async () => {
    const wrapper = modal({ removing: true })
    expect(wrapper.get('.modal-confirm').attributes('disabled')).toBeDefined()
    await wrapper.get('.modal-confirm').trigger('click')
    expect(wrapper.emitted('confirm')).toBeUndefined()
  })

  it('shows why the removal failed, as an alert', () => {
    const wrapper = modal({ error: 'The database is locked.' })
    expect(wrapper.get('.modal-error').text()).toBe('The database is locked.')
    expect(wrapper.get('.modal-error').attributes('role')).toBe('alert')
  })

  it('shows no error row when nothing has gone wrong', () => {
    expect(modal().find('.modal-error').exists()).toBe(false)
  })

  // ADDED for #566 T3: the root is `motion.div` carrying the shared
  // `popVariants`, never a restated literal — `MinesPanel.vue`'s own
  // `<AnimatePresence>` is what actually drives the enter/exit.
  it('carries the shared popVariants on its motion.div root, not a literal of its own', () => {
    const root = modal().findComponent(motion.div)
    expect(root.props('initial')).toEqual(popVariants.initial)
    expect(root.props('animate')).toEqual(popVariants.animate)
    expect(root.props('exit')).toEqual(popVariants.exit)
  })
})

/*
 * ADDED for #566 T4: both of this modal's buttons answer a pointer through the
 * shared vocabulary. Named rather than counted, so a third button added later
 * without feedback fails here.
 */
describe('RemoveMineModal press and hover feedback', () => {
  it('routes both buttons through motion.button carrying the shared variants', () => {
    const controls = modal().findAllComponents(motion.button)

    expect(controls.map((control) => control.classes()[0])).toEqual([
      'modal-close',
      'modal-confirm'
    ])
    for (const control of controls) {
      expect(control.props('whileHover')).toEqual(pressHoverVariants.whileHover)
      expect(control.props('whilePress')).toEqual(pressHoverVariants.whilePress)
    }
  })

  it('leaves both buttons as they were - tag, name, and the refusal while removing', () => {
    const wrapper = modal({ removing: true })

    const close = wrapper.get('.modal-close')
    expect(close.element.tagName).toBe('BUTTON')
    expect(close.attributes('type')).toBe('button')
    expect(close.attributes('aria-label')).toBe('Close')

    const confirm = wrapper.get('.modal-confirm')
    expect(confirm.element.tagName).toBe('BUTTON')
    expect(confirm.attributes('disabled')).toBeDefined()
  })
})
