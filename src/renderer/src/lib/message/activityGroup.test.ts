import { describe, expect, it } from 'vitest'
import { defaultDwarf } from '../../testing/factories'
import type { FeedActivityKind } from '../../types'
import type { PanelMessage } from './conversation'
import {
  ACTIVITY_WORKING_LABEL,
  activityStepsLabel,
  countedRunSteps,
  groupActivity,
  outcomeSteps,
  runsHaveEnded,
  turnSteps
} from './activityGroup'

function spoken(key: string, text = 'Found the seam.'): PanelMessage {
  return { from: 'agent', text, key }
}

function tool(key: string, text: string, kind: FeedActivityKind = 'run'): PanelMessage {
  return { from: 'agent', text, key, activity: { kind, target: text } }
}

describe('groupActivity', () => {
  it('answers with nothing for a conversation that has no rows at all', () => {
    expect(groupActivity([], { ended: false })).toEqual([])
  })

  it('leaves spoken rows as entries of their own, in the order they were said', () => {
    const rows = [spoken('a', 'dig here'), spoken('b', 'On my way.')]
    expect(groupActivity(rows, { ended: false })).toEqual([
      { kind: 'message', key: 'a', message: rows[0] },
      { kind: 'message', key: 'b', message: rows[1] }
    ])
  })

  it('folds a run of consecutive tool calls into one group, keeping its rows in order', () => {
    const rows = [
      spoken('a', 'dig here'),
      tool('b', 'Ran pnpm test'),
      tool('c', 'Edited src/foo.ts', 'edit'),
      tool('d', 'Read src/bar.ts', 'read'),
      spoken('e', 'Tests pass.')
    ]
    const entries = groupActivity(rows, { ended: false })
    expect(entries.map((entry) => entry.kind)).toEqual(['message', 'activity', 'message'])
    const group = entries[1]!
    expect(group.kind === 'activity' && group.rows).toEqual([rows[1], rows[2], rows[3]])
  })

  it('hands the very same row objects back, so a group draws exactly the lines the panel drew', () => {
    const line = tool('b', 'Ran pnpm test')
    const entries = groupActivity([line], { ended: true })
    const group = entries[0]!
    expect(group.kind === 'activity' && group.rows[0]).toBe(line)
  })

  it('breaks the run at a spoken row, so each stretch between two bubbles is its own group', () => {
    const rows = [
      tool('a', 'Ran one'),
      spoken('b', 'Halfway.'),
      tool('c', 'Ran two'),
      tool('d', 'Ran three')
    ]
    const entries = groupActivity(rows, { ended: true })
    expect(entries.map((entry) => entry.kind)).toEqual(['activity', 'message', 'activity'])
    expect(entries.map((entry) => entry.key)).toEqual(['a', 'b', 'c'])
  })

  it('groups a leading run too, when nothing was said before it', () => {
    const entries = groupActivity([tool('a', 'Ran pnpm test'), spoken('b')], { ended: false })
    expect(entries[0]!.kind).toBe('activity')
  })

  it("keys a group by its first activity row's key, so the reader's own toggle survives a re-read", () => {
    const entries = groupActivity(
      [spoken('a'), tool('b', 'Ran pnpm test'), tool('c', 'Ran again')],
      {
        ended: true
      }
    )
    expect(entries[1]!.key).toBe('b')
  })

  /**
   * A run of ONE is still a group. The alternative — a single call drawn as the
   * bare line #240 drew and folded only from the second call on — changes the
   * shape of the list under a reader mid-run, which is the same objection the
   * panel already answers by never resizing itself on a new message.
   */
  it('folds a run of one call into a group as well, rather than leaving a bare line', () => {
    const entries = groupActivity([spoken('a'), tool('b', 'Ran pnpm test')], { ended: true })
    expect(entries[1]!.kind).toBe('activity')
    expect(entries[1]!.kind === 'activity' && entries[1]!.rows).toHaveLength(1)
  })

  describe('the label', () => {
    it('counts the run and names its last call once the run is closed', () => {
      const entries = groupActivity(
        [
          tool('a', 'Ran pnpm test'),
          tool('b', 'Read src/bar.ts', 'read'),
          tool('c', 'Edited src/foo.ts', 'edit'),
          spoken('d', 'Tests pass.')
        ],
        { ended: false }
      )
      expect(entries[0]!.kind === 'activity' && entries[0]!.label).toBe(
        '3 steps — Edited src/foo.ts'
      )
      expect(entries[0]!.kind === 'activity' && entries[0]!.closed).toBe(true)
    })

    it('says one step in the singular, because a count that reads wrong reads as a bug', () => {
      const entries = groupActivity([tool('a', 'Ran pnpm test'), spoken('b')], { ended: false })
      expect(entries[0]!.kind === 'activity' && entries[0]!.label).toBe('1 step — Ran pnpm test')
    })

    it('reads Working... while the run is the last thing in a live conversation', () => {
      const entries = groupActivity([spoken('a'), tool('b', 'Ran pnpm test')], { ended: false })
      expect(entries[1]!.kind === 'activity' && entries[1]!.label).toBe(ACTIVITY_WORKING_LABEL)
      expect(entries[1]!.kind === 'activity' && entries[1]!.closed).toBe(false)
    })

    it('closes the trailing run once the session has ended, since nothing more can join it', () => {
      const entries = groupActivity([spoken('a'), tool('b', 'Ran pnpm test')], { ended: true })
      expect(entries[1]!.kind === 'activity' && entries[1]!.closed).toBe(true)
      expect(entries[1]!.kind === 'activity' && entries[1]!.label).toBe('1 step — Ran pnpm test')
    })

    it('closes a run a spoken row already followed, even while the session is live', () => {
      // The run is over as a fact about the transcript, not as a fact about the
      // session: the agent spoke after it, so nothing further can join it.
      const entries = groupActivity([tool('a', 'Ran pnpm test'), spoken('b', 'Done.')], {
        ended: false
      })
      expect(entries[0]!.kind === 'activity' && entries[0]!.closed).toBe(true)
    })

    it('leaves an earlier run closed while only the trailing one is still growing', () => {
      const entries = groupActivity(
        [tool('a', 'Ran one'), spoken('b'), tool('c', 'Ran two'), tool('d', 'Ran three')],
        { ended: false }
      )
      const labels = entries.flatMap((entry) => (entry.kind === 'activity' ? [entry.label] : []))
      expect(labels).toEqual(['1 step — Ran one', ACTIVITY_WORKING_LABEL])
    })
  })
})

/*
 * The design's own label for a folded run (#635, copy.md, Activity disclosure: "{stepsCount}
 * step[s] · activity"), which the redesigned mine history draws; the MessagePanel keeps its label
 * above until its own slice.
 */
describe('activityStepsLabel', () => {
  it('counts the steps, singular for one', () => {
    expect(activityStepsLabel(5)).toBe('5 steps · activity')
    expect(activityStepsLabel(1)).toBe('1 step · activity')
  })
})

/*
 * The person's own words never close a run (#294, #635; decision log, Activity run closes on the
 * dwarf, MESSAGE-QUESTIONS 3): a message somebody sent is not the agent finishing, whether the
 * transcript already carries it or it is still the panel's own echo. Only the dwarf speaking, or
 * its turn ending, closes one.
 */
describe('a run past the person’s own message', () => {
  function said(key: string, text = 'Also check the table.'): PanelMessage {
    return { from: 'user', text, key }
  }

  it('stays open while only the person has spoken after it', () => {
    const entries = groupActivity([said('a'), tool('b', 'Ran skill-sync'), said('c')], {
      ended: false
    })
    const run = entries[1]!
    expect(run.kind === 'activity' && run.closed).toBe(false)
    expect(run.kind === 'activity' && run.label).toBe(ACTIVITY_WORKING_LABEL)
  })

  it('closes once the dwarf speaks after the person, as it would have without them', () => {
    const entries = groupActivity([tool('a', 'Ran one'), said('b'), spoken('c', 'Done.')], {
      ended: false
    })
    expect(entries[0]!.kind === 'activity' && entries[0]!.closed).toBe(true)
  })

  it('closes when the turn is over, however the conversation ends', () => {
    const entries = groupActivity([tool('a', 'Ran one'), said('b')], { ended: true })
    expect(entries[0]!.kind === 'activity' && entries[0]!.closed).toBe(true)
  })

  it('leaves only the last run open, even with the person between two runs', () => {
    const entries = groupActivity([tool('a', 'Ran one'), said('b'), tool('c', 'Ran two')], {
      ended: false
    })
    const closed = entries.flatMap((entry) => (entry.kind === 'activity' ? [entry.closed] : []))
    expect(closed).toEqual([true, false])
  })
})

/*
 * The run the turn outcome line counts (#635; decision log, Turn outcome line): the last run with
 * nothing the dwarf said after it, the person's own words skipped as they are for closing one.
 */
describe('countedRunSteps', () => {
  const said = (key: string): PanelMessage => ({ from: 'user', text: 'Go on.', key })

  it('counts the last run’s steps when nothing follows it', () => {
    const entries = groupActivity([spoken('a'), tool('b', 'Ran one'), tool('c', 'Ran two')], {
      ended: false
    })
    expect(countedRunSteps(entries)).toBe(2)
  })

  it('counts it past the person’s own messages', () => {
    const entries = groupActivity([tool('a', 'Ran one'), said('b'), said('c')], { ended: false })
    expect(countedRunSteps(entries)).toBe(1)
  })

  it('counts nothing once the dwarf has spoken after its last run', () => {
    const entries = groupActivity([tool('a', 'Ran one'), spoken('b'), said('c')], { ended: false })
    expect(countedRunSteps(entries)).toBeUndefined()
  })

  it('counts nothing in a conversation with no run at all', () => {
    expect(countedRunSteps(groupActivity([said('a'), spoken('b')], { ended: false }))).toBe(
      undefined
    )
    expect(countedRunSteps([])).toBeUndefined()
  })
})

/*
 * Whether a run can still grow is whether the dwarf's turn is still going (#635; components.md,
 * Activity disclosure, As built: "the dwarf working, the session not ended"). An ask is part of
 * the same turn (MESSAGE-QUESTIONS 12), so a dwarf asking keeps its run open; a resting or leaving
 * dwarf is not adding steps, so its last run is a finished stretch of work.
 */
describe('runsHaveEnded', () => {
  // AMENDED for #635 (MESSAGE-QUESTIONS 12; was: 'keeps the last run growing only while the dwarf
  // works'): an asking dwarf's run keeps growing too.
  it('keeps the last run growing while the dwarf works or asks', () => {
    expect(runsHaveEnded(defaultDwarf({ status: 'working' }))).toBe(false)
    expect(runsHaveEnded(defaultDwarf({ status: 'working', waitingReason: 'approval' }))).toBe(
      false
    )
    expect(
      runsHaveEnded(
        defaultDwarf({
          status: 'waiting',
          waitingReason: 'user-input',
          pendingQuestion: { toolUseId: 't', channel: 'terminal', questions: [] }
        })
      )
    ).toBe(false)
  })

  // AMENDED for #635 (MESSAGE-QUESTIONS 12; was: 'ends it once the turn is over, the session is
  // leaving, or the dwarf asks', with an asking dwarf's run ended): an ask no longer ends it.
  it('ends it once the turn is over or the session is leaving', () => {
    expect(runsHaveEnded(defaultDwarf({ status: 'waiting' }))).toBe(true)
    expect(runsHaveEnded(defaultDwarf({ status: 'leaving' }))).toBe(true)
  })
})

/*
 * A finished turn counts every step it took (#635; MESSAGE-QUESTIONS 11): all its runs since the
 * person's last message, whether or not the dwarf spoke after them. While the dwarf works the
 * count stays the open run's (countedRunSteps).
 */
describe('turnSteps', () => {
  const said = (key: string): PanelMessage => ({ from: 'user', text: 'Go on.', key })

  it('counts every run since the person’s last message, past the dwarf’s own replies', () => {
    const entries = groupActivity(
      [
        said('a'),
        tool('b', 'Ran one'),
        tool('c', 'Ran two'),
        spoken('d', 'Halfway.'),
        tool('e', 'Ran three'),
        spoken('f', 'Done.')
      ],
      { ended: true }
    )
    expect(turnSteps(entries)).toBe(3)
  })

  it('stops at the person’s last message, so an earlier turn’s steps are not this one’s', () => {
    const entries = groupActivity(
      [tool('a', 'Ran old'), said('b'), tool('c', 'Ran new'), spoken('d', 'Done.')],
      { ended: true }
    )
    expect(turnSteps(entries)).toBe(1)
  })

  it('counts a turn the person never started from here, from the top of what was read', () => {
    const entries = groupActivity([tool('a', 'Ran one'), tool('b', 'Ran two'), spoken('c')], {
      ended: true
    })
    expect(turnSteps(entries)).toBe(2)
  })

  it('counts nothing for a turn that took no step', () => {
    expect(turnSteps(groupActivity([said('a'), spoken('b')], { ended: true }))).toBeUndefined()
    expect(turnSteps([])).toBeUndefined()
  })
})

describe('outcomeSteps', () => {
  const said = (key: string): PanelMessage => ({ from: 'user', text: 'Go on.', key })
  const rows = [said('a'), tool('b', 'Ran one'), spoken('c', 'Halfway.'), tool('d', 'Ran two')]

  it('counts the open run while the dwarf works, and the whole turn once it has finished', () => {
    expect(outcomeSteps(groupActivity(rows, { ended: false }), true)).toBe(1)
    expect(outcomeSteps(groupActivity(rows, { ended: true }), false)).toBe(2)
  })
})
