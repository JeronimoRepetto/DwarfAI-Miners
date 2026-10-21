// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import type { UiSfx } from '../../lib/audio/volume'
import { CLOSED_GRIP_MENU, gripMenuEntries, stepGripMenu } from '../../lib/veta/gripMenu'
import {
  BORIN,
  MORIA,
  dwarfWire,
  mineWire,
  type VetaSnapshotData
} from '../../lib/veta/testing/vetaFixtures'
import VetaGripMenu from './VetaGripMenu.vue'
import { mountVeta, shownOverlay, type VetaWorld } from './testing/mountVeta'

/*
 * ISSUE-288 (TC-288-01, TC-288-04): the grip menu (US-VETA-003; DS/docs/screens/veta.md, the grip menu) alone and
 * inside the Veta root, over the generated fake `window.api`; a recording sound engine stands in for the one that
 * plays the attention cues and the interface click.
 */

const WORKING: VetaSnapshotData = {
  minesEverKnown: true,
  mines: [mineWire(MORIA)],
  dwarfs: [dwarfWire(BORIN, MORIA)]
}

/** The part of the sound engine the cues go through (lib/audio/engine `AudioEngine.playSfx`), recording what plays. */
class RecordingSoundEngine {
  readonly played: UiSfx[] = []
  playSfx(kind: UiSfx): void {
    this.played.push(kind)
  }
}

let world: VetaWorld | undefined
afterEach(() => {
  world?.unmount()
  world = undefined
  document.body.innerHTML = ''
})

describe('the grip menu', () => {
  it('[US-VETA-003.AC08, NFR-SND-03, S22.19] with the menu open an attention cue and the interface click still play, and no mute item exists', async () => {
    const menu = mount(VetaGripMenu, {
      attachTo: document.body,
      props: { entries: gripMenuEntries(['panel', 'veta', 'valle']) }
    })
    await flushPromises()
    const labels = menu.findAll('[role="menuitem"]').map((item) => item.text())
    expect(labels).toEqual(['Open Panel', 'Open Valle', 'New dwarf in…▸', 'Hide window'])
    expect(labels.some((label) => /mute|sound/i.test(label))).toBe(false)
    // The cues play through the engine whatever the menu shows: nothing in the menu reaches them.
    const sound = new RecordingSoundEngine()
    const open = stepGripMenu(
      CLOSED_GRIP_MENU,
      { type: 'grip-open' },
      { liveMines: 1, built: ['panel'] }
    )
    sound.playSfx('question')
    sound.playSfx('click')
    const cue = stepGripMenu(open.machine, { type: 'cue' }, { liveMines: 1, built: ['panel'] })
    expect(sound.played).toEqual(['question', 'click'])
    expect(cue.machine).toEqual(open.machine)
    expect(cue.step).toMatchObject({ ok: true, id: 'S22.19', effects: [] })
    menu.unmount()
  })

  it('[ADR-025] the window grows before an overlay shows and shrinks after it closes', async () => {
    world = await mountVeta(WORKING, { holdOverlays: true })
    const grip = world.root.get('[data-veta-grip]')
    // A right-click on the grip opens the menu, never a drag.
    await grip.trigger('contextmenu')
    await flushPromises()
    expect(world.layouts.filter((l) => l.kind === 'overlay')).toHaveLength(1)
    // Asked for room, not answered: nothing shows yet.
    expect(world.shownAtLayout).toEqual(['none'])
    expect(shownOverlay()).toBe('none')
    await world.answerOverlays()
    expect(shownOverlay()).toBe('menu')
    expect(grip.attributes('aria-expanded')).toBe('true')
    // The first item takes the focus.
    expect(document.activeElement?.textContent).toBe('Open Panel')

    // Esc: the menu leaves the page first, and only then is the room given back.
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    )
    await flushPromises()
    expect(shownOverlay()).toBe('none')
    const overlays = world.layouts.filter((l) => l.kind === 'overlay')
    expect(overlays.at(-1)).toEqual({ kind: 'overlay', bounds: null })
    expect(world.shownAtLayout.at(-1)).toBe('none')
    expect(document.activeElement).toBe(grip.element)
    expect(grip.attributes('aria-expanded')).toBe('false')
  })
})
