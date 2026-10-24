import type {
  ChatViewState,
  RevealDwarfChatPush,
  UiSessionPatch,
  UiSessionSnapshot,
  VetaDockChanged,
  VetaLayoutRequest,
  VetaLayoutResult
} from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import { BORIN, DAIN, EREBOR, MORIA } from '../lib/veta/testing/vetaFixtures'
import type { RisenContent } from '../lib/veta/risenWindow'
import { useVetaRisen, type VetaRisenHost } from './useVetaRisen'

/*
 * ISSUE-290 (TC-290-02, TC-290-03; 07 machine 24; UC-048; ADR-024 items 1, 3; ADR-025 item 2): the Veta renderer's
 * part of the risen window over a fake bridge (UI main) and a fake host (the Veta window's DOM and the hosted panel),
 * which record every call in one log so the order is what is asserted.
 */

const PLACE: VetaLayoutResult = {
  applied: true,
  displayKey: 'Q27G2WG4|2560x1440|@1|0,0',
  dock: { edge: 'bottom', end: 'end', offset: 16 }
}

const VIEW: ChatViewState = {
  scrollAnchor: 'bottom',
  selection: { start: 3, end: 3, direction: 'none' }
}

function world(
  options: { applied?: boolean; drafts?: Record<string, string>; unfold?: boolean } = {}
) {
  const log: string[] = []
  const reveals: Array<(t: RevealDwarfChatPush) => void> = []
  const replaced: Array<(e: VetaDockChanged) => void> = []
  const motions: Array<() => void> = []
  const session: UiSessionSnapshot = {
    drafts: { ...(options.drafts ?? {}) } as UiSessionSnapshot['drafts'],
    chatViews: {} as UiSessionSnapshot['chatViews'],
    askPicks: {} as UiSessionSnapshot['askPicks'],
    openChat: {},
    currentMine: {},
    valle: {}
  }
  const host: VetaRisenHost = {
    dock: () => ({ edge: 'bottom', end: 'end' }),
    stage: () => ({
      size: { width: 2560, height: 1392 },
      island: { length: 400, thickness: 52, before: 2560 - 16 - 400, after: 16 }
    }),
    anchor: (content: RisenContent) => (content.kind === 'chat' ? 100 : 380),
    addRoom: (size) => {
      log.push(`addRoom ${JSON.stringify(size)}`)
      return Promise.resolve()
    },
    capture: (dwarfId) => ({
      draft: `draft of ${dwarfId === BORIN ? 'borin' : 'dain'}`,
      view: VIEW
    }),
    showChat: (_mineId, dwarfId, draft, view) => {
      log.push(
        `showChat ${dwarfId === BORIN ? 'borin' : 'dain'} "${draft}" ${JSON.stringify(view)}`
      )
      return Promise.resolve()
    },
    showAdd: (mineId) => log.push(`showAdd ${mineId === EREBOR ? 'erebor' : 'moria'}`),
    dropDraft: (dwarfId) => log.push(`dropDraft ${dwarfId === BORIN ? 'borin' : 'dain'}`),
    clear: () => log.push('clear'),
    motion: (kind) => {
      log.push(`motion ${kind}`)
      if (kind === 'veil') return Promise.resolve()
      return new Promise((resolve) => motions.push(resolve))
    },
    focus: (target) => log.push(`focus ${target}`),
    present: (_mineId, dwarfId) => dwarfId === BORIN,
    bringMine: (mineId) => log.push(`bringMine ${mineId === MORIA ? 'moria' : 'erebor'}`),
    dragging: () => false,
    // ISSUE-291: the "+N" unfold before a reveal, logged in the same order as UI main's requests.
    ...(options.unfold === true
      ? {
          unfold: (mineId) => {
            log.push(`unfold ${mineId === MORIA ? 'moria' : 'erebor'}`)
            return Promise.resolve()
          }
        }
      : {})
  }
  const risen = useVetaRisen({
    bridge: {
      layoutVeta(request: VetaLayoutRequest) {
        log.push(`layoutVeta ${JSON.stringify(request)}`)
        return Promise.resolve({ ...PLACE, applied: options.applied ?? true })
      },
      patchUiSession(patch: UiSessionPatch) {
        log.push(`patch ${JSON.stringify(patch)}`)
      },
      getUiSession() {
        log.push('getUiSession')
        return Promise.resolve(session)
      },
      onRevealDwarfChat(listener) {
        reveals.push(listener)
        return () => undefined
      },
      onVetaDockChanged(listener) {
        replaced.push(listener)
        return () => undefined
      },
      // ISSUE-293: the hand-off to the Panel (A-N13), logged in the same order as UI main's other requests.
      moveToMode(params) {
        log.push(`moveToMode ${JSON.stringify(params)}`)
        return Promise.resolve({ ok: true, value: undefined })
      }
    },
    host
  })
  /** Ends the motion playing now. */
  async function motionEnds(): Promise<void> {
    for (const end of motions.splice(0)) end()
    await settle()
  }
  return { risen, log, reveals, replaced, motionEnds, session }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

const RISE_BORIN = `layoutVeta {"kind":"rise","dwarfId":"${BORIN}","chatBounds":{"width":522,"height":614}}`

describe('useVetaRisen', () => {
  it('[US-VETA-005.AC02, S24.01, S24.02, ADR-024] the window grows before the rise, the store learns the chat and gives its draft back, and the composer takes the keyboard once risen', async () => {
    const { risen, log, motionEnds } = world({ drafts: { [BORIN]: 'half a thought' } })
    await risen.dispatch({ type: 'dwarf-hit', dwarfId: BORIN, mineId: MORIA })
    expect(log).toEqual([
      RISE_BORIN,
      `patch {"kind":"veta-risen-chat","dwarfId":"${BORIN}"}`,
      `patch {"kind":"open-chat","host":"veta","dwarfId":"${BORIN}"}`,
      'getUiSession',
      'showChat borin "half a thought" null',
      'motion rise'
    ])
    expect(risen.machine.value.state).toBe('rising')
    // Centred on the dwarf, 100 px along a 400 px island: it starts 122 px before the island and ends 78 px short of
    // the anchored end.
    expect(risen.geometry.value).toMatchObject({
      width: 444,
      height: 600,
      pointer: 222,
      fromAnchor: 78
    })
    await motionEnds()
    expect(risen.machine.value.state).toBe('risen-chat')
    expect(log.at(-1)).toBe('focus chat')

    // Typing keeps the draft in the session store, never sent anywhere else (INV-113).
    risen.draft(BORIN, 'half a thought, more')
    expect(log.at(-1)).toBe(
      `patch {"kind":"draft","dwarfId":"${BORIN}","text":"half a thought, more"}`
    )
  })

  it('[US-VETA-005.AC03, S24.08, S24.09, ADR-025] a fold keeps the draft and view, shrinks the window only after the fold, then forgets the risen chat', async () => {
    const { risen, log, motionEnds } = world()
    await risen.dispatch({ type: 'dwarf-hit', dwarfId: BORIN, mineId: MORIA })
    await motionEnds()
    log.length = 0
    await risen.dispatch({ type: 'esc', renaming: false })
    expect(log).toEqual([
      `patch {"kind":"draft","dwarfId":"${BORIN}","text":"draft of borin"}`,
      `patch {"kind":"chat-view","dwarfId":"${BORIN}","view":${JSON.stringify(VIEW)}}`,
      'motion fold'
    ])
    await motionEnds()
    expect(log.slice(3)).toEqual([
      'layoutVeta {"kind":"fold"}',
      'patch {"kind":"veta-risen-chat","dwarfId":null}',
      'clear'
    ])
    expect(risen.machine.value.state).toBe('folded')
  })

  it("[S24.10, S24.11, INV-113] a departure drops the dwarf's draft; its mine removed closes the chat with nothing kept", async () => {
    const { risen, log, motionEnds } = world()
    await risen.dispatch({ type: 'dwarf-hit', dwarfId: BORIN, mineId: MORIA })
    await motionEnds()
    log.length = 0
    await risen.dispatch({ type: 'departed', dwarfId: BORIN, cause: 'stopped' })
    expect(risen.machine.value.state).toBe('read-only')
    // UI main drops the stored draft itself on `dwarf.departed` (INV-34); the window drops the one it holds.
    expect(log).toEqual(['dropDraft borin'])
    // Folding the read-only chat keeps nothing.
    await risen.dispatch({ type: 'outside' })
    await motionEnds()
    expect(log.filter((line) => line.includes('"draft"') || line.includes('chat-view'))).toEqual([])

    const second = world()
    await second.risen.dispatch({ type: 'dwarf-hit', dwarfId: BORIN, mineId: MORIA })
    await second.motionEnds()
    second.log.length = 0
    await second.risen.dispatch({ type: 'departed', dwarfId: BORIN, cause: 'mine-removed' })
    await second.motionEnds()
    expect(second.risen.machine.value.state).toBe('folded')
    expect(second.log.some((line) => line.includes('chat-view'))).toBe(false)
    expect(second.log).toContain('layoutVeta {"kind":"fold"}')
  })

  it('[S24.03, S24.04, S24.06, BR-21] the Add panel rises in a room held with the band, becomes the new chat in place, and gives the room back on fold', async () => {
    const { risen, log, motionEnds } = world()
    await risen.dispatch({ type: 'add', mineId: EREBOR })
    expect(log).toEqual(['addRoom {"width":444,"height":614}', 'showAdd erebor', 'motion rise'])
    await motionEnds()
    expect(log.at(-1)).toBe('focus add')
    log.length = 0
    await risen.dispatch({ type: 'launched', dwarfId: DAIN })
    expect(risen.machine.value).toMatchObject({ state: 'risen-chat', content: { dwarfId: DAIN } })
    // The same place: no new room is asked for.
    expect(log.some((line) => line.startsWith('layoutVeta') || line.startsWith('addRoom'))).toBe(
      false
    )
    await risen.dispatch({ type: 'outside' })
    await motionEnds()
    expect(log).toContain('addRoom null')
    expect(log.some((line) => line === 'layoutVeta {"kind":"fold"}')).toBe(false)
  })

  it("[S24.15, S24.16, S24.17, ADR-025] a reveal rises a present dwarf's chat or brings only its mine, and a refused rise shows nothing", async () => {
    const { risen, log, reveals } = world()
    risen.start()
    reveals[0]!({ mineId: MORIA, dwarfId: DAIN })
    await settle()
    expect(log).toEqual(['bringMine moria'])
    reveals[0]!({ mineId: MORIA, dwarfId: BORIN })
    await settle()
    expect(log[1]).toBe(RISE_BORIN)
    expect(risen.machine.value.state).toBe('rising')

    const refused = world({ applied: false })
    await refused.risen.dispatch({ type: 'dwarf-hit', dwarfId: BORIN, mineId: MORIA })
    expect(refused.risen.machine.value.state).toBe('folded')
    // Nothing was shown, and the store never heard of the chat.
    expect(refused.log).toEqual([RISE_BORIN])
  })

  it('[S24.05, S24.14] another dwarf replaces the chat at opacity 0 after keeping the first one, and a drag folds at once', async () => {
    const { risen, log, motionEnds } = world()
    await risen.dispatch({ type: 'dwarf-hit', dwarfId: BORIN, mineId: MORIA })
    await motionEnds()
    log.length = 0
    await risen.dispatch({ type: 'dwarf-hit', dwarfId: DAIN, mineId: MORIA })
    expect(log.slice(0, 4)).toEqual([
      `patch {"kind":"draft","dwarfId":"${BORIN}","text":"draft of borin"}`,
      `patch {"kind":"chat-view","dwarfId":"${BORIN}","view":${JSON.stringify(VIEW)}}`,
      'motion veil',
      expect.stringContaining(`"kind":"rise","dwarfId":"${DAIN}"`)
    ])
    expect(log.at(-1)).toBe('motion replace')
    await motionEnds()
    expect(risen.machine.value.state).toBe('risen-chat')

    log.length = 0
    await risen.dispatch({ type: 'interrupt', why: 'drag' })
    expect(risen.machine.value.state).toBe('folded')
    expect(log.some((line) => line.startsWith('layoutVeta'))).toBe(false)
    expect(log.some((line) => line.startsWith('motion'))).toBe(false)
    expect(log).toContain('clear')
  })

  it("[S24.14, S21.13] Veta's display removed folds the risen chat at once and gives the room back", async () => {
    const { risen, log, replaced, motionEnds } = world()
    risen.start()
    await risen.dispatch({ type: 'dwarf-hit', dwarfId: BORIN, mineId: MORIA })
    await motionEnds()
    log.length = 0
    // Another reason re-places the island where it was: the chat stays.
    replaced[0]!({ displayKey: PLACE.displayKey, dock: PLACE.dock, reason: 'work-area-changed' })
    await settle()
    expect(risen.machine.value.state).toBe('risen-chat')
    replaced[0]!({ displayKey: 'other', dock: PLACE.dock, reason: 'display-removed' })
    await settle()
    expect(risen.machine.value.state).toBe('folded')
    expect(log.filter((line) => line.startsWith('motion'))).toEqual([])
    expect(log).toContain('layoutVeta {"kind":"fold"}')
  })

  it('[S25.08, S24.15] a reveal unfolds the chamber "+N" folded before the window grows for the chat', async () => {
    const { risen, log, reveals } = world({ unfold: true })
    risen.start()
    reveals[0]!({ mineId: MORIA, dwarfId: BORIN })
    await settle()
    const order = log.filter((line) => line.startsWith('unfold') || line.startsWith('layoutVeta'))
    expect(order.slice(0, 2)).toEqual(['unfold moria', RISE_BORIN])
  })

  it("[US-VETA-006.AC09, S25.11] the chat last talked to in a mine is the last one this window opened there, else the session store's", async () => {
    const { risen, session } = world()
    // Nothing opened here yet: the session store's record of the mine, when that dwarf is in its crew.
    session.valle = { talkedTo: { [MORIA]: DAIN } as UiSessionSnapshot['valle']['talkedTo'] }
    expect(await risen.talkedTo(MORIA, [BORIN, DAIN])).toBe(DAIN)
    expect(await risen.talkedTo(MORIA, [BORIN])).toBeNull()
    // A chat opened in this window wins.
    await risen.dispatch({ type: 'dwarf-hit', dwarfId: BORIN, mineId: MORIA })
    await settle()
    expect(await risen.talkedTo(MORIA, [BORIN, DAIN])).toBe(BORIN)
    expect(await risen.talkedTo(EREBOR, [BORIN, DAIN])).toBeNull()
  })

  // APPENDED for ISSUE-293: the hand-offs (07 S24.12, S24.18; UC-051).
  it("[S24.12, US-MSG-010.AC01] Open in the Panel asks UI main for the Panel on the chat's mine and dwarf, and the chat stays risen until the window hides", async () => {
    const { risen, log, motionEnds } = world()
    await risen.dispatch({ type: 'dwarf-hit', dwarfId: BORIN, mineId: MORIA })
    await motionEnds()
    log.length = 0
    await risen.dispatch({ type: 'open-in-panel' })
    await settle()
    // The draft and the view travel with the run's own flush (S9.02): this step writes nothing to the store.
    expect(log).toEqual([`moveToMode {"mode":"panel","mineId":"${MORIA}","dwarfId":"${BORIN}"}`])
    expect(risen.machine.value.state).toBe('risen-chat')
  })

  // APPENDED for AMENDMENT-27 (owner, 2026-10-24): the history request (07 S24.13).
  it("[US-DLG-006.AC02, S24.13] a mine-history request asks UI main for the Panel on the history of the chat's mine and dwarf", async () => {
    const { risen, log, motionEnds } = world()
    await risen.dispatch({ type: 'dwarf-hit', dwarfId: BORIN, mineId: MORIA })
    await motionEnds()
    log.length = 0
    await risen.dispatch({ type: 'history' })
    await settle()
    expect(log).toEqual([
      `moveToMode {"mode":"panel","mineId":"${MORIA}","dwarfId":"${BORIN}","slot":"history"}`
    ])
    expect(risen.machine.value.state).toBe('risen-chat')
  })

  it('[S24.18, US-VETA-009.AC02] a chat carried into Veta rises with its draft and view from the session store', async () => {
    const { risen, log } = world({ drafts: { [BORIN]: 'carried from the Panel' } })
    await risen.dispatch({ type: 'arrive', mineId: MORIA, dwarfId: BORIN, present: true })
    expect(log).toEqual([
      RISE_BORIN,
      `patch {"kind":"veta-risen-chat","dwarfId":"${BORIN}"}`,
      `patch {"kind":"open-chat","host":"veta","dwarfId":"${BORIN}"}`,
      'getUiSession',
      'showChat borin "carried from the Panel" null',
      'motion rise'
    ])
  })

  // APPENDED for ISSUE-296: a re-snapshot after the Host connection came back (UC-067; ADR-033 item 3; S20.16).
  it('[ADR-033, INV-113] a risen chat whose dwarf is missing from the re-snapshot closes with no walk and its draft is dropped', async () => {
    // The fake host knows only Borin as present: Dain is missing from the snapshot.
    const { risen, log, motionEnds } = world({ drafts: { [DAIN]: 'unsent' } })
    await risen.dispatch({ type: 'dwarf-hit', dwarfId: DAIN, mineId: EREBOR })
    await motionEnds()
    expect(risen.machine.value.state).toBe('risen-chat')
    log.length = 0

    await risen.resnapshot()
    // No `dwarf.departed` came, so nothing walks and nothing goes read-only: the chat closes, nothing kept.
    expect(log).toEqual(['dropDraft dain', 'motion fold'])
    await motionEnds()
    expect(log.slice(2)).toEqual([
      'layoutVeta {"kind":"fold"}',
      'patch {"kind":"veta-risen-chat","dwarfId":null}',
      'clear'
    ])
    expect(risen.machine.value.state).toBe('folded')
    expect(log.filter((line) => line.includes('"draft"') || line.includes('chat-view'))).toEqual([])

    // A chat whose dwarf is still there stays as it is.
    const kept = world()
    await kept.risen.dispatch({ type: 'dwarf-hit', dwarfId: BORIN, mineId: MORIA })
    await kept.motionEnds()
    kept.log.length = 0
    await kept.risen.resnapshot()
    expect(kept.log).toEqual([])
    expect(kept.risen.machine.value.state).toBe('risen-chat')
  })
})
