// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { defaultDwarf } from '../testing/factories'
import DwarfTooltip from './DwarfTooltip.vue'

/*
 * The tooltip is where a suspicion becomes a figure (issue #47). The sprite can
 * only say "something is wrong here" by standing still; the exact number — "no
 * output for 25 minutes" — is what lets the person watching decide for
 * themselves whether to kick it, and what makes the dwarf leaving at thirty
 * minutes need no explanation at all.
 */
describe('DwarfTooltip', () => {
  it('names the dwarf, its rank, its provider and its model', () => {
    const wrapper = mount(DwarfTooltip, {
      props: {
        dwarf: defaultDwarf({ name: 'Gimli', provider: 'codex', model: 'gpt-test', effort: 'high' })
      }
    })
    for (const detail of ['Gimli', 'Worker', 'codex', 'gpt-test', 'high']) {
      expect(wrapper.text()).toContain(detail)
    }
  })

  it('puts the silence figure in plain words beside the name and model', () => {
    const wrapper = mount(DwarfTooltip, {
      props: { dwarf: defaultDwarf({ silentForMs: 25 * 60_000 }) }
    })
    expect(wrapper.get('.dwarf-silence').text()).toBe('no output for 25 minutes')
  })

  it('reads the same way at the other durations a watched dwarf reaches', () => {
    const cases: [number, string][] = [
      [30 * 60_000, 'no output for 30 minutes'],
      [60 * 60_000, 'no output for 1 hour'],
      [95 * 60_000, 'no output for 1 hour 35 minutes'],
      [4_000, 'no output for less than a minute']
    ]
    for (const [silentForMs, expected] of cases) {
      const wrapper = mount(DwarfTooltip, { props: { dwarf: defaultDwarf({ silentForMs }) } })
      expect(wrapper.get('.dwarf-silence').text(), String(silentForMs)).toBe(expected)
    }
  })

  it('says nothing at all when the provider offered no figure', () => {
    // Codex has no per-subagent transcript to read an mtime from. An empty
    // line, or a fabricated "0 minutes", would both claim knowledge we lack.
    const wrapper = mount(DwarfTooltip, { props: { dwarf: defaultDwarf() } })
    expect(wrapper.find('.dwarf-silence').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('no output')
  })

  it('still calls a silent dwarf working, because silence is not a status', () => {
    // The status line is the one place a fourth DwarfStatus would surface
    // first. Silence sits beside it as a measurement, never inside it.
    const wrapper = mount(DwarfTooltip, {
      props: { dwarf: defaultDwarf({ status: 'working', silentForMs: 45 * 60_000 }) }
    })
    expect(wrapper.get('em').text()).toBe('Working')
  })
})
