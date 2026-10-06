// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DwarfId,
  IpcResult,
  MessageId,
  MessageView,
  MineHistoryView,
  MineId
} from '@dwarfai/contracts'
import { useMineHistory, type HostMineHistoryRead } from './useMineHistory'

/*
 * THE HISTORY PANEL FROM THE HOST (ISSUE-106; 14 §2.1 row A-19, §3.6 `MineHistoryView`; ADR-007 item 5).
 *
 * A-19 reads a mine's history from the Host's message log: every dwarf that worked there, with its ≤ 50 stored rows.
 * The composable exposes one tab per speaker with the rows mapped to today's `FeedMessage`. The call is injected
 * until the cut-1 switch (ISSUE-123) regenerates `window.api` with A-19's target shape; it stands in for
 * `window.api.getMineHistory`.
 */

const ALPHA = '01920000-0000-7000-8000-00000000a001' as MineId
const BETA = '01920000-0000-7000-8000-00000000a002' as MineId
const BORIN = '01920000-0000-7000-8000-00000000d001' as DwarfId
const DAIN = '01920000-0000-7000-8000-00000000d002' as DwarfId
const id = (n: number) =>
  `01920000-0000-7000-8000-00000000e${String(n).padStart(3, '0')}` as MessageId
/** 2026-10-06T09:00:00.000Z, in epoch ms. */
const NINE = 1_791_277_200_000

function view(n: number, dwarfId: DwarfId, overrides: Partial<MessageView> = {}): MessageView {
  return {
    id: id(n),
    dwarfId,
    role: n % 2 === 1 ? 'person' : 'dwarf',
    text: `line ${n}`,
    attachments: [],
    providerTime: null,
    createdAt: NINE + n * 60_000,
    ...overrides
  }
}

function history(
  mineId: MineId,
  speakers: MineHistoryView['speakers']
): IpcResult<MineHistoryView> {
  return { ok: true, value: { mineId, speakers } }
}

/** Resolves only when `release()` is called, so a slow answer can be overtaken. */
function deferred<T>() {
  let release!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

describe('useMineHistory', () => {
  beforeEach(() => {
    useMineHistory().close()
  })

  it('[ADR-007] the history panel reads getMineHistory and exposes one tab per speaker', async () => {
    const getMineHistory = vi.fn<HostMineHistoryRead>().mockResolvedValue(
      history(ALPHA, [
        {
          dwarfId: BORIN,
          displayName: 'Borin',
          departed: false,
          messages: [view(1, BORIN), view(2, BORIN, { providerTime: NINE + 150_000 })]
        },
        { dwarfId: DAIN, displayName: 'Dain', departed: true, messages: [] }
      ])
    )
    const { state, open } = useMineHistory()

    await open(ALPHA, getMineHistory)

    expect(getMineHistory).toHaveBeenCalledWith(ALPHA)
    expect(state).toEqual({
      mineId: ALPHA,
      readable: true,
      tabs: [
        {
          dwarfId: BORIN,
          displayName: 'Borin',
          departed: false,
          lastMessageAt: NINE + 150_000,
          messages: [
            { role: 'user', text: 'line 1', timestamp: '2026-10-06T09:01:00.000Z' },
            { role: 'assistant', text: 'line 2', timestamp: '2026-10-06T09:02:30.000Z' }
          ]
        },
        { dwarfId: DAIN, displayName: 'Dain', departed: true, lastMessageAt: null, messages: [] }
      ]
    })
  })

  it('[ADR-007] a history the Host refused or could not send reads as unreadable, never as a mine nobody worked', async () => {
    const getMineHistory = vi
      .fn<HostMineHistoryRead>()
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'HOST_NOT_READY', message: 'starting', retryable: true }
      })
      .mockRejectedValueOnce(new Error('bridge down'))
      .mockResolvedValueOnce({ readable: true, speakers: [] })
    const { state, open } = useMineHistory()

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await open(ALPHA, getMineHistory)
      expect(state).toEqual({ mineId: ALPHA, readable: false, tabs: [] })
    }
  })

  it('[ADR-007] a slow answer for a mine the panel has left never lands on the next one', async () => {
    const slow = deferred<unknown>()
    const getMineHistory = vi
      .fn<HostMineHistoryRead>()
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce(history(BETA, []))
    const { state, open } = useMineHistory()

    const first = open(ALPHA, getMineHistory)
    await open(BETA, getMineHistory)
    slow.release(
      history(ALPHA, [{ dwarfId: BORIN, displayName: 'Borin', departed: false, messages: [] }])
    )
    await first

    expect(state).toEqual({ mineId: BETA, readable: true, tabs: [] })
  })
})
