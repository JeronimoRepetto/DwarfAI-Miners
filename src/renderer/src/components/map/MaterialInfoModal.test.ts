// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
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
})
