import { describe, expect, it } from 'vitest'
import { legacyTodayPart } from './seamAReplay.ts'

/** A scenario and its recording over three rows: one still legacy, one moved to the Host, one reshaped in legacy. */
const scenario = {
  about: 'fixture',
  world: { DWARFAI_SIMULATE: '1' },
  calls: [
    { row: 'A-12', channel: 'mines:get', member: 'getMines', args: [] },
    { row: 'A-13', channel: 'dwarf:activate', member: 'activateDwarf', args: ['replay:none'] },
    { row: 'A-33', channel: 'metrics:reset', member: 'resetMetrics', args: [] },
    { row: 'A-13', channel: 'dwarf:activate', member: 'activateDwarf', args: ['replay:other'] }
  ],
  pushes: [
    { row: 'A-P2', channel: 'mines:update', member: 'onMinesUpdated' },
    { row: 'A-P3', channel: 'agent:launchFailed', member: 'onLaunchFailed' },
    { row: 'A-P5', channel: 'panel:mine:show', member: 'onShowMine' }
  ]
}

const recorded = {
  calls: [
    { row: 'A-12', channel: 'mines:get', member: 'getMines', answer: { mines: [] } },
    { row: 'A-13', channel: 'dwarf:activate', member: 'activateDwarf', answer: { focused: false } },
    { row: 'A-33', channel: 'metrics:reset', member: 'resetMetrics', answer: { outcome: 'reset' } },
    { row: 'A-13', channel: 'dwarf:activate', member: 'activateDwarf', answer: { focused: true } }
  ],
  pushes: { 'mines:update': [{ mines: [] }], 'agent:launchFailed': [], 'panel:mine:show': [] }
}

/** A table that moved A-12 and A-P2 to the Host, reshaped A-33 in legacy and retired A-P5 (no route). */
const routes = [
  { channel: 'mines:get', owner: 'host', shape: 'target' },
  { channel: 'dwarf:activate', owner: 'legacy', shape: 'today' },
  { channel: 'metrics:reset', owner: 'legacy', shape: 'target' },
  { channel: 'mines:update', owner: 'host', shape: 'target' },
  { channel: 'agent:launchFailed', owner: 'legacy', shape: 'today' }
]

describe('the seam-A replay of a later release (21 §2 note 1)', () => {
  it("[ADR-001] keeps only the calls and pushes the table still routes legacy with today's shape, recording included", () => {
    const part = legacyTodayPart(scenario, recorded, routes)

    expect(part.scenario.calls.map((call) => `${call.row} ${call.args[0] ?? ''}`)).toEqual([
      'A-13 replay:none',
      'A-13 replay:other'
    ])
    expect(part.scenario.pushes.map((push) => push.row)).toEqual(['A-P3'])
    expect(part.scenario.world).toEqual(scenario.world)
    expect(part.recorded.calls.map((call) => call.answer)).toEqual([
      { focused: false },
      { focused: true }
    ])
    expect(part.recorded.pushes).toEqual({ 'agent:launchFailed': [] })
  })

  it('[ADR-001] a recording whose calls do not follow the scenario is refused, never compared out of step', () => {
    const shuffled = { ...recorded, calls: [...recorded.calls].reverse() }

    expect(() => legacyTodayPart(scenario, shuffled, routes)).toThrow(
      /does not follow the scenario/
    )
  })
})
