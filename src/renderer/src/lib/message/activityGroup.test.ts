import { describe, expect, it } from 'vitest'
import type { FeedActivityKind } from '../../types'
import type { PanelMessage } from './conversation'
import { ACTIVITY_WORKING_LABEL, groupActivity } from './activityGroup'

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
