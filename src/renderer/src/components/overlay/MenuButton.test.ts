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
