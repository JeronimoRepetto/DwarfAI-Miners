import { reactive } from 'vue'
import {
  CHANNELS,
  type DwarfId,
  type DwarfRank,
  type MineHistoryView,
  type MineId,
  type ProviderId
} from '@dwarfai/contracts'
import type { FeedMessage } from '../types'
import { feedMessageOf } from './useDwarfMessaging'

/** A-19 `getMineHistory` in its 14 shape (`MineId` → `IpcResult<MineHistoryView>`), injected until ISSUE-123. */
export type HostMineHistoryRead = (mineId: MineId) => Promise<unknown>

/** One tab of the history panel: one dwarf that worked in the mine, with its stored rows in today's shape. */
export interface MineHistoryTab {
  dwarfId: DwarfId
  displayName: string
  /** Its rank and provider, so a departed dwarf keeps its role portrait (owner amendment F, 2026-10-07). */
  rank: DwarfRank
  providerId: ProviderId
  departed: boolean
  /** When its newest row was said (its provider time when it has one), or null when it has no row. */
  lastMessageAt: number | null
  messages: FeedMessage[]
}

export interface MineHistoryState {
  /** The mine whose history is open, or null. */
  mineId: MineId | null
  /** Null while nothing was answered; false when the history could not be read, a different fact from no tab. */
  readable: boolean | null
  tabs: MineHistoryTab[]
}

/** A-19's target answer, read with the registry's own schema so a malformed answer is never taken for a history. */
const historyAnswer = CHANNELS['mine:history'].response

// Singleton store: module-scope state shared by every useMineHistory() caller (house style).
const state = reactive<MineHistoryState>({ mineId: null, readable: null, tabs: [] })
/** Which read is the current one, so a slow answer cannot land on a mine the panel has since left. */
let historyToken = 0

function tabOf(speaker: MineHistoryView['speakers'][number]): MineHistoryTab {
  const said = speaker.messages.map((message) => message.providerTime ?? message.createdAt)
  return {
    dwarfId: speaker.dwarfId,
    displayName: speaker.displayName,
    rank: speaker.rank,
    providerId: speaker.providerId,
    departed: speaker.departed,
    lastMessageAt: said.length === 0 ? null : Math.max(...said),
    messages: speaker.messages.map(feedMessageOf)
  }
}

/*
 * THE HISTORY PANEL FROM THE HOST (ISSUE-106; 14 §2.1 row A-19, §3.6 `MineHistoryView`; ADR-007 item 5).
 *
 * A mine's history is read from the Host's message log over A-19: every dwarf that worked there, with its ≤ 50 stored
 * rows, undelivered included. One tab per speaker, in the Host's order, with the rows mapped to today's `FeedMessage`
 * by the same mapper as the chat. A refused call, a lost round trip or an answer that is not a `MineHistoryView`
 * reads as unreadable, which is a different statement from a mine nobody has worked in.
 *
 * Hidden until built (21 §1 item 8): the call is injected, and nothing opens this store until the cut-1 switch
 * (ISSUE-123) regenerates `window.api` with A-19's target shape and the shell passes `window.api.getMineHistory`.
 */
export function useMineHistory() {
  async function open(mineId: MineId, read: HostMineHistoryRead): Promise<void> {
    const token = ++historyToken
    state.mineId = mineId
    let answered: unknown
    try {
      answered = await read(mineId)
    } catch {
      answered = undefined
    }
    if (token !== historyToken) return
    const parsed = historyAnswer.safeParse(answered)
    if (!parsed.success || !parsed.data.ok) {
      state.readable = false
      state.tabs = []
      return
    }
    state.readable = true
    state.tabs = parsed.data.value.speakers.map(tabOf)
  }

  function close(): void {
    historyToken++
    state.mineId = null
    state.readable = null
    state.tabs = []
  }

  return { state, open, close }
}
