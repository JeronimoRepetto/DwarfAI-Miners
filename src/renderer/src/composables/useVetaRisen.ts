/*
 * The Veta renderer's part of the risen window (07 machine 24; UC-048, UC-066, UC-064; ADR-024 items 1, 3; ADR-025
 * items 2, 8; ISSUE-290): it steps `lib/veta/risenWindow.ts` and carries out the effects of each step, in order.
 *
 * - The window grows before anything rises (`layoutVeta {rise, dwarfId, chatBounds}`, A-N23): `chatBounds` is the
 *   room beside the island the chat needs, from its anchored end, as the overlays ask for theirs, so UI main grows the
 *   window away from the anchor corner and the island never moves (`risenGeometry`). An answer `applied: false`, or no
 *   answer at all, is a refused rise (S24.17): nothing shows and the store never hears of it. UI main logs a refusal
 *   where it makes one (`veta.placement`, `unplaced`).
 * - The Add panel has no dwarf to name in `rise`, so its room is held beside the band like an overlay's (`addRoom`,
 *   `layoutVeta {overlay}`) and given back the same way, also once the panel has turned into its dwarf's chat (S24.06),
 *   which stays where it stands. A later replace re-anchors through `rise` and gives that room back after.
 * - The open chat goes to the UI-main session store (A-N18 `veta-risen-chat`, `open-chat{veta}`); its draft and view
 *   come back from it (A-N17) before the panel is drawn. The draft is patched as it is typed; the draft and the view
 *   are kept on a fold or a replace (S24.05, S24.08, S24.14) and never sent to the Host (INV-113). A departure drops the
 *   draft the window holds; UI main drops the stored one itself (INV-34).
 * - The window shrinks only after the fold has played (`layoutVeta {fold}`, S24.09); after a drag UI main already
 *   forgot the room (S24.14). Motion is the host's (`transform`/`opacity` only) and ends by itself or by its watchdog.
 * - A reveal (A-N16 `onRevealDwarfChat`) rises a present dwarf's chat as a click does, or brings only its mine
 *   (S24.15, S24.16); the "+N" unfold before it is ISSUE-291's.
 *
 * Each step stamps the effects it starts: a later step (a fold mid-rise, a drag) stops the earlier one's remaining
 * effects, so a motion that ends late never steps a machine that has moved on. The bridge and the host are injected
 * (the house idiom over `vi.mock`).
 */
import type {
  ChatViewState,
  DwarfId,
  MineId,
  RevealDwarfChatPush,
  UiSessionPatch,
  UiSessionSnapshot,
  VetaDock,
  VetaLayoutRequest,
  VetaLayoutResult
} from '@dwarfai/contracts'
import { shallowRef, type Ref } from 'vue'
import {
  FOLDED,
  risenGeometry,
  stepRisen,
  type RisenContent,
  type RisenEffect,
  type RisenEvent,
  type RisenGeometry,
  type RisenIsland,
  type RisenStep,
  type RisenWindow
} from '../lib/veta/risenWindow'

/** The seam A members the risen window uses (14 §2.2 A-N16, A-N17, A-N18, A-N23). */
export interface VetaRisenBridge {
  layoutVeta(request: VetaLayoutRequest): Promise<VetaLayoutResult>
  patchUiSession(patch: UiSessionPatch): void
  getUiSession(): Promise<UiSessionSnapshot>
  onRevealDwarfChat(listener: (target: RevealDwarfChatPush) => void): () => void
}

type Size = { width: number; height: number }

/** What the Veta window provides: its measures, the hosted panel, the motion, the keyboard. */
export interface VetaRisenHost {
  /** The island's edge and anchored end now. */
  dock(): Pick<VetaDock, 'edge' | 'end'>
  /** The stage (the display's work area) and the island on it, along its edge. */
  stage(): { size: Size; island: RisenIsland }
  /** The centre, along the island from its start, of what opened the window: the dwarf, the "+" or the grip. */
  anchor(content: RisenContent): number
  /** Holds the Add panel's room beside the island with the band (`layoutVeta {overlay}`), or gives it back. */
  addRoom(size: Size | null): Promise<void>
  /** The open chat's draft and view state, as the hosted panel holds them; `null` when it is not drawn. */
  capture(dwarfId: DwarfId): { draft: string; view: ChatViewState } | null
  /** Draws the chat on the dwarf with this draft, its view restored once drawn. */
  showChat(
    mineId: MineId,
    dwarfId: DwarfId,
    draft: string,
    view: ChatViewState | null
  ): Promise<void>
  /** Draws the Add panel aimed at the mine. */
  showAdd(mineId: MineId): void
  /** Drops the draft the window holds for the dwarf. */
  dropDraft(dwarfId: DwarfId): void
  /** Draws nothing: the window folded. */
  clear(): void
  /** Plays a motion of the risen content; resolves when it ended or its watchdog fired (NFR-TIM-16). */
  motion(kind: 'rise' | 'veil' | 'replace' | 'fold'): Promise<void>
  /** The keyboard to the chat (its composer, or the question card while it asks) or the Add panel's first chip. */
  focus(target: 'chat' | 'add'): void
  /** Whether the dwarf is still in the mine. */
  present(mineId: MineId, dwarfId: DwarfId): boolean
  /** Brings the mine's chamber into view, with no chat (S24.16). */
  bringMine(mineId: MineId): void
  /** A grip drag is under way. */
  dragging(): boolean
}

export interface VetaRisenDeps {
  bridge: VetaRisenBridge
  host: VetaRisenHost
}

export interface VetaRisen {
  machine: Readonly<Ref<RisenWindow>>
  /** Where the risen window stands; `null` while nothing has been placed. */
  geometry: Readonly<Ref<RisenGeometry | null>>
  /** The last step machine 24 took or refused. */
  last: Readonly<Ref<RisenStep | null>>
  /** Steps the machine and carries out the step's effects; resolves once they ran, a motion once it started. */
  dispatch(event: RisenEvent): Promise<void>
  /** The open chat's draft as it is typed, kept in the session store. */
  draft(dwarfId: DwarfId, text: string): void
  /** Hears reveals. */
  start(): void
  stop(): void
}

export function useVetaRisen(deps: VetaRisenDeps): VetaRisen {
  const { bridge, host } = deps
  const machine = shallowRef<RisenWindow>(FOLDED)
  const geometry = shallowRef<RisenGeometry | null>(null)
  const last = shallowRef<RisenStep | null>(null)
  /** Stamps each step taken, so a step's remaining effects stop once a later one was taken. */
  let stamp = 0
  /** What holds the risen window's room in UI main: a `rise`, or the Add panel's room beside the band. */
  let heldBy: 'rise' | 'add' | null = null
  let unlisten: (() => void) | null = null

  function place(content: RisenContent): RisenGeometry {
    const { size, island } = host.stage()
    const placed = risenGeometry(host.dock(), size, island, host.anchor(content))
    geometry.value = placed
    return placed
  }

  function keep(dwarfId: DwarfId): void {
    const held = host.capture(dwarfId)
    if (held === null) return
    bridge.patchUiSession({ kind: 'draft', dwarfId, text: held.draft })
    bridge.patchUiSession({ kind: 'chat-view', dwarfId, view: held.view })
  }

  async function grow(request: VetaLayoutRequest): Promise<boolean> {
    try {
      return (await bridge.layoutVeta(request)).applied
    } catch {
      // UI main out of reach: the window could not grow, which is a refused rise.
      return false
    }
  }

  async function openChat(mineId: MineId, dwarfId: DwarfId): Promise<void> {
    bridge.patchUiSession({ kind: 'veta-risen-chat', dwarfId })
    bridge.patchUiSession({ kind: 'open-chat', host: 'veta', dwarfId })
    let draft = ''
    let view: ChatViewState | null = null
    try {
      const session = await bridge.getUiSession()
      draft = session.drafts[dwarfId] ?? ''
      view = session.chatViews[dwarfId] ?? null
    } catch {
      // The session store could not be read: the chat opens as it is.
    }
    await host.showChat(mineId, dwarfId, draft, view)
  }

  /** Carries out one effect; answers `false` when the rest of the step must not run. */
  async function run(effect: RisenEffect, mine: number): Promise<boolean> {
    switch (effect.kind) {
      case 'layout-rise': {
        const content = machine.value.content
        if (content === null) return false
        const placed = place(content)
        const applied = await grow({
          kind: 'rise',
          dwarfId: effect.dwarfId,
          chatBounds: placed.room
        })
        if (mine !== stamp) return false
        if (!applied) {
          void dispatch({ type: 'refused' })
          return false
        }
        if (heldBy === 'add') await host.addRoom(null)
        heldBy = 'rise'
        return true
      }
      case 'layout-add': {
        const content = machine.value.content
        if (content === null) return false
        await host.addRoom(place(content).room)
        heldBy = 'add'
        return mine === stamp
      }
      case 'open-chat':
        await openChat(effect.mineId, effect.dwarfId)
        return mine === stamp
      case 'open-add':
        host.showAdd(effect.mineId)
        return true
      case 'motion':
        // The veil is at once and comes before the re-anchoring; any other motion is its step's last effect, and
        // its end is the next step.
        if (effect.motion === 'veil') {
          await host.motion('veil')
          return mine === stamp
        }
        void host.motion(effect.motion).then(() => {
          if (mine === stamp) void dispatch({ type: 'motion-done' })
        })
        return true
      case 'focus':
        host.focus(effect.target)
        return true
      case 'keep':
        keep(effect.dwarfId)
        return true
      case 'drop-draft':
        host.dropDraft(effect.dwarfId)
        return true
      case 'layout-fold':
        if (heldBy === 'rise') await grow({ kind: 'fold' })
        else if (heldBy === 'add') await host.addRoom(null)
        heldBy = null
        return true
      case 'closed':
        bridge.patchUiSession({ kind: 'veta-risen-chat', dwarfId: null })
        geometry.value = null
        host.clear()
        return true
      case 'bring-mine':
        host.bringMine(effect.mineId)
        return true
      case 'log-refused':
        // UI main logged the refusal it answered (`veta.placement`, `unplaced`); nothing shows here.
        geometry.value = null
        heldBy = null
        return true
    }
  }

  async function dispatch(event: RisenEvent): Promise<void> {
    const next = stepRisen(machine.value, event, { dragging: host.dragging() })
    last.value = next.step
    if (!next.step.ok) return
    const mine = ++stamp
    machine.value = next.machine
    // A drag dropped the window's room with the drag surface: nothing holds it any more.
    if (event.type === 'interrupt' && event.why === 'drag') heldBy = null
    for (const effect of next.step.effects) {
      if (!(await run(effect, mine))) return
    }
  }

  return {
    machine,
    geometry,
    last,
    dispatch,
    draft(dwarfId, text) {
      bridge.patchUiSession({ kind: 'draft', dwarfId, text })
    },
    start() {
      unlisten ??= bridge.onRevealDwarfChat((target) => {
        void dispatch({
          type: 'reveal',
          mineId: target.mineId,
          dwarfId: target.dwarfId,
          present: target.dwarfId !== null && host.present(target.mineId, target.dwarfId)
        })
      })
    },
    stop() {
      unlisten?.()
      unlisten = null
    }
  }
}
