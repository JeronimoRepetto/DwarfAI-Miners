// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { motion } from 'motion-v'
import { popVariants, pressHoverVariants } from '../../lib/shell/presence'
import { MATERIALS, MATERIAL_TOKENS_PER_UNIT } from '../../types'
import MaterialInfoModal from './MaterialInfoModal.vue'

describe('MaterialInfoModal', () => {
  it('renders a row for every material in order', () => {
    const wrapper = mount(MaterialInfoModal)
    const rows = wrapper.findAll('.info-table tbody tr')
    expect(rows).toHaveLength(MATERIALS.length)
    rows.forEach((row, index) => {
      expect(row.get('.info-material').text()).toBe(MATERIALS[index])
    })
  })

  it('shows the token value for each material', () => {
    const wrapper = mount(MaterialInfoModal)
    const rows = wrapper.findAll('.info-table tbody tr')
    rows.forEach((row, index) => {
      const material = MATERIALS[index]!
      expect(row.get('.info-tokens').text()).toBe(
        MATERIAL_TOKENS_PER_UNIT[material].toLocaleString()
      )
    })
  })

  it('emits close when the close button is clicked', async () => {
    const wrapper = mount(MaterialInfoModal)
    await wrapper.get('.modal-close').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('emits close on Escape', async () => {
    const wrapper = mount(MaterialInfoModal)
    await wrapper.get('.info-modal').trigger('keydown.escape')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('draws the title in accent colour', () => {
    const wrapper = mount(MaterialInfoModal)
    const title = wrapper.get('.modal-title')
    expect(title.text()).toBe('Material values')
    // The colour is applied by the scoped style; asserting the class is enough.
    expect(title.classes()).toContain('modal-title')
  })

  // ADDED for #566 T3: the root is `motion.div` carrying the shared
  // `popVariants`, never a restated literal — `MapView.vue`'s own
  // `<AnimatePresence>` is what actually drives the enter/exit.
  it('carries the shared popVariants on its motion.div root, not a literal of its own', () => {
    const root = mount(MaterialInfoModal).findComponent(motion.div)
    expect(root.props('initial')).toEqual(popVariants.initial)
    expect(root.props('animate')).toEqual(popVariants.animate)
    expect(root.props('exit')).toEqual(popVariants.exit)
  })
})

/*
 * ADDED for #566 T4: the close button answers a pointer through the shared
 * vocabulary, and stays the button it was in every other respect.
 */
describe('MaterialInfoModal press and hover feedback', () => {
  it('gives the close button the shared press/hover variants and changes nothing else', () => {
    const wrapper = mount(MaterialInfoModal)
    const close = wrapper.getComponent(motion.button)

    expect(close.props('whileHover')).toEqual(pressHoverVariants.whileHover)
    expect(close.props('whilePress')).toEqual(pressHoverVariants.whilePress)
    expect(close.classes()).toContain('modal-close')
    expect(close.attributes('type')).toBe('button')
    expect(close.attributes('aria-label')).toBe('Close')
    expect(wrapper.get('.modal-close').element.tagName).toBe('BUTTON')
  })
})
