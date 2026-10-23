// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type {
  FolderPath,
  HostFrame,
  HostFrames,
  IpcResult,
  MineId,
  MineWire,
  SnapshotPage
} from '@dwarfai/contracts'
import { createFakeWindowApi } from '../../../contracts/ipc/testing/fakeWindowApi'
import MineCard from '../components/browse/MineCard.vue'
import type { ProjectSummary } from '../types'
import { useMines } from './useMines'
import { useMinesPage } from './useMinesPage'

/*
 * The Panel's mine card fed the way the Host feeds it (US-MINE-010, US-MINES-008): the Mines list rows come from
 * `projects:query` → Host `mines.list`, which carries a mine's tier but neither its ore nor its score
 * (`MineSummaryWire`, 14 B-M19; `ui-main/ipc/handlers/minesAdmin.ts` `projectOf`), and the board comes from the
 * snapshot's `mines` section with the `mine.changed` and `ledger.changed` frames (14 §3.5, §3.6). The card reads the
 * ore from the board's `MineWire.totals` and its tier progress from `MineWire.score` (AMENDMENT-26, owner-approved
 * 2026-10-23), never from a list row field nothing sends.
 */

type Api = Window['api']
const EPOCH = 'epoch-1'
const ALPHA = '01920000-0000-7000-8000-00000000a001' as MineId
const BRAVO = '01920000-0000-7000-8000-00000000a002' as MineId

const zero = { tokens: 0 }

function mineWire(id: MineId, name: string, overrides: Partial<MineWire> = {}): MineWire {
  return {
    id,
    path: `/work/${name}` as FolderPath,
    name,
    state: 'active',
    tier: 'silver',
    hasBeenMeasured: true,
    lastUsedAt: 1,
    totals: { coal: zero, bronze: zero, copper: zero, silver: zero, gold: zero, uranium: zero },
    ...overrides
  }
}

/** A list row exactly as `projectOf` builds it from a `MineSummaryWire`. */
function listRow(mine: MineWire): ProjectSummary {
  return {
    id: mine.id,
    path: mine.path,
    name: mine.name,
    declared: false,
    ...(mine.tier === null ? {} : { knownTier: mine.tier }),
    addedAt: 0,
    lastOpenedAt: mine.lastUsedAt,
    live: false
  }
}

function frame<F extends keyof HostFrames>(seq: number, name: F, data: HostFrames[F]): HostFrame {
  return { type: 'evt', seq, epoch: EPOCH, name, data } as HostFrame
}

interface Host {
  push(frames: HostFrame[]): void
}

function installHost(mines: MineWire[]): Host {
  let listener: ((frames: HostFrame[]) => void) | null = null
  const snapshot: IpcResult<SnapshotPage> = {
    ok: true,
    value: {
      snapshotId: 'snap-3',
      seq: 3,
      epoch: EPOCH,
      chunks: [
        { section: 'mines', data: mines },
        { section: 'dwarfs', data: [] }
      ]
    }
  }
  const api = createFakeWindowApi({
    getHostSnapshot: vi.fn(() => Promise.resolve(snapshot)) as unknown as Api['getHostSnapshot'],
    onHostEvent: vi.fn((follow: (frames: HostFrame[]) => void) => {
      listener = follow
      return () => {
        listener = null
      }
    }) as unknown as Api['onHostEvent'],
    queryProjects: vi.fn(() =>
      Promise.resolve({ answered: true, projects: mines.map(listRow) })
    ) as unknown as Api['queryProjects']
  })
  Object.defineProperty(window, 'api', { configurable: true, writable: true, value: api })
  return {
    push(frames) {
      if (listener === null) throw new Error('nothing follows onHostEvent')
      listener(frames)
    }
  }
}

/** The card's progress row, which must be there. */
function progressOf(card: ReturnType<typeof mount>) {
  const progress = card.find('.dm-card__progress')
  expect(progress.exists(), 'the card draws a progress row').toBe(true)
  return progress
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

/** The Panel's Mines page over the Host board, as App.vue composes it. */
async function minesPage(mines: MineWire[]) {
  const host = installHost(mines)
  await useMines().start()
  const page = useMinesPage({ open: () => undefined, mines: () => useMines().state.mines })
  await page.load()
  await settle()
  const card = (id: MineId) => {
    const view = page.mineCards.value.find((candidate) => candidate.id === id)
    if (view === undefined) throw new Error(`no card for ${id}`)
    return mount(MineCard, { props: { card: view } })
  }
  return { host, page, card }
}

beforeEach(() => {
  useMines().stop()
  useMines().clear()
})

afterEach(() => {
  useMines().stop()
  useMines().clear()
})

describe("the Panel's mine card over the Host board", () => {
  it('[US-MINE-010.AC01, US-MINE-010.AC02, INV-93] the card shows one ore capsule per material the board mine holds, never summed', async () => {
    const alpha = mineWire(ALPHA, 'alpha', {
      totals: {
        coal: { tokens: 12_500 },
        bronze: { tokens: 30_000 },
        copper: zero,
        silver: zero,
        gold: zero,
        uranium: zero
      }
    })
    const { card } = await minesPage([alpha])

    expect(
      card(ALPHA)
        .findAll('.dm-card__ore .dm-ore')
        .map((ore) => ore.attributes('aria-label'))
    ).toEqual(['Coal: 5', 'Bronze: 3'])
  })

  it('[US-MINE-010.AC01] ore a turn earns reaches the card through ledger.changed', async () => {
    const { host, card } = await minesPage([mineWire(ALPHA, 'alpha')])
    expect(card(ALPHA).findAll('.dm-card__ore .dm-ore')).toHaveLength(0)

    host.push([
      frame(4, 'ledger.changed', {
        mineId: ALPHA,
        totals: {
          coal: zero,
          bronze: zero,
          copper: zero,
          silver: { tokens: 100_000 },
          gold: zero,
          uranium: zero
        }
      })
    ])
    await settle()

    expect(
      card(ALPHA)
        .findAll('.dm-card__ore .dm-ore')
        .map((ore) => ore.attributes('aria-label'))
    ).toEqual(['Silver: 2'])
  })

  it('[US-MINES-008.AC01] the progress row names the next tier and shows the score over its floor, from MineWire.score', async () => {
    const alpha = mineWire(ALPHA, 'alpha', { score: { kb: 1_630.4, nextTierKb: 12_000 } })
    const { card } = await minesPage([alpha])

    const progress = progressOf(card(ALPHA))
    expect(progress.get('.dm-progress__row').text()).toBe('Next: Gold1,630 / 12,000')
    expect(progress.get('.dm-progress').attributes('data-tier')).toBe('gold')
    expect(progress.get('[role="progressbar"]').attributes()).toMatchObject({
      'aria-valuenow': '1630',
      'aria-valuemax': '12000'
    })
  })

  it('[US-MINES-008.AC02] a mine at Uranium reads Max tier with its score instead of a bar', async () => {
    const top = mineWire(BRAVO, 'bravo', {
      tier: 'uranium',
      score: { kb: 150_000, nextTierKb: null }
    })
    const { card } = await minesPage([top])

    const progress = progressOf(card(BRAVO))
    expect(progress.find('[role="progressbar"]').exists()).toBe(false)
    expect(progress.text()).toContain('Max tier')
    expect(progress.text()).toContain('150,000')
  })

  it('[US-MINES-008.AC01, US-MINES-008.AC03] a re-measure shows Measuring… and then the new score that mine.changed carries', async () => {
    const alpha = mineWire(ALPHA, 'alpha', { score: { kb: 1_630, nextTierKb: 12_000 } })
    const { host, card } = await minesPage([alpha])

    host.push([frame(4, 'mine.changed', { mine: { ...alpha, state: 'measuring' } })])
    await settle()
    const measuring = card(ALPHA)
    expect(progressOf(measuring).text()).toContain('Measuring…')
    // The rest of the card keeps its last known values while it is measured again.
    expect(measuring.get('.dm-card__title .dm-tier').text()).toBe('Silver')

    host.push([
      frame(5, 'mine.changed', {
        mine: { ...alpha, score: { kb: 2_048, nextTierKb: 12_000 } }
      })
    ])
    await settle()
    expect(progressOf(card(ALPHA)).get('.dm-progress__row').text()).toBe('Next: Gold2,048 / 12,000')
  })

  it('[US-MINES-008.AC04] a mine never measured wears the Bronze placeholder and reads Measuring…', async () => {
    const fresh = mineWire(BRAVO, 'bravo', {
      state: 'measuring',
      tier: null,
      hasBeenMeasured: false
    })
    const { card } = await minesPage([fresh])

    const view = card(BRAVO)
    expect(view.get('.dm-card__title .dm-tier').text()).toBe('Bronze')
    expect(progressOf(view).text()).toContain('Measuring…')
  })
})
