// @vitest-environment jsdom
/*
 * The renderer half of Stop everything and quit (ISSUE-317; 07 S10.18…S10.21; ADR-002 D7 steps 1–4): UI main pushes
 * A-N25 with a confirmationId, the window shows how many sessions DwarfAI started will end, Cancel sends A-N27, Confirm
 * sends A-N26 once, and an outcome with failed dwarfs shows one danger message naming them (ADR-014 item 9).
 * The count is the Host read model's owned dwarfs only (14 §2.2 A-N25 Notes; accepted difference OQ-78).
 */
import { describe, expect, it, vi } from 'vitest'
import { effectScope, reactive } from 'vue'
import { confirmStopEverythingSchema } from '@dwarfai/contracts'
import type { DwarfId, IpcResult, StopAllOutcome } from '@dwarfai/contracts'
import { createFakeWindowApi } from '../../../contracts/ipc/testing/fakeWindowApi'
import { useStopEverything, type StopEverythingDwarf } from './useStopEverything'
import { useToasts } from './useToasts'

const CONFIRMATION = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e'
const REQUEST = '01928f3e-7a10-7b2c-8d3e-4f5a6b7c8d9e'
const ALPHA = '01928f3e-7a10-7000-8000-000000000001'
const BRAVO = '01928f3e-7a10-7000-8000-000000000002'
const CHARLIE = '01928f3e-7a10-7000-8000-000000000003'

function dwarf(id: string, owned: boolean, baseName: string, customName: string | null = null) {
  return { id, owned, baseName, customName } as StopEverythingDwarf
}

/** The window.api type, as the renderer sees it (env.d.ts). */
type DwarfAiMinersApi = Window['api']

/** A scripted fake `window.api`: the A-N25 push is captured so a test can raise it. */
function fakeApi(overrides: Partial<DwarfAiMinersApi> = {}) {
  let push: ((payload: { confirmationId: string }) => void) | null = null
  const unsubscribe = vi.fn()
  const confirmStopEverything = vi.fn<DwarfAiMinersApi['confirmStopEverything']>(
    () => new Promise<IpcResult<StopAllOutcome>>(() => undefined)
  )
  const cancelStopEverything = vi.fn<DwarfAiMinersApi['cancelStopEverything']>()
  const api = createFakeWindowApi({
    onStopEverythingRequested: (listener) => {
      push = listener
      return unsubscribe
    },
    confirmStopEverything,
    cancelStopEverything,
    ...overrides
  })
  Object.defineProperty(window, 'api', { configurable: true, value: api })
  return {
    confirmStopEverything: (overrides.confirmStopEverything ??
      confirmStopEverything) as typeof confirmStopEverything,
    cancelStopEverything,
    unsubscribe,
    /** UI main pushes A-N25; a push nobody listens to reaches nothing, as over IPC. */
    request(confirmationId = CONFIRMATION) {
      push?.({ confirmationId })
    }
  }
}

function setup(dwarfs: StopEverythingDwarf[] = []) {
  const board = reactive({ dwarfs })
  const scope = effectScope()
  const stop = scope.run(() =>
    useStopEverything({ readModel: { dwarfs: () => board.dwarfs }, newRequestId: () => REQUEST })
  )!
  return { stop, board, scope }
}

describe('useStopEverything', () => {
  it('[US-RES-002.AC08, S10.18] the confirmation push opens the view with the number of owned sessions of the read model', () => {
    const api = fakeApi()
    const { stop, board } = setup([
      dwarf(ALPHA, true, 'Alpha'),
      dwarf(BRAVO, false, 'Bravo'),
      dwarf(CHARLIE, true, 'Charlie')
    ])
    expect(stop.view.value).toEqual({ kind: 'closed' })

    api.request()
    expect(stop.view.value).toEqual({ kind: 'confirming', count: 2, sending: false })

    // The count follows the read model while the confirmation is open (ADR-002 D7 step 2).
    board.dwarfs = board.dwarfs.filter((d) => d.id !== ALPHA)
    expect(stop.view.value).toEqual({ kind: 'confirming', count: 1, sending: false })
  })

  it('[US-RES-002.AC08, S10.18] with no owned session in the read model the confirmation still opens, with 0', () => {
    const api = fakeApi()
    const { stop } = setup([dwarf(BRAVO, false, 'Bravo')])
    api.request()
    expect(stop.view.value).toEqual({ kind: 'confirming', count: 0, sending: false })
  })

  it('[US-RES-002.AC10, S10.19] cancel sends cancelStopEverything with the confirmationId and nothing else', () => {
    const api = fakeApi()
    const { stop } = setup([dwarf(ALPHA, true, 'Alpha')])
    api.request()

    stop.cancel()

    expect(api.cancelStopEverything).toHaveBeenCalledTimes(1)
    expect(api.cancelStopEverything).toHaveBeenCalledWith({ confirmationId: CONFIRMATION })
    expect(api.confirmStopEverything).not.toHaveBeenCalled()
    expect(stop.view.value).toEqual({ kind: 'closed' })
  })

  it('[S10.20] confirm sends confirmStopEverything once even when pressed twice', async () => {
    const api = fakeApi()
    const { stop } = setup([dwarf(ALPHA, true, 'Alpha')])
    api.request()

    void stop.confirm()
    void stop.confirm()
    // A Cancel after Confirm changes nothing: the stop-all already runs.
    stop.cancel()
    await Promise.resolve()

    expect(api.confirmStopEverything).toHaveBeenCalledTimes(1)
    expect(api.confirmStopEverything).toHaveBeenCalledWith({
      confirmationId: CONFIRMATION,
      requestId: REQUEST
    })
    expect(api.cancelStopEverything).not.toHaveBeenCalled()
    expect(stop.view.value).toEqual({ kind: 'confirming', count: 1, sending: true })
  })

  it('[S10.20] without a minter given, Confirm sends a request the A-N26 schema accepts, with a UUIDv7 requestId', async () => {
    const api = fakeApi()
    const scope = effectScope()
    const stop = scope.run(() => useStopEverything({ readModel: { dwarfs: () => [] } }))!
    api.request()

    void stop.confirm()

    expect(api.confirmStopEverything).toHaveBeenCalledTimes(1)
    const [request] = api.confirmStopEverything.mock.calls[0]!
    expect(confirmStopEverythingSchema.safeParse(request).success).toBe(true)
    scope.stop()
  })

  // AMENDED (owner ruling 2026-10-01): an A-N26 error used to close the view silently. A-N26 never carries legacy
  // dwarf ids; when the legacy end-first adapter (ISSUE-054) cannot end a legacy-launched session it answers INTERNAL
  // and DwarfAI keeps running, so the window shows one danger message saying so, with no names (ADR-002 D7 step 3).
  it('[S10.21, ADR-002] an A-N26 that rejects or answers an error shows one danger message that Stop everything did not finish, with no names and no toast', async () => {
    for (const confirmStopEverything of [
      vi.fn(() => Promise.reject(new Error('the panel lost contact with the app'))),
      vi.fn(async () => ({
        ok: false as const,
        error: {
          code: 'INTERNAL' as const,
          message: 'a legacy session did not end',
          retryable: false
        }
      })),
      vi.fn(async () => ({
        ok: false as const,
        error: { code: 'HOST_UNAVAILABLE' as const, message: 'no Host', retryable: true }
      }))
    ]) {
      const api = fakeApi({ confirmStopEverything })
      const { stop } = setup([dwarf(ALPHA, true, 'Alpha')])
      api.request()

      await expect(stop.confirm()).resolves.toBeUndefined()

      expect(confirmStopEverything).toHaveBeenCalledTimes(1)
      expect(api.cancelStopEverything).not.toHaveBeenCalled()
      expect(stop.view.value).toEqual({ kind: 'unfinished' })
      expect(useToasts().toasts.value).toEqual([])

      // Shown once: dismissing it closes the view.
      stop.dismiss()
      expect(stop.view.value).toEqual({ kind: 'closed' })
    }
  })

  it('[S10.21, ADR-014] an outcome with failed dwarfs shows one danger message naming them and no toast', async () => {
    const api = fakeApi({
      confirmStopEverything: vi.fn(async () => ({
        ok: true as const,
        value: { ended: [ALPHA as DwarfId], failed: [BRAVO as DwarfId, CHARLIE as DwarfId] }
      }))
    })
    const { stop } = setup([
      dwarf(ALPHA, true, 'Alpha'),
      dwarf(BRAVO, true, 'Bravo', 'Brick'),
      dwarf(CHARLIE, true, 'Charlie')
    ])
    api.request()

    await stop.confirm()

    expect(api.confirmStopEverything).toHaveBeenCalledTimes(1)
    expect(stop.view.value).toEqual({ kind: 'incomplete', failed: ['Brick', 'Charlie'] })
    expect(useToasts().toasts.value).toEqual([])

    // The message is shown once: dismissing it closes the view.
    stop.dismiss()
    expect(stop.view.value).toEqual({ kind: 'closed' })
  })
})
