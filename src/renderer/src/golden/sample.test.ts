import { describe, expect, it } from 'vitest'
import { MATERIAL_TOKENS_PER_UNIT } from '../types'
import { MAP_SPAWN_POINTS } from '../lib/map/spawnPoints.generated'
import { adaptSample, silenceMs } from './sample'

/*
 * The golden page reads the design's sample data at run time and adapts it to the app's own
 * contract types (#634); the data never enters this repository. What is pinned here is the
 * mapping alone, over small objects written for this test in the sample's shape, not copies of
 * the design's sample.
 */

function dm(data: Record<string, unknown>): unknown {
  return {
    data: {
      config: { shortcutFailed: false, guildEnabled: false },
      mines: [],
      dwarfs: [],
      ...data
    }
  }
}

const shaft = { id: 'north-shaft', name: 'North-Shaft', tier: 'copper', state: 'active', ore: {} }
const digger = {
  id: 'a1',
  name: 'digger-1',
  mine: 'north-shaft',
  role: 'worker',
  provider: 'Claude',
  model: 'm-large',
  effort: 'high',
  status: 'working',
  silence: '2m',
  worktree: 'feat/example'
}

describe('adaptSample', () => {
  it('reads the flags the panel shows from the config', () => {
    const sample = adaptSample(dm({ config: { shortcutFailed: true, guildEnabled: true } }))
    expect(sample.config).toEqual({ shortcutFailed: true, guildEnabled: true })
  })

  it('turns each mine into a Mine carrying its own dwarfs', () => {
    const other = { ...digger, id: 'b2', name: 'digger-2', mine: 'south-shaft' }
    const sample = adaptSample(
      dm({
        mines: [shaft, { ...shaft, id: 'south-shaft', name: 'South-Shaft' }],
        dwarfs: [digger, other]
      })
    )
    expect(sample.mines.map((m) => [m.id, m.name, m.tier, m.dwarfs.map((d) => d.id)])).toEqual([
      ['north-shaft', 'North-Shaft', 'copper', ['a1']],
      ['south-shaft', 'South-Shaft', 'copper', ['b2']]
    ])
  })

  it('stores ore as tokens per material, each through its own grain size and never summed', () => {
    const sample = adaptSample(dm({ mines: [{ ...shaft, ore: { coal: 4, silver: 2 } }] }))
    expect(sample.mines[0]?.materials).toEqual({
      coal: 4 * MATERIAL_TOKENS_PER_UNIT.coal,
      bronze: 0,
      copper: 0,
      silver: 2 * MATERIAL_TOKENS_PER_UNIT.silver,
      gold: 0,
      uranium: 0
    })
  })

  it('marks a mine that was never measured as unrecorded, and no other', () => {
    const sample = adaptSample(
      dm({
        mines: [
          { ...shaft, state: 'unrecorded' },
          { ...shaft, id: 'x', state: 'measuring' }
        ]
      })
    )
    expect(sample.mines.map((m) => m.unrecorded)).toEqual([true, undefined])
  })

  it('maps a dwarf onto the wire shape: provider id, role, model, silence and branch', () => {
    const [d] = adaptSample(dm({ mines: [shaft], dwarfs: [digger] })).mines[0]?.dwarfs ?? []
    expect(d).toMatchObject({
      id: 'a1',
      sessionId: 'a1',
      name: 'digger-1',
      provider: 'claude',
      role: 'worker',
      model: 'm-large',
      effort: 'high',
      status: 'working',
      silentForMs: 120_000,
      workplace: { path: 'north-shaft', branch: 'feat/example' }
    })
    expect(d?.waitingReason).toBeUndefined()
  })

  it('reads asking as waiting on the user, a permission need as waiting on approval, asleep as resting', () => {
    const sample = adaptSample(
      dm({
        mines: [shaft],
        dwarfs: [
          { ...digger, id: 'q', status: 'asking' },
          { ...digger, id: 'p', status: 'asking', need: 'permission' },
          { ...digger, id: 's', status: 'asleep' }
        ]
      })
    )
    expect(sample.mines[0]?.dwarfs.map((d) => [d.id, d.status, d.waitingReason ?? null])).toEqual([
      ['q', 'waiting', 'user-input'],
      ['p', 'waiting', 'approval'],
      ['s', 'waiting', null]
    ])
  })

  it('fails naming the value when the sample holds one the app has no word for', () => {
    expect(() =>
      adaptSample(dm({ mines: [shaft], dwarfs: [{ ...digger, provider: 'Nobody' }] }))
    ).toThrow(/provider "Nobody"/)
    expect(() =>
      adaptSample(dm({ mines: [shaft], dwarfs: [{ ...digger, status: 'dancing' }] }))
    ).toThrow(/status "dancing"/)
    expect(() => adaptSample(dm({ mines: [{ ...shaft, tier: 'tin' }] }))).toThrow(/tier "tin"/)
    expect(() => adaptSample(dm({ mines: [{ ...shaft, ore: { tin: 1 } }] }))).toThrow(
      /material "tin"/
    )
    expect(() =>
      adaptSample(dm({ mines: [shaft], dwarfs: [{ ...digger, mine: 'gone' }] }))
    ).toThrow(/mine "gone"/)
  })

  /*
   * ADDED for #635 (PR3). The sample's sites are the product's own measured spawn points, in
   * percent of the painting; a mine stands on the one whose point it names, as main's store would
   * remember it. A site that is no spawn point is a sample the app cannot draw.
   */
  it('stands each mine on the spawn point its site names', () => {
    const point = MAP_SPAWN_POINTS[12]!
    const sample = adaptSample(dm({ mines: [{ ...shaft, site: { x: point.x, y: point.y } }] }))
    expect(sample.mines[0]?.mapSite).toBe(point.id)
    expect(adaptSample(dm({ mines: [shaft] })).mines[0]?.mapSite).toBeUndefined()
    expect(() => adaptSample(dm({ mines: [{ ...shaft, site: { x: 1, y: 1 } }] }))).toThrow(
      /site \{"x":1,"y":1\}/
    )
  })

  // ADDED for #635 (PR3): an asking dwarf's questions are what makes it need you in the app.
  it('carries an asking dwarf’s questions as its pending question, and a permission as none', () => {
    const question = [{ text: 'Which database?', options: ['Postgres', 'SQLite'] }]
    const sample = adaptSample(
      dm({
        mines: [shaft],
        dwarfs: [
          { ...digger, id: 'q', status: 'asking', question },
          { ...digger, id: 'p', status: 'asking', need: 'permission', question }
        ]
      })
    )
    const [q, p] = sample.mines[0]?.dwarfs ?? []
    expect(q?.pendingQuestion).toEqual({
      toolUseId: 'q',
      channel: 'terminal',
      questions: [
        {
          question: 'Which database?',
          multiSelect: false,
          options: [{ label: 'Postgres' }, { label: 'SQLite' }]
        }
      ]
    })
    expect(p?.pendingQuestion).toBeUndefined()
  })

  it('fails when the sample script did not define its data', () => {
    expect(() => adaptSample({})).toThrow(/DM\.data/)
    expect(() => adaptSample(undefined)).toThrow(/DM\.data/)
  })
})

describe('silenceMs', () => {
  it('reads seconds, minutes and hours', () => {
    expect(silenceMs('12s')).toBe(12_000)
    expect(silenceMs('6m')).toBe(360_000)
    expect(silenceMs('2h')).toBe(7_200_000)
  })

  it('fails on anything else rather than guessing', () => {
    expect(() => silenceMs('soon')).toThrow(/silence "soon"/)
  })
})

// APPENDED for #635 (PR2): the tier explainer's ranges come from the thresholds it is given, and
// the design's sample carries its own illustrative floors on `DM.TIER_FLOOR`, beside `DM.data`.
describe('adaptSample tier floors', () => {
  it('reads the sample’s tier floors as the app’s threshold shape', () => {
    const sample = adaptSample({
      ...(dm({}) as object),
      TIER_FLOOR: { bronze: 0, copper: 10, silver: 20, gold: 30, uranium: 40 }
    })
    expect(sample.tierThresholds).toEqual({ copperKb: 10, silverKb: 20, goldKb: 30, uraniumKb: 40 })
  })

  it('has none when the sample carries none, rather than inventing any', () => {
    expect(adaptSample(dm({})).tierThresholds).toBeUndefined()
  })
})

/*
 * A mine's history as its transcripts would give it (#635): each dwarf's conversation as the app's
 * own messages, at the sample's clock times of an arbitrary day, its steps as activity rows by
 * their verb. A message the sample marks failed never reached the session's transcript, so it is
 * not in the history; the marks are the history panel's own reading (historyMarks).
 */
describe('adaptSample histories', () => {
  const talker = {
    ...digger,
    conversation: [
      { from: 'user', md: 'Dig here.', mark: 'reacted', time: '09:02' },
      {
        from: 'activity',
        steps: ['Read a.ts', 'Edited b.ts', 'Ran vitest', 'Searched for x', 'Drafted it']
      },
      { from: 'dwarf', md: 'Done.', time: '09:07' },
      { from: 'user', md: 'Never arrived.', mark: 'failed', time: '09:13' }
    ]
  }

  it('reads each conversation as a speaker of its mine, oldest first, a failed message left out', () => {
    const history = adaptSample(dm({ mines: [shaft], dwarfs: [talker] })).histories['north-shaft']!
    expect(history.readable).toBe(true)
    const [speaker] = history.speakers
    expect(speaker).toMatchObject({
      id: 'a1',
      name: 'digger-1',
      role: 'worker',
      provider: 'claude'
    })
    expect(speaker!.messages.map((m) => [m.role, m.text, m.activity?.kind])).toEqual([
      ['user', 'Dig here.', undefined],
      ['assistant', 'Read a.ts', 'read'],
      ['assistant', 'Edited b.ts', 'edit'],
      ['assistant', 'Ran vitest', 'run'],
      ['assistant', 'Searched for x', 'search'],
      ['assistant', 'Drafted it', 'run'],
      ['assistant', 'Done.', undefined]
    ])
    const at = new Date(speaker!.lastMessageAt)
    expect([at.getHours(), at.getMinutes()]).toEqual([9, 7])
  })

  it('draws no speaker for a dwarf with nothing said', () => {
    expect(adaptSample(dm({ mines: [shaft], dwarfs: [digger] })).histories['north-shaft']).toEqual({
      readable: true,
      speakers: []
    })
  })
})

// PANEL-QUESTIONS 16: a message the sample marks failed is the app's own record of the send.
describe('adaptSample failed sends', () => {
  it('keeps each failed message as the app records a send, by mine and dwarf', () => {
    const talker = {
      ...digger,
      conversation: [
        { from: 'user', md: 'Dig here.', mark: 'reacted', time: '09:02' },
        { from: 'user', md: 'Never arrived.', mark: 'failed', time: '09:13' }
      ]
    }
    const failed = adaptSample(dm({ mines: [shaft], dwarfs: [talker] })).failedSends['north-shaft']!
    expect(failed.a1!.map((f) => f.text)).toEqual(['Never arrived.'])
    const at = new Date(failed.a1![0]!.sentAt)
    expect([at.getHours(), at.getMinutes()]).toEqual([9, 13])
  })
})
