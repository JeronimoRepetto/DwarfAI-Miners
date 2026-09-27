import { describe, expect, it } from 'vitest'
import { defaultDwarf, defaultMine } from '../../testing/factories'
import type { Dwarf, DwarfPermissionRequest, DwarfQuestion, Mine, TurnOutcome } from '../../types'
import { createAttentionWatch } from './attentionCues'

function question(toolUseId: string): DwarfQuestion {
  return {
    toolUseId,
    channel: 'held',
    questions: [{ question: 'Which one?', header: 'Pick', multiSelect: false, options: [] }]
  } as DwarfQuestion
}

function permission(toolUseId: string): DwarfPermissionRequest {
  return {
    toolUseId,
    toolName: 'Bash',
    input: 'ls',
    channel: 'held',
    askedAt: '2026-09-27T10:00:00.000Z'
  }
}

function turn(endedAt: number, kind: TurnOutcome['kind'] = 'concluded'): TurnOutcome {
  return { kind, endedAt }
}

function mines(...dwarfs: Dwarf[]): Mine[] {
  return [defaultMine({ dwarfs })]
}

describe('createAttentionWatch (#635)', () => {
  it('plays nothing for what was already pending when the app started', () => {
    const watch = createAttentionWatch()
    expect(
      watch.observe(
        mines(
          defaultDwarf({
            id: 'a',
            pendingQuestion: question('q1'),
            pendingPermission: permission('p1'),
            lastTurn: turn(100)
          })
        )
      )
    ).toEqual([])
  })

  it('cues a question when one begins, and not again while it merely re-polls', () => {
    const watch = createAttentionWatch()
    watch.observe(mines(defaultDwarf({ id: 'a' })))
    expect(
      watch.observe(mines(defaultDwarf({ id: 'a', pendingQuestion: question('q1') })))
    ).toEqual(['question'])
    expect(
      watch.observe(mines(defaultDwarf({ id: 'a', pendingQuestion: question('q1') })))
    ).toEqual([])
  })

  it('cues a new question that replaces an answered one on the same poll', () => {
    const watch = createAttentionWatch()
    watch.observe(mines(defaultDwarf({ id: 'a', pendingQuestion: question('q1') })))
    expect(
      watch.observe(mines(defaultDwarf({ id: 'a', pendingQuestion: question('q2') })))
    ).toEqual(['question'])
  })

  it('cues a permission when one begins, once', () => {
    const watch = createAttentionWatch()
    watch.observe(mines(defaultDwarf({ id: 'a' })))
    const asking = mines(defaultDwarf({ id: 'a', pendingPermission: permission('p1') }))
    expect(watch.observe(asking)).toEqual(['permission'])
    expect(watch.observe(asking)).toEqual([])
  })

  it('cues again when the same dwarf asks again after being answered', () => {
    const watch = createAttentionWatch()
    watch.observe(mines(defaultDwarf({ id: 'a', pendingPermission: permission('p1') })))
    watch.observe(mines(defaultDwarf({ id: 'a' })))
    expect(
      watch.observe(mines(defaultDwarf({ id: 'a', pendingPermission: permission('p2') })))
    ).toEqual(['permission'])
  })

  it('cues a finished turn when a new one ends, read off lastTurn and nothing else', () => {
    const watch = createAttentionWatch()
    watch.observe(mines(defaultDwarf({ id: 'a', status: 'working' })))
    // Going idle is a silence this app measured, not the provider saying the
    // turn ended — so it cues nothing.
    expect(watch.observe(mines(defaultDwarf({ id: 'a', status: 'waiting' })))).toEqual([])
    expect(watch.observe(mines(defaultDwarf({ id: 'a', lastTurn: turn(200) })))).toEqual([
      'finished'
    ])
    expect(watch.observe(mines(defaultDwarf({ id: 'a', lastTurn: turn(200) })))).toEqual([])
    expect(watch.observe(mines(defaultDwarf({ id: 'a', lastTurn: turn(300, 'errored') })))).toEqual(
      ['finished']
    )
  })

  it('cues a dwarf that arrives already asking, since its arrival is the beginning', () => {
    const watch = createAttentionWatch()
    watch.observe(mines())
    expect(
      watch.observe(mines(defaultDwarf({ id: 'b', pendingQuestion: question('q1') })))
    ).toEqual(['question'])
  })

  it('answers each kind once per poll however many dwarfs began it, in one fixed order', () => {
    const watch = createAttentionWatch()
    watch.observe([defaultMine({ id: 'm1' }), defaultMine({ id: 'm2' })])
    expect(
      watch.observe([
        defaultMine({
          id: 'm1',
          dwarfs: [
            defaultDwarf({ id: 'a', lastTurn: turn(1) }),
            defaultDwarf({ id: 'b', pendingQuestion: question('q1') })
          ]
        }),
        defaultMine({
          id: 'm2',
          dwarfs: [
            defaultDwarf({ id: 'c', pendingQuestion: question('q2') }),
            defaultDwarf({ id: 'd', pendingPermission: permission('p1') })
          ]
        })
      ])
    ).toEqual(['question', 'permission', 'finished'])
  })

  it('forgets a dwarf that left, so its return is judged afresh', () => {
    const watch = createAttentionWatch()
    watch.observe(mines(defaultDwarf({ id: 'a', pendingQuestion: question('q1') })))
    watch.observe(mines())
    expect(
      watch.observe(mines(defaultDwarf({ id: 'a', pendingQuestion: question('q1') })))
    ).toEqual(['question'])
  })
})
