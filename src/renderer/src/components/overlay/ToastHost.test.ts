// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
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
