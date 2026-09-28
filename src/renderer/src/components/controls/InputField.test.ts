// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import FieldHint from './FieldHint.vue'
import InputField from './InputField.vue'

describe('InputField', () => {
  it('is a label wrapping the native input, carrying the material recipe', () => {
    const field = mount(InputField, { props: { placeholder: 'Project folder' } })
    expect(field.element.tagName).toBe('LABEL')
    expect(field.classes()).toEqual(['dm-field', 'm-mat'])
    const input = field.get('input')
    expect(input.attributes('type')).toBe('text')
    expect(input.attributes('placeholder')).toBe('Project folder')
    expect(input.attributes('aria-label')).toBe('Project folder')
    expect(field.find('.dm-field__clear').exists()).toBe(false)
  })

  it('shows its value and reports each edit', async () => {
    const field = mount(InputField, { props: { value: 'lantern' } })
    const input = field.get('input')
    expect((input.element as HTMLInputElement).value).toBe('lantern')
    await input.setValue('lantern-docs')
    expect(field.emitted('update:value')).toEqual([['lantern-docs']])
  })

  it('follows a value its host changes', async () => {
    const field = mount(InputField, { props: { value: 'a' } })
    await field.setProps({ value: 'b' })
    expect((field.get('input').element as HTMLInputElement).value).toBe('b')
  })

  it('is a textarea in the textarea variant', () => {
    const field = mount(InputField, { props: { area: true, rows: 3, placeholder: 'Prompt' } })
    expect(field.classes()).toContain('dm-field--area')
    expect(field.find('input').exists()).toBe(false)
    expect(field.get('textarea').attributes('rows')).toBe('3')
  })

  it('disables the native control', () => {
    const field = mount(InputField, { props: { placeholder: 'Choose', disabled: true } })
    expect(field.classes()).toContain('is-disabled')
    expect((field.get('input').element as HTMLInputElement).disabled).toBe(true)
  })

  describe('as a search', () => {
    it('draws the search glyph, then the control, then a clear button hidden while empty', () => {
      const field = mount(InputField, { props: { search: true, placeholder: 'Search by name' } })
      const parts = [...field.element.children]
      expect(parts.map((part) => part.tagName)).toEqual(['SPAN', 'INPUT', 'BUTTON'])
      expect(parts[0]!.classList.contains('dm-icon')).toBe(true)
      expect(field.get('input').attributes('type')).toBe('search')
      const clear = field.get('button.dm-field__clear')
      expect(clear.attributes('type')).toBe('button')
      expect(clear.attributes('aria-label')).toBe('Clear search')
      expect(clear.attributes('title')).toBe('Clear search')
      expect(clear.attributes('hidden')).toBeDefined()
    })

    it('shows the clear button once it has text', async () => {
      const field = mount(InputField, { props: { search: true } })
      await field.get('input').setValue('ai-')
      expect(field.get('.dm-field__clear').attributes('hidden')).toBeUndefined()
    })

    it('clears with its button and keeps focus in the field, since the button goes away', async () => {
      const field = mount(InputField, {
        props: { search: true, value: 'ai-' },
        attachTo: document.body
      })
      await field.get('.dm-field__clear').trigger('click')
      expect((field.get('input').element as HTMLInputElement).value).toBe('')
      expect(field.emitted('update:value')).toEqual([['']])
      expect(document.activeElement).toBe(field.get('input').element)
      field.unmount()
    })

    it('clears with Esc first, and only an empty search lets Esc reach the layer', async () => {
      const layer: string[] = []
      const host = document.createElement('div')
      host.addEventListener('keydown', (event) => layer.push(event.key))
      document.body.appendChild(host)
      const field = mount(InputField, { props: { search: true, value: 'ai-' }, attachTo: host })
      await field.get('input').trigger('keydown', { key: 'Escape' })
      expect((field.get('input').element as HTMLInputElement).value).toBe('')
      expect(layer).toEqual([])
      await field.get('input').trigger('keydown', { key: 'Escape' })
      expect(layer).toEqual(['Escape'])
      field.unmount()
      host.remove()
    })
  })
})

describe('FieldHint', () => {
  it('is the help line under a field, in danger ink when it reports an error', () => {
    const hint = mount(FieldHint, { props: { error: true }, slots: { default: 'Say yes.' } })
    expect(hint.element.tagName).toBe('P')
    expect(hint.classes()).toEqual(['dm-field__hint', 'is-error'])
    expect(hint.text()).toBe('Say yes.')
    expect(mount(FieldHint).classes()).toEqual(['dm-field__hint'])
  })
})

// APPENDED for #635: the design lead's ruling on the atoms questions (question 3) — an invalid
// input carries aria-invalid="true" and aria-describedby pointing at its hint.
describe('InputField with its hint', () => {
  it('marks the invalid control and ties it to the hint that says why', () => {
    const field = mount(InputField, {
      props: { placeholder: 'Folder', invalid: true, describedBy: 'folder-hint' }
    })
    const input = field.get('input')
    expect(input.attributes('aria-invalid')).toBe('true')
    expect(input.attributes('aria-describedby')).toBe('folder-hint')
    const hint = mount(FieldHint, { props: { error: true }, attrs: { id: 'folder-hint' } })
    expect(hint.attributes('id')).toBe('folder-hint')
  })
})
