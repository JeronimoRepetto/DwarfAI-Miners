// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ValleTopBar from './ValleTopBar.vue'

/*
 * Valle's top bar (ISSUE-300; US-VALLE-001.AC05; 07 S28.21): "▼ Panel" and "▼ Veta" leave Valle for that mode as the
 * Panel's lever does (US-SHELL-001), A-N13 `moveToMode` carrying the chat in focus, if any (machine 9).
 */

const MINE = '018f3a2e-7c4b-7d1e-9a5b-2f6c8d0e1a11'
const DWARF = '018f3a2e-7c4b-7d1e-9a5b-2f6c8d0e1a21'

describe('the Valle top bar (ISSUE-300)', () => {
  it('[US-VALLE-001.AC05, S28.21] ▼ Panel and ▼ Veta leave Valle for that mode carrying the chat in focus', async () => {
    const bar = mount(ValleTopBar, {
      props: { preset: 'front', chat: { mineId: MINE, dwarfId: DWARF } }
    })
    const lever = (text: string) => bar.findAll('button').find((b) => b.text() === text)!
    expect(lever('▼ Panel').attributes('title')).toBe('Back to the Panel')
    expect(lever('▼ Veta').attributes('title')).toBe('Fold into Veta')

    await lever('▼ Panel').trigger('click')
    await lever('▼ Veta').trigger('click')
    // No chat in focus: the mode alone.
    await bar.setProps({ chat: null })
    await lever('▼ Veta').trigger('click')

    expect(bar.emitted('leave')).toEqual([
      [{ mode: 'panel', mineId: MINE, dwarfId: DWARF }],
      [{ mode: 'veta', mineId: MINE, dwarfId: DWARF }],
      [{ mode: 'veta' }]
    ])
    bar.unmount()
  })
})

// APPENDED for the Valle visual parity (EPIC-20): the app mark leads the top bar (`DS` organisms/valle-bar, "Hide Valle"),
// and hides the window as the app mark does in every mode (07 S10.08), a mode move to `hidden`.
describe("the Valle top bar's app mark (EPIC-20 visual parity)", () => {
  it('[US-SHELL-002.AC01, US-SHELL-001.AC05] the app mark leads the bar, named Hide Valle, and asks for the hidden mode', async () => {
    const bar = mount(ValleTopBar, { props: { preset: 'control', chat: null } })
    const mark = bar.get('header.dm-vbar > button.dm-vbar__mark')
    expect(bar.get('header.dm-vbar').element.firstElementChild).toBe(mark.element)
    expect(mark.attributes('title')).toBe('Hide Valle')
    expect(mark.attributes('aria-label')).toBe('Hide Valle')
    await mark.trigger('click')
    expect(bar.emitted('leave')).toEqual([[{ mode: 'hidden' }]])
    bar.unmount()
  })
})
