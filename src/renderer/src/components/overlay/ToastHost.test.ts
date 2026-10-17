// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { afterEach, beforeEach, vi } from 'vitest'
import { useToasts } from '../../composables/useToasts'
import ToastHost from './ToastHost.vue'
import hostSource from './ToastHost.vue?raw'

/** The declarations of the scoped rule for exactly `selector`, comments stripped. */
function rule(selector: string): Map<string, string> {
  const style = hostSource
    .slice(hostSource.indexOf('>', hostSource.indexOf('<style')) + 1)
    .replace(/\/\*[\s\S]*?\*\//g, '')
  const found = [...style.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(
    (one) => one[1]!.trim() === selector
  )
  if (found === undefined) throw new Error(`no ${selector} rule in ToastHost.vue`)
  return new Map(
    found[2]!
      .split(';')
      .map((declaration) => declaration.split(':').map((part) => part.trim()))
      .filter(([name]) => name)
      .map(([name, value]) => [name!, value!])
  )
}

/*
 * #635, PANEL-QUESTIONS 10 (PO ruling 2026-09-27): in the app a toast is centred on the page
 * column, 56px from its bottom, whatever raised it. The host stands inside that column, which is
 * its containing block; the window-wide host of the old UI is not in the design and is gone.
 */
describe('ToastHost placement', () => {
  it('stands in its column, centred and 56px from its bottom, never fixed to the window', () => {
    expect(mount(ToastHost).classes()).toEqual(['dm-toasts'])
    const host = rule('.dm-toasts')
    expect(host.get('position')).toBe('absolute')
    expect(host.get('left')).toBe('50%')
    expect(host.get('bottom')).toBe('56px')
    expect(host.get('transform')).toBe('translateX(-50%)')
  })
})

/*
 * APPENDED for ISSUE-263: one toast contract, whatever raised it (BR-23, NFR-TIM-03; motion.md,
 * Overlays, d12d3fc: a toast rises 6px in over --dur-base, holds 2.6s, leaves 4px down over
 * --dur-fast). jsdom runs no transition, so the motion is read from the host's rules and the tokens
 * they name, and the timing from the queue under fake timers.
 */
describe('ToastHost, one toast contract (ISSUE-263)', () => {
  const tokens = readFileSync(join(import.meta.dirname, '../../assets/design-tokens.css'), 'utf8')
  /** A token's value outside reduced motion: its first declaration, in `:root`. */
  const token = (name: string): string | undefined =>
    tokens.match(new RegExp(`${name}: ([^;]+);`))?.[1]
  const resolve = (value: string | undefined): string =>
    (value ?? '')
      .replace(/var\((--[\w-]+)\)/g, (_, name: string) => token(name) ?? name)
      .replace(/\s+/g, ' ')

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.runAllTimers()
    vi.useRealTimers()
  })

  const shown = (host: ReturnType<typeof mount>): string[] =>
    host.findAll('.dm-toast').map((card) => card.text())

  it('[US-SHELL-012.AC01, US-SHELL-012.AC02, US-SHELL-012.AC03, NFR-TIM-03, BR-23] a toast is centred on the page column 56 px from the bottom, rises 6 px over 140 ms, holds 2.6 s and leaves 4 px down over 90 ms', async () => {
    const host = rule('.dm-toasts')
    expect([
      host.get('position'),
      host.get('left'),
      host.get('bottom'),
      host.get('transform')
    ]).toEqual(['absolute', '50%', '56px', 'translateX(-50%)'])
    expect(resolve(rule('.dm-toast-pop-enter-from').get('transform'))).toBe('translateY(6px)')
    expect(rule('.dm-toast-pop-enter-from').get('opacity')).toBe('0')
    expect(resolve(rule('.dm-toast-pop-enter-active').get('transition'))).toBe(
      'transform 140ms cubic-bezier(0.2, 0.7, 0.1, 1), opacity 140ms cubic-bezier(0.2, 0.7, 0.1, 1)'
    )
    expect(rule('.dm-toast-pop-leave-to').get('transform')).toBe('translateY(4px)')
    expect(rule('.dm-toast-pop-leave-to').get('opacity')).toBe('0')
    expect(resolve(rule('.dm-toast-pop-leave-active').get('transition'))).toBe(
      'transform 90ms cubic-bezier(0.5, 0, 0.9, 0.3), opacity 90ms cubic-bezier(0.5, 0, 0.9, 0.3)'
    )

    const wrapper = mount(ToastHost)
    useToasts().showToast('Sorted by name')
    await wrapper.vm.$nextTick()
    expect(shown(wrapper)).toEqual(['Sorted by name'])
    vi.advanceTimersByTime(2599)
    await wrapper.vm.$nextTick()
    expect(shown(wrapper)).toEqual(['Sorted by name'])
    vi.advanceTimersByTime(1)
    await wrapper.vm.$nextTick()
    expect(shown(wrapper)).toEqual([])
  })

  it('[US-SHELL-012.AC04] a second toast stacks 8 px apart and the first keeps its own remaining time', async () => {
    const host = rule('.dm-toasts')
    expect([host.get('display'), host.get('gap')]).toEqual(['grid', '8px'])

    const wrapper = mount(ToastHost)
    const { showToast } = useToasts()
    showToast('first')
    vi.advanceTimersByTime(1000)
    showToast('second')
    await wrapper.vm.$nextTick()
    expect(shown(wrapper)).toEqual(['first', 'second'])
    // The first leaves 2.6 s after it was raised, not after the second.
    vi.advanceTimersByTime(1599)
    await wrapper.vm.$nextTick()
    expect(shown(wrapper)).toEqual(['first', 'second'])
    vi.advanceTimersByTime(1)
    await wrapper.vm.$nextTick()
    expect(shown(wrapper)).toEqual(['second'])
    vi.advanceTimersByTime(999)
    await wrapper.vm.$nextTick()
    expect(shown(wrapper)).toEqual(['second'])
    vi.advanceTimersByTime(1)
    await wrapper.vm.$nextTick()
    expect(shown(wrapper)).toEqual([])
  })

  /*
   * The two Host toasts (B-F28 `toast {kind: 'session-crashed' | 'provider-error'}`) have no seam A
   * route to the window yet (later work), so they are raised here as any surface raises a toast,
   * with their stories' copy. The queue takes a line and an icon and nothing else: there is no
   * per-kind or per-mode path for either to take, and both land in the same host on the same clock.
   */
  it('[US-RES-001.AC05, US-RES-004.AC05, BR-23] the crash toast and the provider-error toast follow the same toast rules', async () => {
    const wrapper = mount(ToastHost)
    const { showToast } = useToasts()
    const crash = 'dwarfai-53 stopped unexpectedly'
    const providerError = 'Something went wrong with dwarfai-53 · Claude'
    showToast('Sorted by name')
    vi.advanceTimersByTime(500)
    showToast(crash)
    vi.advanceTimersByTime(500)
    showToast(providerError)
    await wrapper.vm.$nextTick()
    // Stacked in the one host, in the order raised, each the same card.
    expect(wrapper.classes()).toEqual(['dm-toasts'])
    expect(shown(wrapper)).toEqual(['Sorted by name', crash, providerError])
    expect(new Set(wrapper.findAll('.dm-toast').map((card) => card.classes().join(' '))).size).toBe(
      1
    )
    // Each leaves 2.6 s after it was raised: at 2600, 3100 and 3600 ms.
    for (const [wait, gone] of [
      [1599, 'Sorted by name'],
      [499, crash],
      [499, providerError]
    ] as const) {
      vi.advanceTimersByTime(wait)
      await wrapper.vm.$nextTick()
      expect(shown(wrapper)).toContain(gone)
      vi.advanceTimersByTime(1)
      await wrapper.vm.$nextTick()
      expect(shown(wrapper)).not.toContain(gone)
    }
  })
})
