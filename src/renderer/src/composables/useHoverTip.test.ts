// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { TIP_DELAY_MS } from '../lib/overlay/tipCard'
import { useHoverTip } from './useHoverTip'

/*
 * The hover tooltip every card-bearing target shares (components.md, Tooltip card; Dwarf tooltip,
 * Accessibility): 300ms after the pointer arrives, at once on keyboard focus, gone on leave, blur,
 * press or Esc, and a press keeps it away until the pointer leaves (#654).
 */
function harness() {
  let api!: ReturnType<typeof useHoverTip<string>>
  const wrapper = mount(
    defineComponent({
      setup() {
        api = useHoverTip<string>()
        return () => h('button', { id: 'target' })
      }
    }),
    { attachTo: document.body }
  )
  const target = wrapper.find('#target').element as HTMLElement
  const pointer = { currentTarget: target } as unknown as PointerEvent
  const focus = { currentTarget: target } as unknown as FocusEvent
  return { api, wrapper, pointer, focus }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('useHoverTip', () => {
  it('shows 300ms after the pointer arrives, not before', () => {
    const { api, pointer } = harness()
    api.hover('d1', pointer)
    vi.advanceTimersByTime(TIP_DELAY_MS - 1)
    expect(api.shown.value).toBeNull()
    vi.advanceTimersByTime(1)
    expect(api.shown.value).toBe('d1')
  })

  it('shows at once on keyboard focus', () => {
    const { api, focus } = harness()
    api.focus('d1', focus)
    expect(api.shown.value).toBe('d1')
  })

  it('goes on leave and on blur, and never shows a hover that left before its delay', () => {
    const { api, pointer, focus } = harness()
    api.hover('d1', pointer)
    api.leave()
    vi.advanceTimersByTime(TIP_DELAY_MS)
    expect(api.shown.value).toBeNull()
    api.focus('d1', focus)
    api.hide()
    expect(api.shown.value).toBeNull()
  })

  it('goes on Esc', () => {
    const { api, focus } = harness()
    api.focus('d1', focus)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(api.shown.value).toBeNull()
  })

  it('stays away after a press until the pointer leaves', () => {
    const { api, pointer, focus } = harness()
    api.hover('d1', pointer)
    api.press()
    vi.advanceTimersByTime(TIP_DELAY_MS)
    expect(api.shown.value).toBeNull()
    api.focus('d1', focus)
    expect(api.shown.value).toBeNull()
    api.leave()
    api.hover('d1', pointer)
    vi.advanceTimersByTime(TIP_DELAY_MS)
    expect(api.shown.value).toBe('d1')
  })

  it('lets go of Esc and its timer when its owner unmounts', () => {
    const { api, wrapper, pointer } = harness()
    const removed = vi.spyOn(window, 'removeEventListener')
    api.hover('d1', pointer)
    wrapper.unmount()
    expect(removed).toHaveBeenCalledWith('keydown', expect.any(Function))
    vi.advanceTimersByTime(TIP_DELAY_MS)
    expect(api.shown.value).toBeNull()
  })
})
