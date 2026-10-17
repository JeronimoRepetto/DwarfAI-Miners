// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h, ref, type Component } from 'vue'
import ModalDialog from '../components/overlay/ModalDialog.vue'
import MenuButton from '../components/overlay/MenuButton.vue'
import MenuList from '../components/overlay/MenuList.vue'
import InputField from '../components/controls/InputField.vue'
import type { MenuEntry } from '../lib/overlay/menu'

/*
 * L12 unit (ISSUE-266; 17 §1.12): the overlay stack across every Panel surface. Esc closes the topmost layer first and
 * hands the focus back to what opened it, a search field's text going before any layer (NFR-A11Y-02); every dialog
 * traps Tab, opens on Cancel and gives the focus back (NFR-A11Y-03); a disabled menu item stays, is skipped and says
 * why (NFR-A11Y-14). Each surface's own cases live beside it (ISSUE-253…265); these are the cases between surfaces.
 */

const COMPONENTS = join(__dirname, '..', 'components')

let mounted: VueWrapper[] = []

afterEach(() => {
  for (const wrapper of mounted) wrapper.unmount()
  mounted = []
  document.body.innerHTML = ''
})

async function press(key: string, init: KeyboardEventInit = {}): Promise<KeyboardEvent> {
  const target = document.activeElement ?? document.body
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  await flushPromises()
  return event
}

const active = (): Element | null => document.activeElement

const MENU: MenuEntry[] = [
  { label: 'Open history' },
  { label: 'Reset name', disabled: true, title: 'Reset name · no custom name' },
  { label: 'Stop dwarf…', danger: true }
]

/**
 * A dialog, opened from a button, holding whatever `inside` draws: the stack every Panel dialog builds on. The dialog
 * closes on its `cancel`, as each caller does.
 */
function dialogHolding(inside: () => ReturnType<typeof h>[]) {
  const Host = defineComponent({
    setup() {
      const open = ref(false)
      return () => [
        h('button', { class: 'opener', onClick: () => (open.value = true) }, 'Open'),
        h(
          ModalDialog,
          {
            open: open.value,
            title: 'Remove mine?',
            actions: [{ label: 'Cancel' }, { label: 'Remove', variant: 'danger' }],
            onCancel: () => (open.value = false),
            onAction: () => (open.value = false)
          },
          inside
        )
      ]
    }
  })
  const wrapper = mount(Host, { attachTo: document.body })
  mounted.push(wrapper)
  return wrapper
}

async function opened(wrapper: VueWrapper): Promise<HTMLButtonElement> {
  const opener = wrapper.get('.opener').element as HTMLButtonElement
  opener.focus()
  opener.click()
  await flushPromises()
  return opener
}

const dialogOpen = (): boolean => document.querySelector('.dm-dialog') !== null

/** Every renderer component, by its path under components/. */
function components(dir = COMPONENTS): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? components(join(dir, entry.name))
      : entry.name.endsWith('.vue')
        ? [relative(COMPONENTS, join(dir, entry.name)).split(sep).join('/')]
        : []
  )
}

describe('the overlay stack (L12, 17 §1.12)', () => {
  it('[NFR-A11Y-02] Esc closes the topmost layer and returns focus to its opener, and in a search field with text clears it first', async () => {
    // A menu: Esc closes it and the focus goes back to its button.
    const alone = mount(MenuButton, {
      props: { items: MENU, title: 'More' },
      attachTo: document.body
    })
    mounted.push(alone)
    const button = alone.get('button').element as HTMLButtonElement
    button.focus()
    button.click()
    await flushPromises()
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    expect(active()?.getAttribute('role')).toBe('menuitem')
    await press('Escape')
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(active()).toBe(button)

    // A dialog: Esc cancels it and the focus goes back to the button that opened it.
    const plain = dialogHolding(() => [h('p', 'It goes from the list.')])
    const opener = await opened(plain)
    expect(dialogOpen()).toBe(true)
    await press('Escape')
    expect(dialogOpen()).toBe(false)
    expect(active()).toBe(opener)
    plain.unmount()
    mounted = mounted.filter((wrapper) => wrapper !== plain)

    // A search field with text inside a dialog: the first Esc clears it, the next closes the dialog.
    const searching = dialogHolding(() => [h(InputField, { search: true, value: 'cop' })])
    const searchOpener = await opened(searching)
    const input = document.querySelector<HTMLInputElement>('.dm-dialog input')!
    input.focus()
    await press('Escape')
    expect(input.value, 'the text cleared').toBe('')
    expect(dialogOpen(), 'the dialog stays open').toBe(true)
    await press('Escape')
    expect(dialogOpen()).toBe(false)
    expect(active()).toBe(searchOpener)
  })

  it('[NFR-A11Y-03] every Panel dialog traps Tab, opens on Cancel and restores focus on close', async () => {
    const wrapper = dialogHolding(() => [h('p', 'It goes from the list.')])
    const opener = await opened(wrapper)
    const actions = [...document.querySelectorAll<HTMLButtonElement>('.dm-dialog__actions button')]
    // Opens on Cancel.
    expect(actions.map((action) => action.textContent?.trim())).toEqual(['Cancel', 'Remove'])
    expect(active()).toBe(actions[0])
    // Tab and Shift+Tab cycle inside it only.
    await press('Tab')
    expect(active()).toBe(actions[1])
    await press('Tab')
    expect(active()).toBe(actions[0])
    await press('Tab', { shiftKey: true })
    expect(active()).toBe(actions[1])
    // A focus that lands behind the scrim is pulled back in.
    opener.focus()
    await flushPromises()
    expect(document.querySelector('.dm-dialog')?.contains(active())).toBe(true)
    // Closing gives the focus back to the opener.
    await press('Escape')
    expect(dialogOpen()).toBe(false)
    expect(active()).toBe(opener)

    // Every Panel dialog is this one: no component draws a modal dialog of its own, and each one's actions open on
    // Cancel (or its one Close), never on the action that acts.
    const own = components().filter(
      (file) =>
        !file.startsWith('overlay/') &&
        /aria-modal|role="alertdialog"/.test(readFileSync(join(COMPONENTS, file), 'utf8'))
    )
    expect(own).toEqual([])
    const users = components().filter((file) =>
      readFileSync(join(COMPONENTS, file), 'utf8').includes('<ModalDialog')
    )
    expect(users.length).toBeGreaterThan(5)
  })

  it('[NFR-A11Y-14] a disabled menu item is visible, skipped by arrow keys and exposes its reason as its description', async () => {
    const wrapper = mount(MenuList as Component, {
      props: { items: MENU },
      attachTo: document.body
    })
    mounted.push(wrapper)
    const disabled = wrapper.get('[data-index="1"]').element as HTMLButtonElement
    // Visible: in the menu, in its place, the menu keeping one shape.
    expect(disabled.hidden).toBe(false)
    expect(disabled.getAttribute('aria-hidden')).toBeNull()
    expect(wrapper.findAll('[role="menuitem"]').map((item) => item.text())).toEqual([
      'Open history',
      'Reset name',
      'Stop dwarf…'
    ])
    expect(disabled.disabled).toBe(true)
    // Skipped by the arrows, both ways.
    ;(wrapper.get('[data-index="0"]').element as HTMLElement).focus()
    await press('ArrowDown')
    expect(active()).toBe(wrapper.get('[data-index="2"]').element)
    await press('ArrowUp')
    expect(active()).toBe(wrapper.get('[data-index="0"]').element)
    // Its reason is its accessible description: named by its label, described by the reason it cannot act.
    const describedBy = disabled.getAttribute('aria-describedby')
    const description =
      describedBy !== null
        ? describedBy
            .split(' ')
            .map((id) => document.getElementById(id)?.textContent ?? '')
            .join(' ')
        : (disabled.getAttribute('title') ?? '')
    expect(disabled.getAttribute('aria-label') ?? disabled.textContent?.trim()).toBe('Reset name')
    expect(description).toBe('Reset name · no custom name')
  })
})
