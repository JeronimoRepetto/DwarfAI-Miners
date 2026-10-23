// @vitest-environment jsdom
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import type { MineId } from '@dwarfai/contracts'
import ValleWorkFront from './ValleWorkFront.vue'

enableAutoUnmount(afterEach)

/*
 * The Work front's compact mines list (`DS/prototype/organisms/mine-rows/mine-rows.js`; `DS/docs/copy.md`
 * organisms/mine-rows; EPIC-20 visual parity): its header's sort and "+" beside the fold, the search field under it,
 * and each line's "?" needs-you mark, the lines built once and only hidden and reordered.
 */

const MORIA = 'moria' as MineId
const EREBOR = 'erebor' as MineId
const KHAZAD = 'khazad' as MineId

function mountFront() {
  return mount(ValleWorkFront, {
    props: {
      foldedList: false,
      mines: [
        { mineId: MORIA, name: 'moria', tier: 'silver', measured: true, count: 1, needs: 0 },
        { mineId: EREBOR, name: 'erebor', tier: 'gold', measured: true, count: 3, needs: 2 },
        { mineId: KHAZAD, name: 'khazad', tier: 'bronze', measured: true, count: 2, needs: 0 }
      ],
      mine: { mineId: MORIA, name: 'moria' }
    }
  })
}
const order = (front: ReturnType<typeof mountFront>) =>
  front.findAll('[data-valle-row]').map((row) => row.attributes('data-valle-row'))

describe("the Work front's mines list: search, sort, add and the needs-you mark", () => {
  it('[US-MINES-003.AC07] the header holds the sort named for the order in force, then "+" Add a mine, then the fold', async () => {
    const front = mountFront()
    const head = front.get('.dm-mrows__head')
    expect(head.findAll('button').map((button) => button.attributes('title'))).toEqual([
      'Sort: Needs you first',
      'Add a mine',
      'Fold the list'
    ])
    await head.get('button[title="Add a mine"]').trigger('click')
    expect(front.emitted('add-mine')).toHaveLength(1)
  })

  it('[US-MINES-003.AC01, US-MINES-003.AC07] the sort cycles Needs you first, Tier, richest first and Name, each with its toast', async () => {
    const front = mountFront()
    expect(order(front)).toEqual([EREBOR, KHAZAD, MORIA])
    const sort = () => front.get('.dm-mrows__head button[data-mrows-sort]')
    await sort().trigger('click')
    expect(sort().attributes('title')).toBe('Sort: Tier, richest first')
    expect(order(front)).toEqual([EREBOR, MORIA, KHAZAD])
    await sort().trigger('click')
    expect(order(front)).toEqual([EREBOR, KHAZAD, MORIA])
    await sort().trigger('click')
    expect(sort().attributes('title')).toBe('Sort: Needs you first')
    expect(front.emitted('sorted')).toEqual([
      ['Sorted by tier, richest first'],
      ['Sorted by name'],
      ['Sorted by needs you first']
    ])
  })

  it('[US-MINES-001.AC01] the search field under the header filters the lines as the person types, and says when none matches', async () => {
    const front = mountFront()
    const field = front.get('.dm-mrows__search input')
    expect(field.attributes('placeholder')).toBe('Search mines')
    await field.setValue('ERE')
    expect(order(front)).toEqual([EREBOR])
    await field.setValue('nothing')
    expect(order(front)).toEqual([])
    expect(front.get('.dm-mrows__empty').text()).toBe('No mine matches.')
    await field.setValue('')
    expect(order(front)).toEqual([EREBOR, KHAZAD, MORIA])
    expect(front.find('.dm-mrows__empty').exists()).toBe(false)
  })

  it('[US-VALLE-004.AC03] a line with dwarfs waiting carries "?" and their count, and says so in its name', () => {
    const front = mountFront()
    const erebor = front.get(`[data-valle-row="${EREBOR}"]`)
    expect(erebor.get('.dm-mrow__ask').text()).toBe('?2')
    expect(erebor.attributes('data-needs')).toBe('true')
    expect(erebor.attributes('aria-label')).toBe('erebor, 3 dwarfs, 2 need you')
    const moria = front.get(`[data-valle-row="${MORIA}"]`)
    expect(moria.get('.dm-mrow__ask').text()).toBe('')
    expect(moria.attributes('aria-label')).toBe('moria, 1 dwarf')
  })
})
