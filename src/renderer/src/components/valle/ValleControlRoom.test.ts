// @vitest-environment jsdom
import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { emptyStates } from '../../lib/valle/emptyStates'
import { NO_PINS } from '../../lib/valle/pins'
import { EREBOR, MORIA } from '../../lib/veta/testing/vetaFixtures'
import ValleControlRoom from './ValleControlRoom.vue'

/*
 * The Control room's empty mosaic (ISSUE-310; 07 machine 38 `mosaic-empty`, S38.05, S38.06; §24 I-34): with no column
 * only the dashed add slot shows, and no text of the mosaic's own, since the package has no copy for it.
 */
let root: VueWrapper | undefined
afterEach(() => {
  root?.unmount()
  root = undefined
  document.body.innerHTML = ''
})

const column = (mineId: typeof MORIA, name: string) => ({ mineId, name, enterable: true })

function mountRoom(columns: ReturnType<typeof column>[]): VueWrapper {
  root = mount(ValleControlRoom, { props: { columns }, attachTo: document.body })
  return root
}

describe('the Control room empty mosaic (ISSUE-310; 07 machine 38)', () => {
  it('[S38.05, S38.06] an empty mosaic shows only the add slot and no text, and columns bring it back', async () => {
    const room = mountRoom([])
    expect(emptyStates(NO_PINS, []).mosaic).toBe('mosaic-empty')
    const mosaic = room.get('[data-valle-mosaic]')
    expect(mosaic.attributes('data-empty')).toBe('true')
    // Only the add slot, and the only words are the slot's own: nothing invented for the empty mosaic.
    expect(room.findAll('[data-valle-column]')).toHaveLength(0)
    expect(mosaic.element.children).toHaveLength(1)
    expect(mosaic.text()).toBe('Add a mine here')

    // S38.06: a column added.
    await room.setProps({ columns: [column(MORIA, 'moria')] })
    expect(mosaic.attributes('data-empty')).toBe('false')
    expect(
      room.findAll('[data-valle-column]').map((c) => c.attributes('data-valle-column'))
    ).toEqual([MORIA])
    expect(mosaic.element.children).toHaveLength(2)
    expect(mosaic.text()).toContain('Add a mine here')

    // S38.05: the last column closed.
    await room.setProps({ columns: [] })
    expect(mosaic.attributes('data-empty')).toBe('true')
    expect(mosaic.element.children).toHaveLength(1)
    await room.setProps({ columns: [column(MORIA, 'moria'), column(EREBOR, 'erebor')] })
    expect(mosaic.attributes('data-empty')).toBe('false')
  })
})
