import { describe, expect, it } from 'vitest'
import { defaultDwarf } from '../../testing/factories'
import type { Dwarf } from '../../types'
import {
  STOP_DWARF_BODY,
  bubbleMark,
  dayLabel,
  messagePanelChips,
  messagePanelMenu,
  messagePanelOutcome,
  OUTCOME_TIP_MAX_CHARS,
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

/*
 * AMENDED for #635 (the turn outcome line ruling, MESSAGE-QUESTIONS 7 and the decision log's Turn
 * outcome line; was: the last turn's own sentence, "Last turn concluded: Done.", its "(trimmed)"
 * mark, and "Idle" for a resting dwarf). The line is now built only from what the app observes:
 * the status word, the steps of the run it counts, and how long ago a finished turn ended. Two
 * tests went with the old sentence and are stated here rather than lost: "says how the last turn
 * ended, in today's words" (now "never prints the turn's own closing words", below) and "says so
 * at the end of the line when the wire itself trimmed the turn's words" (removed: the line no
 * longer carries the turn's words, so it has nothing to call trimmed).
 */
describe('messagePanelOutcome', () => {
  const NOW = 1_800_000_000_000
  const MINUTE = 60_000

  it('reads a permission as waiting on you, in the asking tone', () => {
    const dwarf = defaultDwarf({ status: 'waiting', waitingReason: 'approval' })
    expect(messagePanelOutcome(dwarf, undefined, NOW)).toEqual({
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
    expect(messagePanelOutcome(dwarf, undefined, NOW)).toEqual({
      status: 'asking',
      text: 'Waiting on you · 3 questions'
    })
    expect(
      messagePanelOutcome(
        { ...dwarf, pendingQuestion: { ...dwarf.pendingQuestion!, questions: [question('a')] } },
        undefined,
        NOW
      ).text
    ).toBe('Waiting on you · 1 question')
  })

  it('names what the dwarf waits on, never the steps of the run before the ask', () => {
    const dwarf = defaultDwarf({ status: 'waiting', waitingReason: 'approval' })
    expect(messagePanelOutcome(dwarf, 4, NOW).text).toBe('Waiting on you · permission')
  })

  it('reads a working dwarf with no run to count as the word alone', () => {
    expect(messagePanelOutcome(defaultDwarf({ status: 'working' }), undefined, NOW)).toEqual({
      status: 'working',
      text: 'Working'
    })
  })

  it('counts the steps of the open run so far while the dwarf works, singular for one', () => {
    const dwarf = defaultDwarf({ status: 'working' })
    expect(messagePanelOutcome(dwarf, 2, NOW).text).toBe('Working · 2 steps so far')
    expect(messagePanelOutcome(dwarf, 1, NOW).text).toBe('Working · 1 step so far')
  })

  it('never says how long ago a turn ended while the dwarf is working again', () => {
    const dwarf = defaultDwarf({
      status: 'working',
      lastTurn: { kind: 'concluded', endedAt: NOW - 41 * MINUTE }
    })
    expect(messagePanelOutcome(dwarf, undefined, NOW).text).toBe('Working')
  })

  it('never prints the turn’s own closing words, which are the conversation’s to show', () => {
    const dwarf = defaultDwarf({
      status: 'waiting',
      lastTurn: { kind: 'concluded', text: 'Done.', truncated: true, endedAt: NOW - 2 * MINUTE }
    })
    expect(messagePanelOutcome(dwarf, undefined, NOW).text).toBe('Turn finished · idle for 2m')
  })

  it('reads a finished turn with its last run and how long ago it ended', () => {
    const dwarf = defaultDwarf({
      status: 'waiting',
      lastTurn: { kind: 'concluded', endedAt: NOW - 41 * MINUTE }
    })
    expect(messagePanelOutcome(dwarf, 5, NOW)).toEqual({
      status: 'asleep',
      text: 'Turn finished · 5 steps · idle for 41m'
    })
    expect(messagePanelOutcome(dwarf, 1, NOW).text).toBe('Turn finished · 1 step · idle for 41m')
  })

  it('writes the idle time as the dwarf tooltip writes a silence, in its largest whole unit', () => {
    const dwarf = (endedAt: number) =>
      defaultDwarf({ status: 'waiting', lastTurn: { kind: 'concluded', endedAt } })
    expect(messagePanelOutcome(dwarf(NOW - 2 * 60 * MINUTE), undefined, NOW).text).toBe(
      'Turn finished · idle for 2h'
    )
    expect(messagePanelOutcome(dwarf(NOW - 12_000), undefined, NOW).text).toBe(
      'Turn finished · idle for 12s'
    )
    // A clock that reads the end as later than now claims no idle time at all.
    expect(messagePanelOutcome(dwarf(NOW + 5_000), undefined, NOW).text).toBe(
      'Turn finished · idle for 0s'
    )
  })

  it('leaves the idle time out for a session whose turn end the app never saw', () => {
    expect(messagePanelOutcome(defaultDwarf({ status: 'waiting' }), undefined, NOW)).toEqual({
      status: 'asleep',
      text: 'Turn finished'
    })
    expect(messagePanelOutcome(defaultDwarf({ status: 'waiting' }), 3, NOW).text).toBe(
      'Turn finished · 3 steps'
    )
  })

  it('names a turn that ended badly in place of Turn finished, without the provider’s code', () => {
    const ended = (kind: 'capped' | 'errored' | 'interrupted') =>
      messagePanelOutcome(
        defaultDwarf({
          status: 'waiting',
          lastTurn: { kind, detail: 'error_max_turns', endedAt: NOW - 5 * MINUTE }
        }),
        5,
        NOW
      ).text
    expect(ended('capped')).toBe('Turn stopped at a limit · 5 steps · idle for 5m')
    expect(ended('errored')).toBe('Turn failed · 5 steps · idle for 5m')
    expect(ended('interrupted')).toBe('Turn interrupted · 5 steps · idle for 5m')
  })

  it('reads a leaving dwarf as a finished turn, under the resting square', () => {
    expect(messagePanelOutcome(defaultDwarf({ status: 'leaving' }), undefined, NOW)).toEqual({
      status: 'asleep',
      text: 'Turn finished'
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
  // AMENDED for #635 (MESSAGE-QUESTIONS 13; was: messagePanelMenu(true)): the menu takes why
  // Stop cannot act, null when it can, rather than a bare yes or no.
  it('holds Open console and Mine history, then Stop dwarf… below a rule, as danger', () => {
    expect(messagePanelMenu(null)).toEqual([
      { label: 'Open console', icon: 'console' },
      { label: 'Mine history', icon: 'history' },
      { separator: true },
      { label: 'Stop dwarf…', danger: true, disabled: false }
    ])
  })

  /*
   * AMENDED for #635 (MESSAGE-QUESTIONS 13; was: messagePanelMenu(false) drew it disabled with no
   * title). Disabled in the ruling's two cases only, each with its reason as the title in the
   * house form "<action> · <reason>"; the label stays "Stop dwarf…".
   */
  it('offers Stop dwarf… only where the session can be stopped', () => {
    expect(messagePanelMenu('open-turn').at(-1)).toEqual({
      label: 'Stop dwarf…',
      danger: true,
      disabled: true,
      title: 'Stop dwarf · this turn can only be stopped where its session runs'
    })
  })

  it('says a stop already on its way, disabled', () => {
    expect(messagePanelMenu('stopping').at(-1)).toEqual({
      label: 'Stop dwarf…',
      danger: true,
      disabled: true,
      title: 'Stop dwarf · already stopping'
    })
  })

  it('asks before it stops, naming the dwarf', () => {
    expect(stopDwarfTitle('dwarfai-53')).toBe('Stop dwarfai-53?')
    expect(STOP_DWARF_BODY).toBe(
      'The session ends and the dwarf walks out. The conversation stays in the mine history.'
    )
  })
})

/*
 * Past a day, and what the line leaves out (#635; MESSAGE-QUESTIONS 9 and 10): the idle time goes
 * on to days, and the line's tooltip carries a finished turn's closing words, trimmed, or the
 * provider's own word for a turn that ended badly. With nothing to add there is no tooltip.
 */
describe('messagePanelOutcome, past a day and in its tooltip', () => {
  const NOW = 1_800_000_000_000
  const DAY = 86_400_000
  const resting = (lastTurn: Dwarf['lastTurn']) => defaultDwarf({ status: 'waiting', lastTurn })

  it('writes an idle time past a day in days, and a week as 7d', () => {
    const line = (ms: number) =>
      messagePanelOutcome(resting({ kind: 'concluded', endedAt: NOW - ms }), undefined, NOW).text
    expect(line(2 * DAY)).toBe('Turn finished · idle for 2d')
    expect(line(7 * DAY + 5 * 3_600_000)).toBe('Turn finished · idle for 7d')
    expect(line(49 * 3_600_000)).toBe('Turn finished · idle for 2d')
  })

  it('carries a concluded turn’s closing words in the tooltip, whole when they are short', () => {
    const outcome = messagePanelOutcome(
      resting({ kind: 'concluded', text: '  Found the seam.  ', endedAt: NOW }),
      undefined,
      NOW
    )
    expect(outcome.tip).toBe('Found the seam.')
  })

  it('trims closing words past 200 characters, with an ellipsis', () => {
    const long = 'a'.repeat(OUTCOME_TIP_MAX_CHARS) + 'bcdef'
    const tip = messagePanelOutcome(
      resting({ kind: 'concluded', text: long, endedAt: NOW }),
      undefined,
      NOW
    ).tip
    expect(OUTCOME_TIP_MAX_CHARS).toBe(200)
    expect(tip).toBe('a'.repeat(200) + '…')
    // Exactly 200 is not cut.
    expect(
      messagePanelOutcome(
        resting({ kind: 'concluded', text: 'a'.repeat(200), endedAt: NOW }),
        undefined,
        NOW
      ).tip
    ).toBe('a'.repeat(200))
  })

  it('never cuts a character in half when it trims', () => {
    const text = 'a'.repeat(199) + '😀😀'
    const tip = messagePanelOutcome(
      resting({ kind: 'concluded', text, endedAt: NOW }),
      undefined,
      NOW
    ).tip
    expect(tip).toBe('a'.repeat(199) + '😀…')
  })

  it('names a turn stopped at a limit and the provider’s own word, verbatim', () => {
    const tip = messagePanelOutcome(
      resting({ kind: 'capped', detail: 'error_max_turns', endedAt: NOW }),
      undefined,
      NOW
    ).tip
    expect(tip).toBe('Stopped at a limit: error_max_turns')
  })

  it('has no tooltip when there is nothing to add', () => {
    const tip = (lastTurn: Dwarf['lastTurn']) =>
      messagePanelOutcome(resting(lastTurn), undefined, NOW).tip
    expect(tip(undefined)).toBeUndefined()
    expect(tip({ kind: 'concluded', endedAt: NOW })).toBeUndefined()
    expect(tip({ kind: 'concluded', text: '   ', endedAt: NOW })).toBeUndefined()
    expect(tip({ kind: 'capped', endedAt: NOW })).toBeUndefined()
  })

  it('adds nothing about a past turn while the dwarf works or asks', () => {
    const lastTurn = { kind: 'concluded' as const, text: 'Found the seam.', endedAt: NOW }
    expect(
      messagePanelOutcome(defaultDwarf({ status: 'working', lastTurn }), undefined, NOW).tip
    ).toBeUndefined()
    expect(
      messagePanelOutcome(
        defaultDwarf({ status: 'waiting', waitingReason: 'approval', lastTurn }),
        undefined,
        NOW
      ).tip
    ).toBeUndefined()
  })
})
