import { describe, expect, it } from 'vitest'
import { defaultDwarf } from '../../testing/factories'
import { rosterMenuItems } from '../scene/crewRoster'
import { needsYouCount } from '../shell/navSlot'
import { dwarfTip } from './dwarfTip'
import {
  PORTRAIT_STATUSES,
  portraitAttributes,
  portraitClasses,
  portraitMark,
  portraitStatusText
} from './portrait'

describe('portraitMark', () => {
  it('marks asking, asleep and done on the frame, and nothing for working or idle', () => {
    expect(portraitMark('asking')).toBe('?')
    expect(portraitMark('asleep')).toBe('z')
    // AMENDED for ISSUE-254 (was: done marked ✓): "done" is no status any more (PO #9, ADR-032).
    expect(PORTRAIT_STATUSES).not.toContain('done')
    expect(portraitMark('working')).toBe('')
    expect(portraitMark('idle')).toBe('')
  })
})

describe('portraitStatusText', () => {
  it('says each status as the name reads it; asking is "needs you"', () => {
    expect(portraitStatusText('asking')).toBe('needs you')
    expect(portraitStatusText('asleep')).toBe('asleep')
    expect(portraitStatusText('working')).toBe('working')
    // AMENDED for ISSUE-254 (was: done said "done", idle said "idle"): done is retired (PO #9) and
    // idle reads "Waiting" (PO #39, US-MINE-001.AC07).
    expect(PORTRAIT_STATUSES).not.toContain('done')
    expect(portraitStatusText('idle')).toBe('Waiting')
  })
})

describe('portraitClasses', () => {
  it('is the portrait and its recipe, then its size, then the forced state', () => {
    expect(portraitClasses({})).toEqual(['dm-portrait', 'm-mat'])
    expect(portraitClasses({ size: 'sm' })).toEqual(['dm-portrait', 'm-mat', 'dm-portrait--sm'])
    expect(portraitClasses({ size: 'lg', state: 'hover' })).toEqual([
      'dm-portrait',
      'm-mat',
      'dm-portrait--lg',
      'is-hover'
    ])
  })
})

describe('portraitAttributes', () => {
  it('is an unnamed figure when static, carrying only its status', () => {
    expect(portraitAttributes({ interactive: false, status: 'idle', name: 'a' })).toEqual({
      'data-status': 'idle'
    })
  })

  it('is a button named after the dwarf and its state when interactive, selection pressed', () => {
    expect(portraitAttributes({ interactive: true, status: 'asking', name: 'b' })).toEqual({
      type: 'button',
      'data-status': 'asking',
      'aria-pressed': 'false',
      'aria-label': 'b, needs you'
    })
    expect(
      portraitAttributes({ interactive: true, status: 'idle', name: 'a', selected: true })[
        'aria-pressed'
      ]
    ).toBe('true')
  })
})

/*
 * APPENDED for ISSUE-254: the one status vocabulary (ADR-032; PO #9, #39). A dwarf's status is one
 * of working, asking, idle, asleep and never "done"; each surface says it in its designed word.
 * The tooltip and every accessible name say "needs you" for asking and "Waiting" for idle (PO #39),
 * while the roster's +N hint keeps the raw word, "?" for asking.
 */
describe('the status words (ISSUE-254)', () => {
  it('[US-OBS-004.AC07, US-OBS-004.AC11, US-OBS-004.AC12, US-OBS-004.AC13, US-MINE-001.AC06, US-MINE-001.AC07, US-OBS-002.AC05] the tooltip and roster words map working, asking, idle and asleep to their designed words and never show done', () => {
    expect(PORTRAIT_STATUSES).toEqual(['working', 'asking', 'idle', 'asleep'])
    const tooltip = PORTRAIT_STATUSES.map((status) => portraitStatusText(status))
    expect(tooltip).toEqual(['working', 'needs you', 'Waiting', 'asleep'])
    expect(PORTRAIT_STATUSES.map((status) => portraitMark(status))).toEqual(['', '?', '', 'z'])

    const asking = defaultDwarf({ id: 'a', status: 'waiting', waitingReason: 'approval' })
    const asleep = defaultDwarf({ id: 'z', status: 'waiting' })
    const working = defaultDwarf({ id: 'w', status: 'working' })
    const idle = defaultDwarf({ id: 'i', status: 'leaving' })
    expect([asking, asleep, working, idle].map((dwarf) => dwarfTip(dwarf).statusText)).toEqual([
      'needs you',
      'asleep',
      'working',
      'Waiting'
    ])
    expect(rosterMenuItems([asking, asleep, working, idle]).map((item) => item.hint)).toEqual([
      '?',
      'asleep',
      'working',
      'idle'
    ])
    for (const word of [...tooltip, ...rosterMenuItems([asking, asleep, working, idle])]) {
      expect(JSON.stringify(word)).not.toContain('done')
    }
  })

  it('[US-MINE-003.AC06] a count reads 1 needs you for one and n need you for more', () => {
    expect(needsYouCount(1)).toBe('1 needs you')
    expect(needsYouCount(2)).toBe('2 need you')
    expect(needsYouCount(12)).toBe('12 need you')
  })
})
