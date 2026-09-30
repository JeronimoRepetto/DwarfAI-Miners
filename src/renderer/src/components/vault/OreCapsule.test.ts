// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { NUGGET_SRC } from '../../lib/art'
import OreCapsule from './OreCapsule.vue'

describe('OreCapsule', () => {
  it("shows one material's nugget and its compact count, named with the full count", () => {
    const ore = mount(OreCapsule, { props: { material: 'coal', units: 280_612 } })
    expect(ore.element.tagName).toBe('SPAN')
    expect(ore.classes()).toEqual(['dm-ore'])
    expect(ore.attributes('aria-label')).toBe('Coal: 280,612')
    expect(ore.attributes('title')).toBe('Coal: 280,612')
    const [nugget, count] = [...ore.element.children]
    expect(nugget!.tagName).toBe('IMG')
    expect(nugget!.getAttribute('src')).toBe(NUGGET_SRC.coal)
    expect(nugget!.getAttribute('alt')).toBe('')
    expect(count!.textContent).toBe('281K')
  })

  it('dims a material at zero, and grows for the vault', () => {
    expect(mount(OreCapsule, { props: { material: 'uranium', units: 0 } }).classes()).toEqual([
      'dm-ore',
      'dm-ore--zero'
    ])
    expect(
      mount(OreCapsule, { props: { material: 'gold', units: 12, size: 'lg' } }).classes()
    ).toEqual(['dm-ore', 'dm-ore--lg'])
  })
})
