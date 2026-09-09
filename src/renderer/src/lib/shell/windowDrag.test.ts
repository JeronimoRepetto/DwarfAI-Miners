// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { WINDOW_DRAG_ATTRIBUTE, isWindowDragTarget } from './windowDrag'

/**
 * The header row of either panel, as the two components mark it (#296) — a
 * title, a control beside it, and the interactive resize handle above.
 */
function panel(): HTMLElement {
  const surface = document.createElement('div')
  surface.innerHTML = `
    <div class="panel-resize" role="separator"></div>
    <header class="panel-bar" ${WINDOW_DRAG_ATTRIBUTE}>
      <button class="panel-agent" type="button">Dwarf</button>
      <span class="panel-title">Dwarf</span>
    </header>
    <div class="panel-conversation">
      <p>a message</p>
      <textarea></textarea>
    </div>
  `
  return surface
}

function pick(surface: HTMLElement, selector: string): Element {
  const found = surface.querySelector(selector)
  if (found === null) throw new Error(`no ${selector} in the fixture`)
  return found
}

describe('isWindowDragTarget', () => {
  it('accepts the marked header row itself', () => {
    expect(isWindowDragTarget(pick(panel(), 'header'))).toBe(true)
  })

  it('accepts inert text inside the header, which is most of what it is', () => {
    expect(isWindowDragTarget(pick(panel(), '.panel-title'))).toBe(true)
  })

  it('refuses a control inside the header, which has its own job', () => {
    // The name focuses the session's console and the glyph closes the panel;
    // a drag that swallowed either would take a control away from the person.
    expect(isWindowDragTarget(pick(panel(), 'button'))).toBe(false)
  })

  it('refuses everything outside the header', () => {
    const surface = panel()
    expect(isWindowDragTarget(pick(surface, '.panel-conversation'))).toBe(false)
    expect(isWindowDragTarget(pick(surface, 'textarea'))).toBe(false)
    // The vertical-only resize handle lives ABOVE the header and is a drag of
    // its own; the window must never move because somebody resized it.
    expect(isWindowDragTarget(pick(surface, '.panel-resize'))).toBe(false)
  })

  it('refuses a press that landed on nothing at all', () => {
    expect(isWindowDragTarget(null)).toBe(false)
    expect(isWindowDragTarget(document.createTextNode('loose text'))).toBe(false)
  })
})
