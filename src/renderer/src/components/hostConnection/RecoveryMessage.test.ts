// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { useToasts } from '../../composables/useToasts'
import RecoveryMessage from './RecoveryMessage.vue'

/*
 * The grouped recovery message (ADR-015 item 5; 14 §6.4 recovery-message store; ISSUE-330): one dialog on the
 * Host-state surface, in the crash-loop message's family, naming every dwarf that could not be recovered, with
 * Dismiss and Try again. Never a toast, and never one message per dwarf (INV-58: one report per Host epoch).
 * The copy is the owner's, approved 2026-10-17.
 */
const TITLE = 'Some dwarfs could not come back'
const BODY = "DwarfAI restarted in the background and could not resume these dwarfs' sessions:"

describe('RecoveryMessage', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('[ADR-015, INV-58] the message is one element with retry and dismiss and no toast is added for a listed dwarf', async () => {
    const wrapper = mount(RecoveryMessage, {
      props: { shown: true, names: ['Borin', 'דוד'] },
      attachTo: document.body
    })
    await flushPromises()

    const dialogs = document.body.querySelectorAll('[role="dialog"]')
    expect(dialogs).toHaveLength(1)
    const dialog = dialogs[0]!
    expect(dialog.getAttribute('aria-label')).toBe(TITLE)
    expect(dialog.textContent).toContain(BODY)
    // Each name in its own <bdi>, so a name's direction never reorders the list around it.
    expect([...dialog.querySelectorAll('li bdi')].map((node) => node.textContent)).toEqual([
      'Borin',
      'דוד'
    ])

    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(['Dismiss', 'Try again'])
    buttons[0]!.click()
    expect(wrapper.emitted('dismiss')).toHaveLength(1)
    buttons[1]!.click()
    expect(wrapper.emitted('retry')).toHaveLength(1)

    // No per-dwarf "stopped unexpectedly" toast (PO #62) for a listed dwarf: the message is the only notice.
    expect(useToasts().toasts.value).toHaveLength(0)
    wrapper.unmount()
  })

  it('[ADR-015] an action on its way cannot be pressed again, and a covered or settled message draws nothing', async () => {
    const acting = mount(RecoveryMessage, {
      props: { shown: true, names: ['Borin'], acting: true },
      attachTo: document.body
    })
    await flushPromises()
    const buttons = [...document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
    expect(buttons).toHaveLength(2)
    for (const button of buttons) expect(button.hasAttribute('disabled')).toBe(true)
    acting.unmount()
    document.body.innerHTML = ''

    const covered = mount(RecoveryMessage, {
      props: { shown: true, names: ['Borin'], covered: true },
      attachTo: document.body
    })
    await flushPromises()
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    covered.unmount()

    const settled = mount(RecoveryMessage, {
      props: { shown: false, names: [] },
      attachTo: document.body
    })
    await flushPromises()
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    settled.unmount()
  })
})
