import { describe, expect, it } from 'vitest'
import { defaultDwarf } from '../../testing/factories'
import {
  STOP_DWARF_BODY,
  bubbleMark,
  dayLabel,
  messagePanelChips,
  messagePanelMenu,
  messagePanelOutcome,
  stopDwarfTitle
} from './panelChrome'

/*
 * The redesigned MessagePanel's chrome (#635), `organisms/message-panel` in the design: the two
 * meta chips under the name, the turn outcome line under the header, the day divider, the mark a
 * bubble wears and the ⋯ menu. What each says is decided here; the panel draws it.
 */
describe('messagePanelChips', () => {
  it('names the provider, the model and the effort in one chip, and the worktree in another', () => {
    const dwarf = defaultDwarf({
      provider: 'claude',
      model: 'opus',
      effort: 'high',
      workplace: { path: 'C:/x/anvil', branch: 'feat/ore-ledger' }
    })
    expect(messagePanelChips(dwarf)).toEqual(['Claude · opus · high', 'worktree: feat/ore-ledger'])
  })

  it('leaves out what is not known, and the worktree chip for a dwarf in the mine’s own folder', () => {
    const dwarf = defaultDwarf({ provider: 'codex', model: undefined, effort: undefined })
    expect(messagePanelChips({ ...dwarf, workplace: undefined })).toEqual(['Codex'])
  })
})

describe('messagePanelOutcome', () => {
  it('reads a permission as waiting on you, in the asking tone', () => {
    const dwarf = defaultDwarf({ status: 'waiting', waitingReason: 'approval' })
    expect(messagePanelOutcome(dwarf)).toEqual({
      status: 'asking',
      text: 'Waiting on you · permission'
    })
  })

  it('counts the questions an ask carries', () => {
    const question = (text: string) => ({ question: text, multiSelect: false, options: [] })
    const dwarf = defaultDwarf({
      status: 'waiting',
      waitingReason: 'user-input',
      pendingQuestion: {
        toolUseId: 't',
        channel: 'terminal',
        questions: [question('a'), question('b'), question('c')]
      }
    })
    expect(messagePanelOutcome(dwarf)).toEqual({
      status: 'asking',
      text: 'Waiting on you · 3 questions'
    })
    expect(
      messagePanelOutcome({
        ...dwarf,
        pendingQuestion: { ...dwarf.pendingQuestion!, questions: [question('a')] }
      }).text
    ).toBe('Waiting on you · 1 question')
  })

  it('says how the last turn ended, in today’s words, while the dwarf is not asking', () => {
    const dwarf = defaultDwarf({
      status: 'working',
      lastTurn: { kind: 'concluded', text: 'Done.', endedAt: 1 }
    })
    expect(messagePanelOutcome(dwarf)).toEqual({
      status: 'working',
      text: 'Last turn concluded: Done.'
    })
  })

  it('says so at the end of the line when the wire itself trimmed the turn’s words', () => {
    const dwarf = defaultDwarf({
      status: 'working',
      lastTurn: { kind: 'concluded', text: 'Done.', truncated: true, endedAt: 1 }
    })
    expect(messagePanelOutcome(dwarf).text).toBe('Last turn concluded: Done. (trimmed)')
  })

  it('falls back to the state word the design prints when nothing else is known', () => {
    expect(messagePanelOutcome(defaultDwarf({ status: 'working' }))).toEqual({
      status: 'working',
      text: 'Working'
    })
    expect(messagePanelOutcome(defaultDwarf({ status: 'waiting' }))).toEqual({
      status: 'asleep',
      text: 'Idle'
    })
  })
})

describe('dayLabel', () => {
  const NOW = new Date(2026, 8, 27, 15, 0).getTime()

  it('reads a message from today as TODAY', () => {
    expect(dayLabel(new Date(2026, 8, 27, 9, 2).getTime(), NOW)).toBe('TODAY')
  })

  it('names another day by its month and day', () => {
    expect(dayLabel(new Date(2026, 8, 26, 23, 59).getTime(), NOW)).toBe('SEP 26')
  })

  it('draws no divider for a message with no time', () => {
    expect(dayLabel(Number.NaN, NOW)).toBeNull()
  })
})

describe('bubbleMark', () => {
  it('reads each delivery marker as the mark the bubble draws', () => {
    expect(bubbleMark({ cls: 'is-sending', glyph: '…', title: 'Sending...' })).toEqual({
      mark: 'pending',
      glyph: '…',
      title: 'Sending...'
    })
    expect(bubbleMark({ cls: 'is-delivered', glyph: '✓', title: 'Handed over' }).mark).toBe(
      'delivered'
    )
    expect(bubbleMark({ cls: 'is-reacted', glyph: '✓✓', title: 'Seen' }).mark).toBe('reacted')
  })

  it('spells a failure as the design does, with its reason on the title', () => {
    expect(bubbleMark({ cls: 'is-failed', glyph: '✕', title: 'no session' })).toEqual({
      mark: 'failed',
      glyph: '✕ not delivered',
      title: 'no session'
    })
  })
})

describe('the ⋯ menu', () => {
  it('holds Open console and Mine history, then Stop dwarf… below a rule, as danger', () => {
    expect(messagePanelMenu(true)).toEqual([
      { label: 'Open console', icon: 'console' },
      { label: 'Mine history', icon: 'history' },
      { separator: true },
      { label: 'Stop dwarf…', danger: true, disabled: false }
    ])
  })

  it('offers Stop dwarf… only where the session can be stopped', () => {
    expect(messagePanelMenu(false).at(-1)).toEqual({
      label: 'Stop dwarf…',
      danger: true,
      disabled: true
    })
  })

  it('asks before it stops, naming the dwarf', () => {
    expect(stopDwarfTitle('dwarfai-53')).toBe('Stop dwarfai-53?')
    expect(STOP_DWARF_BODY).toBe(
      'The session ends and the dwarf walks out. The conversation stays in the mine history.'
    )
  })
})
