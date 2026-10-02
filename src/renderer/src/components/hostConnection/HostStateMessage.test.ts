// @vitest-environment jsdom
import type { HostConnectionView } from '@dwarfai/contracts'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hostStateMessage } from '../../lib/hostConnection/hostStateMessage'
import HostStateMessage from './HostStateMessage.vue'

/*
 * The one Host-state message over the Panel (ADR-002 D9; 07 §12B): its text, its one action, its accessible name and
 * its live-region politeness. Never a toast and never an OS notification.
 */
const unavailable = (reason: NonNullable<HostConnectionView['reason']>) =>
  hostStateMessage({ state: 'unavailable', reason })

describe('HostStateMessage', () => {
  // AMENDED for the owner's design ruling of 2026-10-02 (was: the region, its text and its Retry found inside the
  // component's own element): a message with an action is now the design's dialog, rendered in <body>, so it is
  // read from the document and unmounted at the end; the expectations themselves are unchanged.
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('[ADR-002, S12.B06] shows the crash-loop message with one Retry and announces it at once', async () => {
    const wrapper = mount(HostStateMessage, {
      props: { message: unavailable('crash-loop') },
      attachTo: document.body
    })
    await flushPromises()
    const region = document.body.querySelector('[role="alert"]')!
    expect(region.getAttribute('aria-live')).toBe('assertive')
    expect(region.textContent).toContain('⟦COPY NEEDED: O-15 crash-loop variant⟧')
    const buttons = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
    expect(buttons).toHaveLength(1)
    expect(buttons[0]!.textContent?.trim()).toBe('⟦COPY NEEDED: O-5 Host-state Retry action⟧')
    buttons[0]!.click()
    expect(wrapper.emitted('retry')).toHaveLength(1)
    wrapper.unmount()
  })

  it('[ADR-002, S12.B11] a Retry in flight cannot be pressed again', async () => {
    const wrapper = mount(HostStateMessage, {
      props: { message: unavailable('unresponsive'), retrying: true },
      attachTo: document.body
    })
    await flushPromises()
    expect(document.body.querySelector('button')?.hasAttribute('disabled')).toBe(true)
    wrapper.unmount()
  })

  // AMENDED for the owner's ruling of 2026-10-02 (was: a polite inline status region): reconnecting is announced by its
  // one toast, which ToastHost's polite region reads (useHostConnection); the component draws nothing and no action.
  it('[ADR-002] reconnecting is announced politely and offers no action', () => {
    const wrapper = mount(HostStateMessage, {
      props: { message: hostStateMessage({ state: 'reconnecting', since: 1 }) }
    })
    expect(wrapper.find('[role="status"]').exists()).toBe(false)
    expect(wrapper.findAll('button')).toHaveLength(0)
  })

  it('[ADR-002] incompatible offers only Stop everything and quit, and only where it can be done', async () => {
    const stop = vi.fn()
    const offered = mount(HostStateMessage, {
      props: { message: unavailable('incompatible'), onStopEverything: stop },
      attachTo: document.body
    })
    await flushPromises()
    const buttons = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
    expect(buttons).toHaveLength(1)
    expect(buttons[0]!.textContent?.trim()).toBe(
      '⟦COPY NEEDED: O-3 Stop everything and quit action⟧'
    )
    buttons[0]!.click()
    expect(stop).toHaveBeenCalledOnce()
    expect(offered.emitted('retry')).toBeUndefined()
    offered.unmount()
    // Hidden until built (21 §1 item 8): with nothing to run it, the action is absent, never a dead button.
    const unwired = mount(HostStateMessage, { props: { message: unavailable('incompatible') } })
    // AMENDED for the owner's ruling of 2026-10-02 (was: the inline text with no button): no Host-state banner is left,
    // so an action that cannot run here draws nothing; in the app the action is always wired (App.vue).
    expect(unwired.findAll('button')).toHaveLength(0)
    expect(unwired.text()).toBe('')
  })

  it('[ADR-002] connected shows nothing', () => {
    const wrapper = mount(HostStateMessage, {
      props: {
        message: hostStateMessage({
          state: 'connected',
          hostVersion: '1.0.0',
          compat: false
        })
      }
    })
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.find('[role="status"]').exists()).toBe(false)
    expect(wrapper.text()).toBe('')
  })
})

/*
 * Owner's design ruling (2026-10-02): a Host-state message that carries an action is the design's dialog, the same
 * `molecules/dialog` as the remove-mine popup (MinesList) and ISSUE-317's confirmation: role dialog, aria-modal, named
 * by its title, the message in its body, the action in its actions row holding the focus, Tab trapped. A message
 * without an action stays the inline notice above.
 */
describe('HostStateMessage as the design dialog', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  const press = (key: string, shiftKey = false): void => {
    ;(document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent('keydown', { key, shiftKey, bubbles: true })
    )
  }

  const dialog = (): HTMLElement | null => document.body.querySelector('[role="dialog"]')

  async function shown(props: InstanceType<typeof HostStateMessage>['$props']) {
    const wrapper = mount(HostStateMessage, { props, attachTo: document.body })
    await flushPromises()
    return wrapper
  }

  it.each([
    ['spawn-failed', '⟦COPY NEEDED: O-5 Host did not start message⟧'],
    ['crash-loop', '⟦COPY NEEDED: O-15 crash-loop variant⟧'],
    ['unresponsive', '⟦COPY NEEDED: O-5 Host-unresponsive message⟧']
  ] as const)(
    '[ADR-002, S12.B06] %s with its Retry is the design dialog: modal, named by its title, the message in its body, Retry holding the focus',
    async (reason, text) => {
      const wrapper = await shown({ message: unavailable(reason) })
      const card = dialog()
      expect(card, 'the message is a dialog').not.toBeNull()
      expect(card!.classList.contains('dm-dialog')).toBe(true)
      expect(card!.classList.contains('dm-dialog--danger')).toBe(true)
      expect(card!.getAttribute('aria-modal')).toBe('true')
      expect(card!.getAttribute('aria-label')).toMatch(/^⟦COPY NEEDED: .+ dialog title⟧$/)
      expect(card!.querySelector('.dm-dialog__title')?.textContent).toBe(
        card!.getAttribute('aria-label')
      )
      const body = card!.querySelector('.dm-dialog__body .dm-host-state')
      expect(body?.getAttribute('data-variant')).toBe(reason)
      expect(body?.getAttribute('role')).toBe('alert')
      expect(body?.textContent).toContain(text)
      const actions = [...card!.querySelectorAll<HTMLButtonElement>('.dm-dialog__actions button')]
      expect(actions.map((button) => button.textContent?.trim())).toEqual([
        '⟦COPY NEEDED: O-5 Host-state Retry action⟧'
      ])
      expect(document.activeElement).toBe(actions[0])
      actions[0]!.click()
      expect(wrapper.emitted('retry')).toHaveLength(1)
      wrapper.unmount()
    }
  )

  it('[NFR-A11Y-03, ADR-002] Esc leaves the Host-state dialog open, and Tab stays on its one action', async () => {
    const wrapper = await shown({ message: unavailable('crash-loop') })
    const retry = document.body.querySelector<HTMLButtonElement>('.dm-dialog__actions button')
    press('Escape')
    await flushPromises()
    expect(
      dialog(),
      'the board is read-only while the Host is down: nothing to go back to'
    ).not.toBeNull()
    expect(wrapper.emitted('retry')).toBeUndefined()
    press('Tab')
    expect(document.activeElement).toBe(retry)
    wrapper.unmount()
  })

  it('[ADR-002] incompatible is the design dialog with Stop everything and quit as its one danger action', async () => {
    const stop = vi.fn()
    const wrapper = await shown({ message: unavailable('incompatible'), onStopEverything: stop })
    const actions = [...document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
    expect(actions.map((button) => button.textContent?.trim())).toEqual([
      '⟦COPY NEEDED: O-3 Stop everything and quit action⟧'
    ])
    actions[0]!.click()
    expect(stop).toHaveBeenCalledOnce()
    wrapper.unmount()
  })

  it('[ADR-002] the Host-state dialog steps aside while another dialog holds the window, and comes back after it', async () => {
    const wrapper = await shown({ message: unavailable('spawn-failed'), covered: true })
    expect(dialog()).toBeNull()
    await wrapper.setProps({ covered: false })
    await flushPromises()
    expect(dialog()?.querySelector('.dm-host-state')?.getAttribute('data-variant')).toBe(
      'spawn-failed'
    )
    wrapper.unmount()
  })
})

/*
 * Owner's ruling (2026-10-02): a Host-state notice without an action is a toast (useHostConnection raises it), so the
 * component draws no banner for it, and nothing of it can sit over the Panel's header.
 */
describe('HostStateMessage without an action', () => {
  it.each([
    ['reconnecting', hostStateMessage({ state: 'reconnecting', since: 1 })],
    ['elevated-refused', unavailable('elevated-refused')],
    ['unavailable in-job', unavailable('in-job')],
    [
      'connected in-job',
      hostStateMessage({
        state: 'connected',
        hostVersion: '1.0.0',
        compat: false,
        jobStatus: 'in-job'
      })
    ]
  ] as const)('[ADR-002, FM-012] %s renders no banner and no dialog', (_name, message) => {
    const wrapper = mount(HostStateMessage, { props: { message }, attachTo: document.body })
    expect(document.body.querySelector('.dm-host-state')).toBeNull()
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(wrapper.text()).toBe('')
    wrapper.unmount()
  })
})
