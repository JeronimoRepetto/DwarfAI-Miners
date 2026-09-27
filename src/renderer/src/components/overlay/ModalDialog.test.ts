// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import ModalDialog from './ModalDialog.vue'

const actions = [{ label: 'Cancel' }, { label: 'Remove mine', variant: 'danger' as const }]

const press = (key: string): void => {
  document.body
    .querySelector('.dm-scrim')!
    .dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('ModalDialog', () => {
  it('draws nothing while closed', () => {
    mount(ModalDialog, { props: { open: false, title: 'T', actions } })
    expect(document.body.querySelector('.dm-scrim')).toBeNull()
  })

  it('puts the card on a scrim in <body>, and Cancel holds the focus', async () => {
    const dialog = mount(ModalDialog, {
      props: { open: false, title: 'Remove alpha?', actions },
      attachTo: document.body
    })
    await dialog.setProps({ open: true })
    await flushPromises()
    expect(document.body.querySelector('.dm-scrim [role="dialog"]')).not.toBeNull()
    expect(document.activeElement?.textContent).toBe('Cancel')
    dialog.unmount()
  })

  it('cancels on Esc', async () => {
    const dialog = mount(ModalDialog, {
      props: { open: true, title: 'T', actions },
      attachTo: document.body
    })
    await flushPromises()
    press('Escape')
    expect(dialog.emitted('cancel')).toHaveLength(1)
    dialog.unmount()
  })

  it('keeps Tab inside the dialog, wrapping from the last control to the first', async () => {
    const dialog = mount(ModalDialog, {
      props: { open: true, title: 'T', actions },
      attachTo: document.body
    })
    await flushPromises()
    const buttons = [...document.body.querySelectorAll<HTMLElement>('.dm-dialog__actions button')]
    buttons[1]!.focus()
    press('Tab')
    expect(document.activeElement).toBe(buttons[0])
    dialog.unmount()
  })

  it('gives the focus back to whatever held it before it opened', async () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const dialog = mount(ModalDialog, {
      props: { open: false, title: 'T', actions },
      attachTo: document.body
    })
    await dialog.setProps({ open: true })
    await flushPromises()
    await dialog.setProps({ open: false })
    await flushPromises()
    expect(document.activeElement).toBe(opener)
    dialog.unmount()
  })
})
