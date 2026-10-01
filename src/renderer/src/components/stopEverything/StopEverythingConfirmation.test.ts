// @vitest-environment jsdom
/*
 * The Stop everything and quit confirmation as drawn (ISSUE-317): the design's dialog (`molecules/dialog`: Cancel
 * first and holding focus, Tab trapped, Esc cancels; components.md, Dialog, Accessibility), the Host-owned count,
 * and the one danger message naming the dwarfs that could not be ended (S10.21). Its words are design's: every
 * string without approved copy is a marked placeholder (ADR-018 D5 copy items 4–7 and 9).
 */
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import StopEverythingConfirmation from './StopEverythingConfirmation.vue'

const COPY_NEEDED = /^⟦COPY NEEDED: .+⟧$/

afterEach(() => {
  document.body.innerHTML = ''
})

const press = (key: string, shiftKey = false): void => {
  ;(document.activeElement ?? document.body).dispatchEvent(
    new KeyboardEvent('keydown', { key, shiftKey, bubbles: true })
  )
}

const buttons = (): HTMLButtonElement[] => [
  ...document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')
]

async function shown(view: InstanceType<typeof StopEverythingConfirmation>['$props']['view']) {
  const wrapper = mount(StopEverythingConfirmation, {
    props: { view: { kind: 'closed' } },
    attachTo: document.body
  })
  await wrapper.setProps({ view })
  await flushPromises()
  return wrapper
}

describe('StopEverythingConfirmation', () => {
  it('[NFR-A11Y-03] the confirmation traps Tab and Esc cancels it', async () => {
    const wrapper = await shown({ kind: 'confirming', count: 2, sending: false })
    const dialog = document.body.querySelector('[role="dialog"]')
    expect(dialog?.getAttribute('aria-modal')).toBe('true')
    const [cancel, confirm] = buttons()
    expect(buttons()).toHaveLength(2)
    // Cancel comes first and holds the focus.
    expect(document.activeElement).toBe(cancel)

    press('Tab')
    expect(document.activeElement).toBe(confirm)
    press('Tab')
    expect(document.activeElement).toBe(cancel)
    press('Tab', true)
    expect(document.activeElement).toBe(confirm)

    press('Escape')
    expect(wrapper.emitted('cancel')).toHaveLength(1)
    expect(wrapper.emitted('confirm')).toBeUndefined()
    wrapper.unmount()
  })

  it('[US-RES-002.AC08, S10.18] the confirmation shows the count and Confirm sends, Cancel cancels', async () => {
    const wrapper = await shown({ kind: 'confirming', count: 3, sending: false })
    expect(buttons()).toHaveLength(2)
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('3')

    const [cancel, confirm] = buttons()
    confirm!.click()
    cancel!.click()
    expect(wrapper.emitted('confirm')).toHaveLength(1)
    expect(wrapper.emitted('cancel')).toHaveLength(1)
    wrapper.unmount()
  })

  it('[S10.20] once Confirm was chosen it is held and Esc cancels nothing', async () => {
    const wrapper = await shown({ kind: 'confirming', count: 1, sending: true })
    expect(buttons()).toHaveLength(2)
    const [, confirm] = buttons()
    expect(confirm!.disabled).toBe(true)
    press('Escape')
    expect(wrapper.emitted('cancel')).toBeUndefined()
    wrapper.unmount()
  })

  it('[S10.21, ADR-014] the danger message replaces the confirmation and names every dwarf that could not be ended', async () => {
    const wrapper = await shown({ kind: 'incomplete', failed: ['Brick', 'Charlie'] })
    const dialogs = document.body.querySelectorAll('[role="dialog"]')
    expect(dialogs).toHaveLength(1)
    expect(dialogs[0]!.classList.contains('dm-dialog--danger')).toBe(true)
    expect(dialogs[0]!.textContent).toContain('Brick')
    expect(dialogs[0]!.textContent).toContain('Charlie')
    expect(buttons()).toHaveLength(1)

    press('Escape')
    expect(wrapper.emitted('dismiss')).toHaveLength(1)
    expect(wrapper.emitted('cancel')).toBeUndefined()
    wrapper.unmount()
  })

  it('[ADR-002] every string of the view without approved copy is a marked placeholder', async () => {
    const confirming = await shown({ kind: 'confirming', count: 4, sending: false })
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
    const dialog = document.body.querySelector('[role="dialog"]')!
    expect(dialog.getAttribute('aria-label')).toMatch(COPY_NEEDED)
    for (const line of dialog.querySelectorAll('.dm-dialog__title, .dm-dialog__body p')) {
      expect(line.textContent?.trim()).toMatch(COPY_NEEDED)
    }
    // Cancel is the design's own dialog label (copy.md, Dialog); Confirm is design's to write.
    expect(buttons().map((b) => b.textContent?.trim())).toEqual([
      'Cancel',
      expect.stringMatching(COPY_NEEDED)
    ])
    confirming.unmount()
    document.body.innerHTML = ''

    const incomplete = await shown({ kind: 'incomplete', failed: ['Brick'] })
    const message = document.body.querySelector('[role="dialog"]')!
    expect(message.getAttribute('aria-label')).toMatch(COPY_NEEDED)
    for (const line of message.querySelectorAll('.dm-dialog__title, .dm-dialog__body p')) {
      expect(line.textContent?.trim()).toMatch(COPY_NEEDED)
    }
    expect(buttons().map((b) => b.textContent?.trim())).toEqual([
      expect.stringMatching(COPY_NEEDED)
    ])
    incomplete.unmount()
  })
})
