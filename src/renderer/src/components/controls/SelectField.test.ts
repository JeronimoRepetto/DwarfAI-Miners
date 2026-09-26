// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import SelectField from './SelectField.vue'

const MODES = ['Last used', 'Panel', 'Veta', 'Valle']

describe('SelectField', () => {
  it('is a wood face over the native select, then the chevron', () => {
    const select = mount(SelectField, { props: { options: MODES, label: 'Mode at launch' } })
    expect(select.element.tagName).toBe('SPAN')
    expect(select.classes()).toEqual(['dm-select', 'm-mat'])
    const parts = [...select.element.children]
    expect(parts.map((part) => part.tagName)).toEqual(['SELECT', 'SPAN'])
    expect(parts[1]!.classList.contains('dm-icon')).toBe(true)
    expect(parts[1]!.getAttribute('aria-hidden')).toBe('true')
    expect(select.get('select').attributes('aria-label')).toBe('Mode at launch')
  })

  it('lists every option by value and label, showing the first when no value is given', () => {
    const select = mount(SelectField, { props: { options: MODES } })
    const options = select.findAll('option')
    expect(options.map((option) => option.attributes('value'))).toEqual(MODES)
    expect(options.map((option) => option.text())).toEqual(MODES)
    expect((select.get('select').element as HTMLSelectElement).value).toBe('Last used')
  })

  it('shows the value asked for, and reports a choice', async () => {
    const select = mount(SelectField, {
      props: { options: [{ value: 'tiny5', label: 'Tiny5' }, 'Other'], value: 'Other' }
    })
    expect((select.get('select').element as HTMLSelectElement).value).toBe('Other')
    await select.get('select').setValue('tiny5')
    expect(select.emitted('update:value')).toEqual([['tiny5']])
  })

  it('disables the native control and marks the face', () => {
    const select = mount(SelectField, {
      props: { options: ['Jev decides'], label: 'Model', disabled: true }
    })
    expect(select.classes()).toContain('is-disabled')
    expect((select.get('select').element as HTMLSelectElement).disabled).toBe(true)
  })
})
