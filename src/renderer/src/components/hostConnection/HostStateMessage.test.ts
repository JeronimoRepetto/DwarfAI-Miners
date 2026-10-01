// @vitest-environment jsdom
import type { HostConnectionView } from '@dwarfai/contracts'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { hostStateMessage } from '../../lib/hostConnection/hostStateMessage'
import HostStateMessage from './HostStateMessage.vue'

/*
 * The one Host-state message over the Panel (ADR-002 D9; 07 §12B): its text, its one action, its accessible name and
 * its live-region politeness. Never a toast and never an OS notification.
 */
const unavailable = (reason: NonNullable<HostConnectionView['reason']>) =>
  hostStateMessage({ state: 'unavailable', reason })

describe('HostStateMessage', () => {
  it('[ADR-002, S12.B06] shows the crash-loop message with one Retry and announces it at once', async () => {
    const wrapper = mount(HostStateMessage, { props: { message: unavailable('crash-loop') } })
    const region = wrapper.get('[role="alert"]')
    expect(region.attributes('aria-live')).toBe('assertive')
    expect(region.text()).toContain('⟦COPY NEEDED: O-15 crash-loop variant⟧')
    const buttons = wrapper.findAll('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]!.text()).toBe('⟦COPY NEEDED: O-5 Host-state Retry action⟧')
    await buttons[0]!.trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })

  it('[ADR-002, S12.B11] a Retry in flight cannot be pressed again', () => {
    const wrapper = mount(HostStateMessage, {
      props: { message: unavailable('unresponsive'), retrying: true }
    })
    expect(wrapper.get('button').attributes('disabled')).toBeDefined()
  })

  it('[ADR-002] reconnecting is announced politely and offers no action', () => {
    const wrapper = mount(HostStateMessage, {
      props: { message: hostStateMessage({ state: 'reconnecting', since: 1 }) }
    })
    expect(wrapper.get('[role="status"]').attributes('aria-live')).toBe('polite')
    expect(wrapper.findAll('button')).toHaveLength(0)
  })

  it('[ADR-002] incompatible offers only Stop everything and quit, and only where it can be done', async () => {
    const stop = vi.fn()
    const offered = mount(HostStateMessage, {
      props: { message: unavailable('incompatible'), onStopEverything: stop }
    })
    const buttons = offered.findAll('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]!.text()).toBe('⟦COPY NEEDED: O-3 Stop everything and quit action⟧')
    await buttons[0]!.trigger('click')
    expect(stop).toHaveBeenCalledOnce()
    expect(offered.emitted('retry')).toBeUndefined()
    // Hidden until built (21 §1 item 8): with nothing to run it, the action is absent, never a dead button.
    const unwired = mount(HostStateMessage, { props: { message: unavailable('incompatible') } })
    expect(unwired.findAll('button')).toHaveLength(0)
    expect(unwired.text()).toContain('⟦COPY NEEDED: O-5 incompatible Host message⟧')
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
