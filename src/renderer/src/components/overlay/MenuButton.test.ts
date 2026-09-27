// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import MenuButton from './MenuButton.vue'

const items = [{ label: 'Remove mine…', danger: true }]

afterEach(() => {
  document.body.innerHTML = ''
})

describe('MenuButton', () => {
  it('is the more button, named by its title, saying it opens a menu', () => {
    const button = mount(MenuButton, { props: { items, title: 'More for alpha' } })
    expect(button.get('button').attributes()).toMatchObject({
      title: 'More for alpha',
      'aria-label': 'More for alpha',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false'
    })
  })

  it('opens its menu in <body>, with the first item focused', async () => {
    const button = mount(MenuButton, { props: { items, title: 'More' }, attachTo: document.body })
    await button.get('button').trigger('click')
    await flushPromises()
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull()
    expect(document.activeElement?.textContent).toBe('Remove mine…')
    expect(button.get('button').attributes('aria-expanded')).toBe('true')
    button.unmount()
  })

  it('closes on a pick, hands the pick on, and gives the focus back to the button', async () => {
    const button = mount(MenuButton, { props: { items, title: 'More' }, attachTo: document.body })
    await button.get('button').trigger('click')
    await flushPromises()
    ;(document.body.querySelector('[role="menuitem"]') as HTMLElement).click()
    await flushPromises()
    expect(button.emitted('pick')).toEqual([[0]])
    expect(document.body.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(button.get('button').element)
    button.unmount()
  })

  it('closes when the button is pressed again while its menu is open', async () => {
    const button = mount(MenuButton, { props: { items, title: 'More' }, attachTo: document.body })
    await button.get('button').trigger('click')
    await flushPromises()
    await button.get('button').trigger('click')
    await flushPromises()
    expect(document.body.querySelector('[role="menu"]')).toBeNull()
    button.unmount()
  })

  it('closes on a press outside it', async () => {
    const button = mount(MenuButton, { props: { items, title: 'More' }, attachTo: document.body })
    await button.get('button').trigger('click')
    await flushPromises()
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await flushPromises()
    expect(document.body.querySelector('[role="menu"]')).toBeNull()
    button.unmount()
  })
})

// ADDED for #635 (PR2 live fixes): the menu stays hidden until it is placed, and a hidden element
// takes no focus in a real browser, so the first item must be focused only once it shows; and the
// keys work wherever the focus is, the item, the plate or the button itself.
describe('MenuButton keyboard', () => {
  async function opened() {
    const button = mount(MenuButton, {
      props: { items: [{ label: 'Open console' }, { separator: true }, ...items], title: 'More' },
      attachTo: document.body
    })
    await button.get('button').trigger('click')
    await flushPromises()
    return button
  }
  const press = (target: EventTarget, key: string) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))

  it('focuses the first item only once the menu is visible', async () => {
    const seen: string[] = []
    const record = (event: FocusEvent) => {
      const float = (event.target as HTMLElement).closest<HTMLElement>('.dm-menu-float')
      if (float) seen.push(float.style.visibility)
    }
    document.addEventListener('focusin', record, true)
    const button = await opened()
    document.removeEventListener('focusin', record, true)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((v) => v !== 'hidden')).toBe(true)
    button.unmount()
  })

  it('closes on Esc pressed on the button, and keeps the focus there', async () => {
    const button = await opened()
    const trigger = button.get('button').element
    trigger.focus()
    press(trigger, 'Escape')
    await flushPromises()
    expect(document.body.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    button.unmount()
  })

  it('moves into the menu from the button with the arrows', async () => {
    const button = await opened()
    const trigger = button.get('button').element
    trigger.focus()
    press(trigger, 'ArrowDown')
    expect(document.activeElement?.textContent).toBe('Open console')
    trigger.focus()
    press(trigger, 'ArrowUp')
    expect(document.activeElement?.textContent).toBe('Remove mine…')
    button.unmount()
  })

  it('closes on Esc from inside the menu and gives the focus back to the button', async () => {
    const button = await opened()
    const plate = document.body.querySelector<HTMLElement>('[role="menu"]')!
    press(plate, 'Escape')
    await flushPromises()
    expect(document.body.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(button.get('button').element)
    button.unmount()
  })

  it('walks the items with ArrowDown, End and Home, skipping the rule', async () => {
    const button = await opened()
    const first = document.activeElement!
    press(first, 'ArrowDown')
    expect(document.activeElement?.textContent).toBe('Remove mine…')
    press(document.activeElement!, 'Home')
    expect(document.activeElement?.textContent).toBe('Open console')
    press(document.activeElement!, 'End')
    expect(document.activeElement?.textContent).toBe('Remove mine…')
    button.unmount()
  })
})
