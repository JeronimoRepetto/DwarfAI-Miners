import { describe, expect, it, vi } from 'vitest'
import { MATERIAL_TOKENS_PER_UNIT } from '../types'
import { MAP_SPAWN_POINTS } from '../lib/map/spawnPoints.generated'
import { adaptSample, silenceMs, swapSample } from './sample'

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

  /*
   * ADDED for #635 (PR3): an asking dwarf's questions are what makes it need you in the app.
   * AMENDED for #635 (the question card slice; was: the ask on the 'terminal' channel, and a
   * permission carried as no prompt at all). The sample's asks are ones the card can answer, so
   * they ride the held channel, the one on which every question of a walk is answerable; and a
   * permission is the app's pendingPermission, its request split at the sample's own " · " into
   * the tool and the input (next test).
   */
  it('carries an asking dwarf’s questions as its pending question, and a permission as none', () => {
    const question = [{ text: 'Which database?', options: ['Postgres', 'SQLite'] }]
    const sample = adaptSample(
      dm({
        mines: [shaft],
        dwarfs: [
          { ...digger, id: 'q', status: 'asking', question },
          // AMENDED for #635 (was: the question above): a request has the tool before " · ".
          {
            ...digger,
            id: 'p',
            status: 'asking',
            need: 'permission',
            question: [{ text: 'Bash · ls' }]
          }
        ]
      })
    )
    const [q, p] = sample.mines[0]?.dwarfs ?? []
    expect(q?.pendingQuestion).toEqual({
      toolUseId: 'q',
      channel: 'held',
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

  // ADDED for #635 (the question card slice): the permission card's request, and its long one.
  it('carries a permission need as the pending permission its request names', () => {
    const question = [{ text: 'Bash · pnpm install in feat/x. It changes the lockfile.' }]
    const sample = adaptSample(
      dm({
        mines: [shaft],
        dwarfs: [{ ...digger, id: 'p', status: 'asking', need: 'permission', question }],
        longPermissionRequest: [{ text: 'Bash · a very long command' }]
      })
    )
    expect(sample.mines[0]?.dwarfs[0]?.pendingPermission).toEqual({
      toolUseId: 'p',
      toolName: 'Bash',
      input: 'pnpm install in feat/x. It changes the lockfile.',
      channel: 'held',
      askedAt: expect.any(String)
    })
    expect(sample.longPermissionRequest).toMatchObject({
      toolName: 'Bash',
      input: 'a very long command'
    })
    expect(() =>
      adaptSample(
        dm({
          mines: [shaft],
          dwarfs: [{ ...digger, status: 'asking', need: 'permission', question: [{ text: 'x' }] }]
        })
      )
    ).toThrow(/request "x"/)
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

/*
 * APPENDED (#635, PR5): what the Settings page reads from the sample — the version About prints,
 * the edge the panel docks to, and the providers the default launch lists, each with the models
 * and efforts its catalogue answers.
 */
describe('adaptSample — the Settings page', () => {
  const provider = { id: 'codex', label: 'Codex', models: ['m-large'], efforts: ['low'] }

  it('reads the version and the edge from the config, leaving the flags as they were', () => {
    const sample = adaptSample(
      dm({ config: { shortcutFailed: false, guildEnabled: false, version: '9.9.9', dock: 'left' } })
    )
    expect(sample.version).toBe('9.9.9')
    expect(sample.edge).toBe('left')
    expect(sample.config).toEqual({ shortcutFailed: false, guildEnabled: false })
  })

  it('reads a panel with no edge in the config as docked right, the default', () => {
    expect(adaptSample(dm({})).edge).toBe('right')
  })

  it('turns each provider into a launchable option and its catalogue, in the sample order', () => {
    const sample = adaptSample(dm({ providers: [provider, { ...provider, id: 'claude' }] }))
    expect(sample.providers).toEqual([
      { provider: 'codex', installed: true, launchable: true },
      { provider: 'claude', installed: true, launchable: true }
    ])
    expect(sample.catalogs[0]).toEqual({
      provider: 'codex',
      models: [{ value: 'm-large' }],
      efforts: ['low'],
      source: 'provider'
    })
  })

  it('throws on a provider the app has no word for', () => {
    expect(() => adaptSample(dm({ providers: [{ ...provider, id: 'wizard' }] }))).toThrow(
      /provider "wizard"/
    )
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

/*
 * APPENDED (#635, full-screen goldens): the full App reads its Mines page from a project browse,
 * not from a kit tree, so the sample's mines are also the remembered projects that browse answers.
 */
describe('adaptSample projects', () => {
  it('remembers every mine as a project, last opened in the order recentMines gives, newest first', () => {
    const sample = adaptSample(
      dm({
        mines: [shaft, { ...shaft, id: 'south-shaft', name: 'South-Shaft' }],
        recentMines: ['south-shaft', 'north-shaft']
      })
    )
    const [north, south] = sample.projects
    expect(sample.projects.map((p) => [p.id, p.path, p.name, p.declared, p.live])).toEqual([
      ['north-shaft', 'north-shaft', 'North-Shaft', true, true],
      ['south-shaft', 'south-shaft', 'South-Shaft', true, true]
    ])
    expect(south!.lastOpenedAt).toBeGreaterThan(north!.lastOpenedAt!)
  })

  it('leaves a mine recentMines never names without an opening, rather than inventing one', () => {
    const sample = adaptSample(dm({ mines: [shaft], recentMines: [] }))
    expect(sample.projects[0]).not.toHaveProperty('lastOpenedAt')
  })

  // AMENDED for #635 (PANEL-QUESTIONS 29, design lead ruling 2026-09-27). This read every
  // measuring mine as neither a tier nor a weight, which is how the sample's re-measured
  // ore-ledger lost its Copper. Only `measured: false` is a mine no walk has read; any other
  // measuring mine keeps its earlier reading's tier, with no weight yet, as the app knows one.
  it('reads a measured mine as its tier and its score in kilobytes, a re-measured one as its tier alone, and a never-measured one as neither', () => {
    const sample = adaptSample(
      dm({
        mines: [
          { ...shaft, score: 212 },
          { ...shaft, id: 'x', state: 'measuring', score: 40 },
          { ...shaft, id: 'y', state: 'measuring', score: 0, measured: false }
        ]
      })
    )
    const [measured, again, never] = sample.projects
    expect([measured!.knownTier, measured!.weightBytes]).toEqual(['copper', 212 * 1024])
    expect(again!.knownTier).toBe('copper')
    expect(again).not.toHaveProperty('weightBytes')
    expect(never).not.toHaveProperty('knownTier')
    expect(never).not.toHaveProperty('weightBytes')
  })

  it('carries the ore the ledger holds, none for a mine not recorded yet, and a missing folder', () => {
    const sample = adaptSample(
      dm({
        mines: [
          { ...shaft, ore: { coal: 2 } },
          { ...shaft, id: 'y', state: 'unrecorded', ore: { coal: 1 } },
          { ...shaft, id: 'z', state: 'unenterable' }
        ]
      })
    )
    const [recorded, unrecorded, missing] = sample.projects
    expect(recorded!.materials).toEqual(sample.mines[0]!.materials)
    expect(unrecorded).not.toHaveProperty('materials')
    expect(missing!.folderMissing).toBe(true)
    expect(recorded).not.toHaveProperty('folderMissing')
  })

  it('stands each project where its mine stands on the map', () => {
    const point = MAP_SPAWN_POINTS[0]!
    const sample = adaptSample(dm({ mines: [{ ...shaft, site: { x: point.x, y: point.y } }] }))
    expect(sample.projects[0]!.mapSite).toBe(point.id)
  })
})

/*
 * APPENDED for #635 (PANEL-QUESTIONS 25, PO ruling 2026-09-27): the sample names the view the app
 * remembers (`DM.data.launch`), the one the references show as the screen opens; the first-run
 * sample remembers nothing.
 */
describe('adaptSample — the remembered launch', () => {
  it('reads the remembered page and mine as the view main would have stored', () => {
    const sample = adaptSample(dm({ launch: { page: 'mines', mine: 'north-shaft' } }))
    expect(sample.launch).toEqual({ area: 'mines', mineId: 'north-shaft' })
  })

  it("keeps a remembered mine the sample does not carry: whether it opens is the app's to decide", () => {
    const sample = adaptSample(dm({ mines: [shaft], launch: { page: 'map', mine: 'gone-shaft' } }))
    expect(sample.launch).toEqual({ area: 'map', mineId: 'gone-shaft' })
  })

  it('reads a page with no mine open', () => {
    const sample = adaptSample(dm({ launch: { page: 'settings', mine: null } }))
    expect(sample.launch).toEqual({ area: 'settings', mineId: null })
  })

  it('remembers nothing when the sample names no launch, as the first-run sample does', () => {
    expect(adaptSample(dm({ launch: null }))).not.toHaveProperty('launch')
    expect(adaptSample(dm({}))).not.toHaveProperty('launch')
  })

  it('refuses a page the app has no area for, naming it', () => {
    expect(() => adaptSample(dm({ launch: { page: 'vault', mine: null } }))).toThrow(/page "vault"/)
  })
})

describe('swapSample — a prototype sample switch under a running app', () => {
  it('keeps the launch the screen opened with: the switch swaps the data, it relaunches nothing', () => {
    const booted = adaptSample(
      dm({ mines: [shaft], launch: { page: 'mines', mine: 'north-shaft' } })
    )
    const firstRun = adaptSample(dm({ launch: null }))
    const swapped = swapSample(booted, firstRun)
    expect(swapped.mines).toEqual([])
    expect(swapped.launch).toEqual({ area: 'mines', mineId: 'north-shaft' })
  })

  it('remembers nothing after the switch when the screen opened remembering nothing', () => {
    const swapped = swapSample(adaptSample(dm({})), adaptSample(dm({ mines: [shaft] })))
    expect(swapped).not.toHaveProperty('launch')
    expect(swapped.mines).toHaveLength(1)
  })
})

/*
 * APPENDED (#635, the MessagePanel slice): the MessagePanel reads one dwarf's conversation as the
 * feed main answers for it, so every dwarf with something said has the same messages its history
 * speaker carries, readable, by dwarf id. A dwarf with nothing said has an empty readable feed.
 */
describe('adaptSample feeds', () => {
  it("answers each dwarf's conversation as its feed, the messages its history speaker holds", () => {
    const talker = {
      ...digger,
      conversation: [
        { from: 'user', md: 'Dig here.', mark: 'reacted', time: '09:02' },
        { from: 'dwarf', md: 'Done.', time: '09:07' }
      ]
    }
    const sample = adaptSample(dm({ mines: [shaft], dwarfs: [talker] }))
    const speaker = sample.histories['north-shaft']!.speakers[0]!
    expect(sample.feeds.a1).toEqual({ readable: true, messages: speaker.messages })
  })

  it('answers a dwarf with nothing said with an empty readable feed', () => {
    const sample = adaptSample(dm({ mines: [shaft], dwarfs: [digger] }))
    expect(sample.feeds.a1).toEqual({ readable: true, messages: [] })
  })
})

/*
 * APPENDED (#635, the MessagePanel slice): the prototype's chat takes a message and a file from any
 * dwarf, so each sample dwarf is a session the panel can write to, attach to and stop, on the
 * console channel the app's own terminal-held sessions use. The day of the conversation is the
 * one the page is on, as the prototype's is always today.
 */
describe('adaptSample, the dwarfs the MessagePanel talks to', () => {
  it('gives each dwarf the console channel for words, files and a stop', () => {
    const [dwarf] = adaptSample(dm({ mines: [shaft], dwarfs: [digger] })).mines[0]!.dwarfs
    expect(dwarf!.textDelivery).toBe('terminal')
    expect(dwarf!.capabilities).toEqual({
      sendText: 'terminal',
      cancel: 'terminal',
      adjustEffort: null,
      attach: 'terminal'
    })
  })

  it('dates the conversation on the day the page is on', () => {
    // A fixed day, as the design's capture runtime fixes the page's clock.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 0, 15, 10, 30))
    try {
      const talker = { ...digger, conversation: [{ from: 'dwarf', md: 'Done.', time: '09:07' }] }
      const [message] = adaptSample(dm({ mines: [shaft], dwarfs: [talker] })).feeds.a1!.messages
      const said = new Date(message!.timestamp)
      expect([said.getFullYear(), said.getMonth(), said.getDate(), said.getHours()]).toEqual([
        2026, 0, 15, 9
      ])
    } finally {
      vi.useRealTimers()
    }
  })
})
