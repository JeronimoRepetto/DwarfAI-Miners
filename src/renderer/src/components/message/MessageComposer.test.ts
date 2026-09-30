// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import MessageComposer from './MessageComposer.vue'

/*
 * The composer on its own (#635, `molecules/composer`; components.md, Composer): Enter sends and
 * Shift+Enter breaks the line, an input method's Enter sends nothing, Send stays asleep until the
 * host says there is something to send, and a disabled well says so in its own placeholder. The
 * MessagePanel's tests pin everything the host decides; these pin what the molecule reports.
 */
function composer(props: Record<string, unknown> = {}) {
  return mount(MessageComposer, {
    props: { value: '', placeholder: 'Write to dwarfai-53…', hint: 'Enter sends', ...props }
  })
}

describe('MessageComposer (#635)', () => {
  it('reports Enter as a send, and keeps Shift+Enter as a new line', async () => {
    const wrapper = composer({ value: 'dig', canSend: true })
    const box = wrapper.find('textarea')
    await box.trigger('keydown', { key: 'Enter', shiftKey: true })
    expect(wrapper.emitted('submit')).toBeUndefined()
    await box.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('submit')).toHaveLength(1)
  })

  it('sends nothing on the Enter an input method uses to pick its candidate', async () => {
    const wrapper = composer({ value: 'dig', canSend: true })
    await wrapper.find('textarea').trigger('keydown', { key: 'Enter', keyCode: 229 })
    expect(wrapper.emitted('submit')).toBeUndefined()
  })

  it('keeps Send disabled until the host says there is something to send', async () => {
    expect(composer().find('.dm-composer__send').attributes('disabled')).toBeDefined()
    const live = composer({ canSend: true })
    await live.find('.dm-composer__send').trigger('click')
    expect(live.emitted('submit')).toHaveLength(1)
  })

  it('draws a disabled well with its reason as the placeholder, and Attach asleep', () => {
    const wrapper = composer({ disabled: true, placeholder: 'Choose a supplier first' })
    const box = wrapper.find('textarea')
    expect(box.attributes('disabled')).toBeDefined()
    expect(box.attributes('placeholder')).toBe('Choose a supplier first')
    expect(wrapper.find('.dm-composer__attach').attributes('disabled')).toBeDefined()
  })

  it('names each waiting file’s remove button and reports it by path', async () => {
    const wrapper = composer({ files: [{ path: 'C:/x/notes.md', name: 'notes.md' }] })
    const remove = wrapper.find('.dm-composer__file button')
    expect(remove.attributes('aria-label')).toBe('Remove notes.md')
    await remove.trigger('click')
    expect(wrapper.emitted('remove')).toEqual([['C:/x/notes.md']])
  })

  it('lights its edge while a drag is over it and reports the drop', async () => {
    const wrapper = composer()
    await wrapper.trigger('dragover')
    expect(wrapper.classes()).toContain('is-dragging')
    await wrapper.trigger('drop')
    expect(wrapper.classes()).not.toContain('is-dragging')
    expect(wrapper.emitted('drop')).toHaveLength(1)
  })

  it('speaks a refusal in the hint as an alert, and a status as a status', () => {
    const alert = composer({ hint: 'Too long.', hintRole: 'alert' }).find('.dm-composer__hint')
    expect(alert.attributes('role')).toBe('alert')
    expect(alert.classes()).toContain('is-error')
    const quiet = composer().find('.dm-composer__hint')
    expect(quiet.attributes('role')).toBeUndefined()
    expect(quiet.text()).toBe('Enter sends')
  })
})
