// The SessionStore conformance suite (16 §4.14, 17 §1.3): the UI-main session store keeps a dwarf's draft and chat
// view state for the app run, in memory only, and drops them on the dwarf's departure (ADR-024 items 1, 3; INV-34,
// INV-113). Run against `InMemorySessionStore`, the port's adapter and its own double (16 §4.14 table).
import { describe, expect, it } from 'vitest'
import type { ChatViewState, DwarfId, MessageId } from '@dwarfai/contracts'
import type { SessionStore } from '../ports/sessionStore'

export interface SessionStoreSubject {
  /** The store of this app run. */
  readonly store: SessionStore
  /** The store a new app run starts with, on the same machine and with the same user. */
  nextRun(): SessionStore
}

const BORIN = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a01' as DwarfId
const DORI = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a02' as DwarfId
const ANCHORED: ChatViewState = {
  scrollAnchor: { messageId: '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a99' as MessageId, offsetPx: 12 },
  selection: { start: 3, end: 7, direction: 'forward' }
}

export function runSessionStoreContract(
  makeSubject: () => SessionStoreSubject | Promise<SessionStoreSubject>
): void {
  describe('SessionStore contract', () => {
    it('[INV-113] a draft set for a dwarf is read back and never written to disk', async () => {
      const { store, nextRun } = await makeSubject()
      expect(store.draft(BORIN)).toBe('')
      store.setDraft(BORIN, 'half a thought')
      store.setDraft(DORI, 'another')

      expect(store.draft(BORIN)).toBe('half a thought')
      expect(store.draft(DORI)).toBe('another')
      // Nothing survives the app run: a new run starts empty, so nothing was kept on disk (ADR-024 item 3).
      expect(nextRun().draft(BORIN)).toBe('')
    })

    it('[ADR-024] a chat view state set for a dwarf is read back as a copy and dies with the app run', async () => {
      const { store, nextRun } = await makeSubject()
      expect(store.view(BORIN)).toBeNull()
      const view = structuredClone(ANCHORED)
      store.setView(BORIN, view)
      view.scrollAnchor = 'bottom'

      expect(store.view(BORIN)).toEqual(ANCHORED)
      expect(store.view(DORI)).toBeNull()
      expect(nextRun().view(BORIN)).toBeNull()
    })

    it("[INV-34] dropping a dwarf drops its draft and chat view state and keeps every other dwarf's", async () => {
      const { store } = await makeSubject()
      store.setDraft(BORIN, 'half a thought')
      store.setView(BORIN, ANCHORED)
      store.setDraft(DORI, 'another')
      store.setView(DORI, { scrollAnchor: 'bottom' })

      store.dropDwarf(BORIN)

      expect(store.draft(BORIN)).toBe('')
      expect(store.view(BORIN)).toBeNull()
      expect(store.draft(DORI)).toBe('another')
      expect(store.view(DORI)).toEqual({ scrollAnchor: 'bottom' })
    })
  })
}
