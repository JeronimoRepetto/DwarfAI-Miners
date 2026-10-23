// @vitest-environment jsdom
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { WALK_OUT_KEY } from '../../composables/useMines'
import { assignScene } from '../../lib/scene/sceneAssignment'
import { sceneLayout } from '../../lib/scene/sceneLayout'
import { defaultDwarf, defaultMine } from '../../testing/factories'
import type { Mine } from '../../types'
import SceneDwarf from '../scene/SceneDwarf.vue'
import ValleMineArt from './ValleMineArt.vue'

enableAutoUnmount(afterEach)

/*
 * A Valle zone's painting walks its crew in and out as the Panel's mine column does (EPIC-20 visual parity; `DS`
 * organisms/mine-zone draws the column's own art and crew): the crew already there is placed, a later arrival walks in
 * from the spawn point, an arrival the board saw walks in even into a zone just mounted, a leaver walks out, and reduced
 * motion places everyone at once. The walk itself is the Panel's (`useCrewWalk`), shared, not copied.
 */

const first = defaultDwarf({ id: 'first', name: 'first', status: 'working' })
const later = defaultDwarf({ id: 'later', name: 'later', status: 'working' })

function mountArt(mine: Mine, arrived: ReadonlySet<string> = new Set()) {
  return mount(ValleMineArt, {
    props: { mine, arrived },
    global: { provide: { [WALK_OUT_KEY as symbol]: { walkingOut: () => {}, walkedOut: () => {} } } }
  })
}
const dwarfOf = (wrapper: ReturnType<typeof mountArt>, id: string) =>
  wrapper.findAllComponents(SceneDwarf).find((d) => d.props('dwarf').id === id)!

describe("a Valle zone's crew walks in and out (EPIC-20 visual parity)", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'matchMedia')
  })

  it('[US-MINE-009.AC01, US-MINE-009.AC02] the crew already there is placed, and a dwarf that turns up later walks in from the spawn point', async () => {
    const wrapper = mountArt(defaultMine({ dwarfs: [first] }))
    await wrapper.vm.$nextTick()
    expect(dwarfOf(wrapper, 'first').props('walking')).toBe(false)
    await wrapper.setProps({ mine: defaultMine({ dwarfs: [first, later] }) })
    await wrapper.vm.$nextTick()
    const walker = dwarfOf(wrapper, 'later').props()
    expect(walker.walking).toBe(true)
    expect(walker.walkMs).toBeGreaterThan(0)
    const target = assignScene([first, later], sceneLayout('bronze')).get(later.id)!
    expect([walker.x, walker.y]).not.toEqual([target.point.x, target.point.y])
  })

  it('[US-MINE-009.AC02] a dwarf the board saw arrive walks in even into a zone mounted with it inside', async () => {
    const wrapper = mountArt(defaultMine({ dwarfs: [first, later] }), new Set(['later']))
    await wrapper.vm.$nextTick()
    expect(dwarfOf(wrapper, 'first').props('walking')).toBe(false)
    expect(dwarfOf(wrapper, 'later').props('walking')).toBe(true)
    expect(dwarfOf(wrapper, 'later').props('entering')).toBe(true)
  })

  it('[US-MINE-009.AC03] a dwarf whose process closed walks out', async () => {
    const wrapper = mountArt(defaultMine({ dwarfs: [first, later] }))
    await wrapper.vm.$nextTick()
    await wrapper.setProps({
      mine: defaultMine({ dwarfs: [first, { ...later, status: 'leaving' }] })
    })
    await wrapper.vm.$nextTick()
    expect(dwarfOf(wrapper, 'later').props('walking')).toBe(true)
  })

  it('[US-MINE-009.AC05] under reduced motion an arrival is placed at once, with no walk', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: true })
    })
    const wrapper = mountArt(defaultMine({ dwarfs: [first] }))
    await wrapper.vm.$nextTick()
    await wrapper.setProps({ mine: defaultMine({ dwarfs: [first, later] }) })
    await wrapper.vm.$nextTick()
    expect(dwarfOf(wrapper, 'later').props('walking')).toBe(false)
    expect(dwarfOf(wrapper, 'later').props('walkMs')).toBe(0)
  })
})
