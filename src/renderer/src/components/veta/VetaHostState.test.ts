// @vitest-environment jsdom
import type { HostConnectionView } from '@dwarfai/contracts'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeWindowApi } from '../../../../contracts/ipc/testing/fakeWindowApi'
import { useHostConnection } from '../../composables/useHostConnection'
import VetaHostState from './VetaHostState.vue'

/*
 * ISSUE-296 (TC-296-03; ADR-002 D9; UC-067; 07 §12B): the one Host-state message hosted inside the Veta window, the
 * Panel's own HostStateMessage unchanged, over the generated fake `window.api` scripting A-N03 and A-N04. The window
 * grows for it before it shows (`room`) and gets its room back once it has gone; nothing ever moves to the Panel.
 */

afterEach(() => {
  useHostConnection().stop()
  document.body.innerHTML = ''
  delete (window as unknown as { api?: unknown }).api
})

describe('VetaHostState', () => {
  it('[ADR-002] a crash loop shows one message in Veta whose Retry is reachable by pointer and by keyboard and calls retryHostConnection; the mode stays Veta', async () => {
    let push: (view: HostConnectionView) => void = () => undefined
    const retries = vi.fn()
    const moves = vi.fn()
    const stops = vi.fn()
    ;(window as unknown as { api: unknown }).api = createFakeWindowApi({
      getHostConnection: () => Promise.resolve({ state: 'connected' }) as never,
      onHostConnection: (listener) => {
        push = listener as (view: HostConnectionView) => void
        return () => undefined
      },
      retryHostConnection: () => {
        retries()
        return Promise.resolve({ ok: true, value: undefined }) as never
      },
      moveToMode: (params) => {
        moves(params)
        return Promise.resolve({ ok: true, value: undefined }) as never
      },
      requestStopEverything: () => {
        stops()
      }
    })
    const rooms: boolean[] = []
    const wrapper = mount(VetaHostState, {
      props: {
        room: (open: boolean) => {
          rooms.push(open)
          return Promise.resolve()
        }
      },
      attachTo: document.body
    })
    await flushPromises()
    expect(document.querySelectorAll('.dm-host-state')).toHaveLength(0)

    // Reconnecting holds the strip with no message and no room asked for (S12.B04).
    push({ state: 'reconnecting', since: 1 })
    await flushPromises()
    expect(document.querySelectorAll('.dm-host-state')).toHaveLength(0)
    expect(rooms).toEqual([])

    // The third crash in five minutes: the window grows, then ONE message shows in it.
    push({ state: 'unavailable', reason: 'crash-loop' })
    await flushPromises()
    expect(rooms).toEqual([true])
    const messages = document.querySelectorAll<HTMLElement>('.dm-host-state')
    expect(messages).toHaveLength(1)
    expect(messages[0]!.dataset.variant).toBe('crash-loop')
    expect(messages[0]!.getAttribute('role')).toBe('alert')
    const buttons = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
    expect(buttons).toHaveLength(1)
    const retry = buttons[0]!
    expect(retry.textContent?.trim()).toBe('Try again')

    // By keyboard: the dialog hands its one action the focus, and Tab keeps it there.
    expect(document.activeElement).toBe(retry)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(document.activeElement).toBe(retry)
    expect(retry.disabled).toBe(false)

    // By pointer: Retry asks UI main (A-N05), once.
    retry.click()
    await flushPromises()
    expect(retries).toHaveBeenCalledOnce()

    // The mode stays Veta: nothing asked to move to the Panel, and no Stop everything.
    expect(moves).not.toHaveBeenCalled()
    expect(stops).not.toHaveBeenCalled()

    // The Host is reached again: the message goes, then the room is given back.
    push({ state: 'connected' })
    await flushPromises()
    expect(document.querySelectorAll('.dm-host-state')).toHaveLength(0)
    expect(rooms).toEqual([true, false])
    wrapper.unmount()
  })
})
