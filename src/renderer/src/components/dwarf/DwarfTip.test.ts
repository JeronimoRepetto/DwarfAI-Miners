// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { defaultDwarf } from '../../testing/factories'
import DwarfTip from './DwarfTip.vue'

/*
 * The dwarf tooltip's body (#635, components.md, Dwarf tooltip). What moved here from
 * DwarfTooltip.test.ts, which went with its component, and where each guarantee lives now:
 * - the name, rank and provider, model and effort lines: here and in lib/dwarf/dwarfTip.test.ts;
 * - the silence figure shown whenever known and omitted when the provider keeps none (#47):
 *   lib/dwarf/dwarfTip.test.ts, "leaves out what the provider does not know";
 * - its plain-words spelling at several durations ("no output for 25 minutes"): RETIRED by the
 *   design, which writes "silent 25m" (copy.md, Dwarf tooltip); compactSilence pins the new form;
 * - a silent dwarf still called working, silence never a status: lib/dwarf/dwarfTip.test.ts;
 * - Claude's effort words spelled out (describeEffort): lib/dwarf/dwarfTip.test.ts;
 * - the "hosted" label for a held session (#194): lib/dwarf/dwarfTip.test.ts;
 * - role=tooltip: on the shared card around it now (TooltipCard.vue, TooltipCard.test.ts).
 */
describe('DwarfTip', () => {
  const dwarf = defaultDwarf({
    name: 'dwarfai-53',
    role: 'worker',
    provider: 'claude',
    model: 'opus',
    effort: 'high',
    silentForMs: 120_000,
    status: 'working'
  })

  it('draws the face, then name, rank and provider, model and effort, silence and status', () => {
    const wrapper = mount(DwarfTip, { props: { dwarf } })
    expect(wrapper.find('.dm-dtip .dm-portrait.dm-portrait--sm').exists()).toBe(true)
    expect(wrapper.find('.dm-dtip__name').text()).toBe('dwarfai-53')
    const lines = wrapper.findAll('.dm-dtip__line').map((line) => line.text())
    expect(lines).toEqual(['worker · Claude', 'opus · high effort', 'silent 2m · working'])
    expect(wrapper.find('.dm-dtip__line b').text()).toBe('Claude')
  })

  it('marks the status with the state it is, for its colour', () => {
    const wrapper = mount(DwarfTip, {
      props: { dwarf: { ...dwarf, status: 'waiting', waitingReason: 'approval' } }
    })
    const status = wrapper.find('.dm-dtip__status')
    expect(status.attributes('data-status')).toBe('asking')
    expect(status.text()).toBe('needs you')
    expect(wrapper.find('.dm-portrait').attributes('data-status')).toBe('asking')
  })

  it('has no controls: the card alone can do nothing', () => {
    const wrapper = mount(DwarfTip, { props: { dwarf } })
    expect(wrapper.find('button').exists()).toBe(false)
  })
})
