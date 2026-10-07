import { describe, expect, it } from 'vitest'
import type { MineId } from '@dwarfai/contracts'
import { DEFAULT_TOGGLE_ACCELERATOR } from '../../../shared/accelerator'
import { MATERIAL_TOKENS_PER_UNIT } from '../types'
import { goldenApi } from './api'
import { adaptSample } from './sample'

/*
 * The bridge the full App is mounted on in a full-screen golden (#635): main's answers, given from
 * the design's sample instead of a machine. What is pinned here is what App reads to reach a
 * screen's state, over small objects written for this test in the sample's shape.
 */

const shaft = { id: 'north-shaft', name: 'North-Shaft', tier: 'copper', state: 'active', ore: {} }

function sampleOf(data: Record<string, unknown> = {}) {
  return adaptSample({
    data: {
      config: { shortcutFailed: false, guildEnabled: false, version: '9.9.9', dock: 'right' },
      mines: [],
      dwarfs: [],
      ...data
    }
  })
}

describe('goldenApi — the board', () => {
  it('answers the sample mines, and the vault as each material summed on its own', async () => {
    const sample = sampleOf({
      mines: [
        { ...shaft, ore: { coal: 2 } },
        { ...shaft, id: 'south-shaft', ore: { coal: 1, gold: 1 } }
      ]
    })
    const snapshot = await goldenApi(sample).getMines()
    expect(snapshot.mines.map((m) => m.id)).toEqual(['north-shaft', 'south-shaft'])
    expect(snapshot.materials).toMatchObject({
      coal: 3 * MATERIAL_TOKENS_PER_UNIT.coal,
      gold: MATERIAL_TOKENS_PER_UNIT.gold,
      silver: 0
    })
  })

  it('answers an empty board with an empty vault', async () => {
    const snapshot = await goldenApi(sampleOf()).getMines()
    expect(snapshot.mines).toEqual([])
    expect(snapshot.tokensObserved).toBe(0)
  })

  // AMENDED for ISSUE-123 (was: "reads a mine's history from its dwarfs' conversations", answering the sample's
  // history in today's shape): from the cut-1 switch A-19 reads the Host's message log, keyed by Host ids the sample
  // does not carry, so the full-screen bridge refuses it by name like every member it does not model.
  it("refuses a mine's history by name, since A-19 reads the Host's message log", async () => {
    const sample = sampleOf({ mines: [shaft] })
    await expect(goldenApi(sample).getMineHistory('north-shaft' as MineId)).rejects.toThrow(
      /getMineHistory/
    )
  })
})

describe('goldenApi — the project browse', () => {
  const mines = [
    { ...shaft, id: 'a', name: 'Alpha', tier: 'gold' },
    { ...shaft, id: 'b', name: 'Beta' },
    { ...shaft, id: 'c', name: 'Gamma' }
  ]
  const api = goldenApi(sampleOf({ mines, recentMines: ['b', 'a'] }))

  it('pages the projects last opened first, the never opened after them', async () => {
    const all = await api.queryProjects({ sortBy: 'lastOpenedAt', direction: 'desc' })
    expect(all.answered).toBe(true)
    expect(all.projects.map((p) => p.id)).toEqual(['b', 'a', 'c'])
    const page = await api.queryProjects({
      sortBy: 'lastOpenedAt',
      direction: 'desc',
      limit: 1,
      offset: 1
    })
    expect(page.projects.map((p) => p.id)).toEqual(['a'])
  })

  it('filters by tier and by a name fragment, ignoring case', async () => {
    const query = { sortBy: 'lastOpenedAt', direction: 'desc' } as const
    expect((await api.queryProjects({ ...query, tier: 'gold' })).projects.map((p) => p.id)).toEqual(
      ['a']
    )
    expect(
      (await api.queryProjects({ ...query, nameContains: 'MM' })).projects.map((p) => p.id)
    ).toEqual(['c'])
  })

  it('refuses an order it does not know, rather than answering in the wrong one', async () => {
    await expect(api.queryProjects({ sortBy: 'addedAt', direction: 'asc' })).rejects.toThrow(
      /addedAt asc/
    )
  })
})

describe('goldenApi — the window and the app', () => {
  it('is the Panel docked to the sample edge with nothing beside its page, shown', async () => {
    const api = goldenApi(sampleOf({ config: { dock: 'left' } }))
    expect(await api.getPanelLayout()).toEqual({ edge: 'left', mineOpen: false, dockOpen: false })
    expect(await api.getPanelVisible()).toBe(true)
  })

  it('gives the window the layout it asks for, on the edge it already has unless it names one', async () => {
    const api = goldenApi(sampleOf())
    expect(await api.setPanelLayout({ mineOpen: true, dockOpen: false })).toEqual({
      edge: 'right',
      mineOpen: true,
      dockOpen: false
    })
    expect(await api.setPanelLayout({ mineOpen: false, dockOpen: false, edge: 'left' })).toEqual({
      edge: 'left',
      mineOpen: false,
      dockOpen: false
    })
    expect((await api.getPanelLayout()).edge).toBe('left')
  })

  it('reports the sample version, its guild flag and the default shortcut as it registered', async () => {
    const api = goldenApi(
      sampleOf({ config: { version: '1.0.0', guildEnabled: true, shortcutFailed: true } })
    )
    expect(await api.getAppBuild()).toEqual({ version: '1.0.0', packaged: true })
    expect(await api.getFeatureFlags()).toEqual({ guildAreasEnabled: true })
    expect(await api.getToggleShortcut()).toEqual({
      accelerator: DEFAULT_TOGGLE_ACCELERATOR,
      registered: false,
      platform: 'win32'
    })
  })

  it('lists the sample providers and their catalogues', async () => {
    const provider = { id: 'codex', label: 'Codex', models: ['m-large'], efforts: ['low'] }
    const sample = sampleOf({ providers: [provider] })
    const api = goldenApi(sample)
    expect(await api.listAgentProviders()).toEqual({ providers: sample.providers })
    expect(await api.listAgentModels()).toEqual({ catalogs: sample.catalogs })
  })
})

/*
 * APPENDED for #635 (PANEL-QUESTIONS 25): the stored view is the sample's remembered launch, so a
 * state with no steps opens where the references open; with nothing remembered it is main's
 * first-run answer, the Map with no mine open.
 */
describe('goldenApi — the launch view', () => {
  it("answers the sample's remembered launch as the stored view", async () => {
    const api = goldenApi(sampleOf({ launch: { page: 'mines', mine: 'north-shaft' } }))
    expect(await api.getLaunchView()).toEqual({ area: 'mines', mineId: 'north-shaft' })
  })

  it('answers the default view when the sample remembers nothing', async () => {
    const api = goldenApi(sampleOf({ launch: null }))
    expect(await api.getLaunchView()).toEqual({ area: 'map', mineId: null })
  })

  it('takes a reported view and changes nothing it answers: a golden never relaunches', async () => {
    const api = goldenApi(sampleOf({ launch: { page: 'mines', mine: null } }))
    api.setLaunchView({ area: 'settings', mineId: null })
    expect(await api.getLaunchView()).toEqual({ area: 'mines', mineId: null })
  })
})

/*
 * APPENDED (#635, the MessagePanel slice): a full-screen MessagePanel state reads the open dwarf's
 * conversation, so the bridge answers each dwarf's feed from the sample, and refuses a dwarf the
 * sample does not carry rather than answering it with a guess.
 */
describe('goldenApi — a dwarf feed', () => {
  const talker = {
    id: 'a1',
    name: 'digger-1',
    mine: 'north-shaft',
    role: 'worker',
    provider: 'Claude',
    status: 'working',
    conversation: [{ from: 'dwarf', md: 'Done.', time: '09:07' }]
  }

  it("answers the dwarf's feed from the sample", async () => {
    const sample = sampleOf({ mines: [shaft], dwarfs: [talker] })
    expect(await goldenApi(sample).getDwarfFeed('a1')).toEqual(sample.feeds.a1)
  })

  it('refuses a dwarf the sample does not carry', async () => {
    await expect(goldenApi(sampleOf()).getDwarfFeed('nobody')).rejects.toThrow(/nobody/)
  })
})
