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

// ADDED for #635 (PR2 live fixes): a press on the scrim moves the focus out of the dialog (the
// scrim takes none), and Esc and the Tab trap must still hold wherever the focus went.
describe('ModalDialog after a pointer press outside the card', () => {
  const keyOn = (target: EventTarget, key: string) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))

  it('still cancels on Esc once the focus has left the dialog', async () => {
    const dialog = mount(ModalDialog, {
      props: { open: true, title: 'T', actions },
      attachTo: document.body
    })
    await flushPromises()
    ;(document.activeElement as HTMLElement).blur()
    keyOn(document.body, 'Escape')
    expect(dialog.emitted('cancel')).toHaveLength(1)
    dialog.unmount()
  })

  it('brings Tab back inside the dialog from wherever the focus went', async () => {
    const dialog = mount(ModalDialog, {
      props: { open: true, title: 'T', actions },
      attachTo: document.body
    })
    await flushPromises()
    ;(document.activeElement as HTMLElement).blur()
    keyOn(document.body, 'Tab')
    expect(document.activeElement?.closest('.dm-dialog')).not.toBeNull()
    dialog.unmount()
  })

  it('pulls the focus back when a control behind the scrim takes it', async () => {
    const behind = document.createElement('button')
    document.body.appendChild(behind)
    const dialog = mount(ModalDialog, {
      props: { open: true, title: 'T', actions },
      attachTo: document.body
    })
    await flushPromises()
    behind.focus()
    expect(document.activeElement?.closest('.dm-dialog')).not.toBeNull()
    dialog.unmount()
  })
})
