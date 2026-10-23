// @vitest-environment jsdom
import type { DwarfId } from '@dwarfai/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { focusChatIn } from './chatFocus'

/*
 * Owner ruling 2026-10-23 (VQA-13; `DS` valle.js `answer` → `focusInput`): after a needs-you jump the keyboard goes into
 * the dwarf's chat, to the place `DS/docs/accessibility.md` (Focus) names: the question card's first option while the
 * dwarf waits on you, else the composer's field. Never into a motion ghost's copy of the chat.
 */
const BORIN = '01920000-0000-7000-8000-00000000d001' as DwarfId
const DAIN = '01920000-0000-7000-8000-00000000d002' as DwarfId

function draw(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.append(root)
  return root
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('the keyboard handed to a jumped-to chat', () => {
  it('[US-VALLE-004.AC01, US-VALLE-012.AC02, S34.05, S34.07] lands on the question card first option while the dwarf waits, else the composer, and only in that dwarf chat once it is drawn', () => {
    const root = draw(`
      <div class="dm-vghosts"><section data-valle-chat="${BORIN}"><div class="dm-qcard"><button class="dm-qopt">ghost</button></div></section></div>
      <section data-valle-chat="${DAIN}"><textarea data-dain></textarea></section>
      <section data-valle-chat="${BORIN}"><textarea></textarea><div class="dm-qcard"><button class="dm-qopt" data-first>Yes</button><button class="dm-qopt">No</button></div></section>
    `)
    expect(focusChatIn(root, BORIN)).toBe(true)
    expect(document.activeElement?.hasAttribute('data-first')).toBe(true)
    // No card: the composer's field.
    expect(focusChatIn(root, DAIN)).toBe(true)
    expect(document.activeElement?.hasAttribute('data-dain')).toBe(true)
    // A chat not drawn yet: false, the keyboard left where it was.
    const NALI = '01920000-0000-7000-8000-00000000d003' as DwarfId
    expect(focusChatIn(root, NALI)).toBe(false)
    expect(document.activeElement?.hasAttribute('data-dain')).toBe(true)
  })
})
