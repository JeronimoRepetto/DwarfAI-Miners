/*
 * The Control room mosaic and Valle's zones in use (07 machines 31, 32; US-VALLE-006, US-VALLE-009; UC-058; 14 §2.1
 * A-30, A-31, §2.2 A-N21; ADR-024 items 1, 4; ISSUE-304): which mines the mosaic shows and in what order, what each zone
 * shows, which mines are muted, the zone menu, the dashed "Add a mine here" slot and its "A new project…" folder flow.
 *
 * - Opened once the Host's facts are read (S32.01, S32.02): the stored order restored, or on a first visit every mine
 *   with a crew, written at once. After the first visit a mine whose first dwarf arrives does not join by itself
 *   (OQ-77 A). Reset metrics rewrites the stores; read again, the mosaic opens anew (S32.16, then S32.01).
 * - Every change is written at once through A-N21: the order (`valleMosaicOrder`), the zones' contents (`valleLayout`,
 *   through machine 28's view, `writeLayouts`) and the muted mines (`mutedMineIds`) (TC-304-01). UI main is the only
 *   writer of the stores.
 * - "Close this column" takes the mine out of the order with its toast through the window's one toast queue (BR-23),
 *   and nothing else: nothing reaches the Host, the mine's sessions are untouched (TC-304-02).
 * - "A new project…" is the ordinary "Add a mine" folder flow (`createFolderDeclare`: A-30, A-31 for a worktree, the
 *   Mines page's words for a refusal); its mine joins the end of the mosaic and the Add panel never opens for it.
 * - The Host removing a mine drops its column and its zone (S32.13, S31.13).
 * - Esc or an outside click closes an open zone menu or slot menu and changes nothing else (`dismiss`; NFR-A11Y-02).
 *
 * The bridge is injected (the house idiom over `vi.mock`); the Valle root hands it the page's own `window.api`.
 */
import type {
  DwarfWire,
  MineId,
  MineWire,
  UiPreferenceWrite,
  ZoneContent
} from '@dwarfai/contracts'
import {
  computed,
  getCurrentScope,
  onScopeDispose,
  shallowRef,
  watch,
  type ComputedRef,
  type Ref
} from 'vue'
import {
  openMosaic,
  slotMenu,
  stepMosaic,
  type Mosaic,
  type MosaicEffect,
  type MosaicFacts,
  type MosaicInput,
  type MosaicState,
  type SlotEntry
} from '../lib/valle/mosaic'
import type { ValleLayouts, VallePreset } from '../lib/valle/preset'
import type { ValleFact } from '../lib/valle/valleReadModel'
import {
  stepZone,
  zoneInputOf,
  zoneMenu,
  type ZoneEffect,
  type ZoneFacts,
  type ZoneInput,
  type ZoneMenuEntry,
  type ZoneMenuItemId,
  type ZoneState
} from '../lib/valle/zone'
import type { MineWorktreeOf } from '../types'
import { createFolderDeclare, type FolderDeclareBridge } from './useMinePicker'
import type { ValleStores } from './useValleStores'

/**
 * The mosaic order and the muted mines as A-N21 takes them from a renderer: lists, never the order's `null` (never
 * written), which only Reset metrics returns the store to (S32.16, UI main's own).
 */
export type ValleMosaicWrite =
  { key: 'valleMosaicOrder'; value: MineId[] } | Extract<UiPreferenceWrite, { key: 'mutedMineIds' }>

/** The seam A members the mosaic uses (14 A-N21, A-30, A-31). */
export interface ValleMosaicBridge extends FolderDeclareBridge {
  setUiPreference(write: ValleMosaicWrite): Promise<unknown>
}

/** A zone: a Control room column, by its mine, or the Work front's one zone. */
export type ValleZoneKey =
  { readonly preset: 'control'; readonly mineId: MineId } | { readonly preset: 'front' }

export interface ValleMosaicDeps {
  bridge: ValleMosaicBridge
  /** The stores read before the first paint, read again after Reset metrics (`useValleStores`). */
  stores: Readonly<Ref<ValleStores>>
  /** The Host's mines and dwarfs, and the facts heard after the snapshot (`createValleReadModel`). */
  model: {
    mines: Readonly<Ref<readonly MineWire[]>>
    dwarfs: Readonly<Ref<readonly DwarfWire[]>>
    onFacts(listener: (facts: readonly ValleFact[]) => void): () => void
  }
  /** The Host's facts were read once: the mosaic opens against them (S32.01, S32.02). */
  factsRead: Readonly<Ref<boolean>>
  /** Machine 28's view: the preset shown and both layouts. */
  view(): { preset: VallePreset; layouts: ValleLayouts }
  /** The Work front's mine, if known. */
  frontMine(): MineId | null
  /** Both layouts written at once through machine 28's view (A-N21 `valleLayout`). */
  writeLayouts(layouts: ValleLayouts): void
  /** "Dive in · Work front" (S31.07 → S28.03). */
  dive(mineId: MineId): void
  /** A map marker in the Work front's zone: that mine swapped in (S31.10 → S28.15). */
  swap?(mineId: MineId): void
  /** The window's one toast queue (BR-23). */
  showToast(text: string): void
  /** A column scrolled into view (S32.14). */
  scrollTo?(mineId: MineId): void
}

export interface ValleMosaicPart {
  /** The mosaic's columns, in order: empty until the Host's facts are read. */
  order: ComputedRef<readonly MineId[]>
  /** Machine 32's state (`idle` before the mosaic opened). */
  state: ComputedRef<MosaicState>
  /** What a Control room column shows. */
  contentOf(mineId: MineId): ZoneContent
  /** What the Work front's one zone shows. */
  frontContent: ComputedRef<ZoneContent>
  isMuted(mineId: MineId): boolean
  /** The zone menu open, with its entries, or `null`. */
  menu: ComputedRef<{ zone: ValleZoneKey; entries: readonly ZoneMenuEntry[] } | null>
  /** "⋯" in a zone header (S31.01); another menu open closes first. */
  openMenu(zone: ValleZoneKey): void
  /** An item of the open zone menu; a disabled one does nothing. */
  pickMenu(id: ZoneMenuItemId): void
  /** The add slot's menu, open, or `null`. */
  slot: ComputedRef<readonly SlotEntry[] | null>
  /** The add slot clicked (S32.04). */
  openSlot(): void
  /** A mine of the slot's menu (S32.05, S32.06). */
  pickSlot(mineId: MineId): void
  /** "A new project…" (S32.08). */
  newProject(): void
  /** Esc or an outside click: closes the open zone menu or slot menu; answers whether one was open. */
  dismiss(): boolean
  /** Why the last "A new project…" added nothing (S32.12), or `null`. */
  notice: Readonly<Ref<string | null>>
  /** The worktree question asked (US-MINES-004.AC03), or `null`. */
  worktree: Readonly<Ref<MineWorktreeOf | null>>
  adopting: Readonly<Ref<boolean>>
  answerWorktree(accept: boolean): void
  /** A jump, a reveal, a history request or a map marker for a mine (S32.14): its column added and scrolled to. */
  reveal(mineId: MineId): void
  /** A mine-history request from a chat in the Control room stack (S31.11). */
  historyRequest(mineId: MineId): void
  /** A map marker clicked in a zone showing the map (S31.10). */
  mapMarker(zone: ValleZoneKey, mineId: MineId): void
  /**
   * A hosted page's own close (the history's "Close history"): the zone shows its mine again, through its menu (S31.01,
   * S31.06), as "Show here: the mine" does.
   */
  showMine(zone: ValleZoneKey): void
}

const sameZone = (a: ValleZoneKey | null, b: ValleZoneKey): boolean =>
  a !== null &&
  a.preset === b.preset &&
  (a.preset === 'front' || (b.preset === 'control' && a.mineId === b.mineId))

export function useValleMosaic(deps: ValleMosaicDeps): ValleMosaicPart {
  /** `null` until the mosaic opened against the Host's facts, and again after Reset metrics. */
  const mosaic = shallowRef<Mosaic | null>(null)
  const muted = shallowRef<readonly MineId[]>(deps.stores.value.mutedMineIds)
  const openZone = shallowRef<ValleZoneKey | null>(null)
  const notice = shallowRef<string | null>(null)

  // A write UI main refuses or cannot take leaves the window as it is: the window never fails for it.
  const ignore = (): void => {}

  function facts(): MosaicFacts {
    const dwarfs = deps.model.dwarfs.value
    return {
      preset: deps.view().preset,
      mines: deps.model.mines.value.map((mine) => ({
        mineId: mine.id,
        name: mine.name,
        tier: mine.tier,
        enterable: mine.state !== 'unenterable',
        crew: dwarfs.filter((dwarf) => dwarf.mineId === mine.id).length
      }))
    }
  }

  function carryMosaic(effect: MosaicEffect): void {
    switch (effect.kind) {
      case 'write-order':
        void deps.bridge
          .setUiPreference({ key: 'valleMosaicOrder', value: [...effect.order] })
          .catch(ignore)
        return
      case 'toast':
        deps.showToast(effect.text)
        return
      case 'pick-folder':
        void folder.declare()
        return
      case 'scroll-to':
        deps.scrollTo?.(effect.mineId)
        return
    }
  }

  /** Steps machine 32; answers whether the input was taken. */
  function sendMosaic(input: MosaicInput): boolean {
    const current = mosaic.value
    if (current === null) return false
    const step = stepMosaic(current, input, facts())
    if (!step.ok) return false
    mosaic.value = step.mosaic
    step.effects.forEach(carryMosaic)
    return true
  }

  // S32.08…S32.12: the ordinary folder flow, each of its steps one of machine 32's.
  const folder = createFolderDeclare(deps.bridge, {
    picked: () => sendMosaic({ kind: 'folder-picked' }),
    cancelled: () => sendMosaic({ kind: 'folder-cancelled' }),
    declared: (mineId) => sendMosaic({ kind: 'declared', mineId }),
    failed: (reason) => {
      notice.value = reason
      sendMosaic({ kind: 'declare-failed' })
    }
  })

  /** S32.01 or S32.02, against the Host's facts and the stored order. */
  function open(): void {
    const step = openMosaic(deps.stores.value.mosaicOrder, facts())
    if (!step.ok) return
    mosaic.value = step.mosaic
    step.effects.forEach(carryMosaic)
  }

  const stopRead = watch(
    () => deps.factsRead.value,
    (read) => {
      if (read && mosaic.value === null) open()
    },
    { immediate: true }
  )
  // Reset metrics (S32.16, S31.14): UI main rewrote the stores; the mosaic opens anew from what was read again.
  const stopStores = watch(
    () => deps.stores.value,
    (stores) => {
      muted.value = stores.mutedMineIds
      openZone.value = null
      notice.value = null
      if (mosaic.value !== null) sendMosaic({ kind: 'reset-metrics' })
      if (deps.factsRead.value) open()
    }
  )

  /** What a zone shows. */
  function contentOf(mineId: MineId): ZoneContent {
    return deps.view().layouts.control.zones[mineId]?.content ?? 'mine'
  }
  const frontContent = computed((): ZoneContent => deps.view().layouts.front.zone.content)
  const isMuted = (mineId: MineId): boolean => muted.value.includes(mineId)

  function zoneMine(zone: ValleZoneKey): MineId | null {
    return zone.preset === 'control' ? zone.mineId : deps.frontMine()
  }

  function zoneState(zone: ValleZoneKey): ZoneState {
    const content = zone.preset === 'control' ? contentOf(zone.mineId) : frontContent.value
    return { content, menuOpen: sameZone(openZone.value, zone) }
  }

  function zoneFacts(zone: ValleZoneKey): ZoneFacts {
    const mineId = zoneMine(zone)
    const mine = deps.model.mines.value.find((each) => each.id === mineId)
    return {
      preset: zone.preset,
      enterable: mine !== undefined && mine.state !== 'unenterable',
      muted: mineId !== null && isMuted(mineId)
    }
  }

  /** The zone's content written at once into its preset's layout (A-N21 `valleLayout`); `null` drops a column's. */
  function writeContent(zone: ValleZoneKey, content: ZoneContent | null): void {
    const layouts = deps.view().layouts
    if (zone.preset === 'front') {
      const mineId = deps.frontMine()
      const front = {
        ...layouts.front,
        zone: { content: content ?? 'mine', ...(mineId ? { mineId } : {}) }
      }
      deps.writeLayouts({ ...layouts, front })
      return
    }
    const zones = { ...layouts.control.zones }
    if (content === null) {
      if (!(zone.mineId in zones)) return
      delete zones[zone.mineId]
    } else zones[zone.mineId] = { content }
    deps.writeLayouts({ ...layouts, control: { ...layouts.control, zones } })
  }

  function toggleAmbience(mineId: MineId, mute: boolean): void {
    const next = mute
      ? [...muted.value.filter((id) => id !== mineId), mineId]
      : muted.value.filter((id) => id !== mineId)
    muted.value = next
    void deps.bridge.setUiPreference({ key: 'mutedMineIds', value: [...next] }).catch(ignore)
  }

  function reveal(mineId: MineId): void {
    if (deps.view().preset === 'front') {
      deps.swap?.(mineId)
      return
    }
    // A column already shown is only scrolled to; one not in the mosaic is appended first (S32.14).
    if (!sendMosaic({ kind: 'reveal', mineId }) && order.value.includes(mineId))
      deps.scrollTo?.(mineId)
  }

  function carryZone(zone: ValleZoneKey, effect: ZoneEffect): void {
    const mineId = zoneMine(zone)
    switch (effect.kind) {
      case 'write-content':
        writeContent(zone, effect.content)
        return
      case 'dive':
        if (mineId !== null) deps.dive(mineId)
        return
      case 'toggle-ambience':
        if (mineId !== null) toggleAmbience(mineId, effect.muted)
        return
      case 'close-column':
        if (zone.preset === 'control') sendMosaic({ kind: 'close', mineId: zone.mineId })
        return
      case 'reveal':
        reveal(effect.mineId)
        return
      case 'gone':
        if (zone.preset === 'control') writeContent(zone, null)
        return
    }
  }

  /** Steps machine 31 for one zone; answers whether the input was taken. */
  function sendZone(zone: ValleZoneKey, input: ZoneInput): boolean {
    const step = stepZone(zoneState(zone), input, zoneFacts(zone))
    if (!step.ok) return false
    if (step.zone?.menuOpen) openZone.value = zone
    else if (sameZone(openZone.value, zone)) openZone.value = null
    step.effects.forEach((effect) => carryZone(zone, effect))
    return true
  }

  /** Closes what is open: a zone menu (S31.02) or the slot's menu (S32.07). */
  function dismiss(): boolean {
    const zone = openZone.value
    if (zone !== null) return sendZone(zone, { kind: 'dismiss' })
    return mosaic.value?.state === 'slot-menu' ? sendMosaic({ kind: 'dismiss' }) : false
  }

  // The Host removed a mine: its column and its zone leave (S32.13, S31.13).
  const stopFacts = deps.model.onFacts((heard) => {
    for (const fact of heard) {
      if (fact.kind !== 'mine-removed') continue
      const zone: ValleZoneKey = { preset: 'control', mineId: fact.mineId }
      if (order.value.includes(fact.mineId)) sendZone(zone, { kind: 'mine-removed' })
      sendMosaic({ kind: 'mine-removed', mineId: fact.mineId })
    }
  })

  if (getCurrentScope() !== undefined) {
    onScopeDispose(() => {
      stopRead()
      stopStores()
      stopFacts()
    })
  }

  const order = computed((): readonly MineId[] => {
    const shown = mosaic.value?.order ?? []
    // A mine removed while a menu or the folder flow was open has no column (S32.02's rule, applied as shown).
    const mines = deps.model.mines.value
    return shown.filter((mineId) => mines.some((mine) => mine.id === mineId))
  })

  return {
    order,
    state: computed((): MosaicState => mosaic.value?.state ?? 'idle'),
    contentOf,
    frontContent,
    isMuted,
    menu: computed(() => {
      const zone = openZone.value
      if (zone === null) return null
      return { zone, entries: zoneMenu(zoneState(zone).content, zoneFacts(zone)) }
    }),
    openMenu(zone) {
      if (sameZone(openZone.value, zone)) return
      dismiss()
      sendZone(zone, { kind: 'menu' })
    },
    pickMenu(id) {
      const zone = openZone.value
      if (zone !== null) sendZone(zone, zoneInputOf(id))
    },
    slot: computed(() => {
      const current = mosaic.value
      return current?.state === 'slot-menu' ? slotMenu(current, facts()) : null
    }),
    openSlot() {
      if (openZone.value !== null) dismiss()
      if (sendMosaic({ kind: 'slot' })) notice.value = null
    },
    pickSlot: (mineId) => void sendMosaic({ kind: 'pick', mineId }),
    newProject: () => void sendMosaic({ kind: 'new-project' }),
    dismiss,
    notice,
    worktree: folder.worktree,
    adopting: folder.adopting,
    answerWorktree: (accept) => void folder.answerWorktree(accept),
    reveal,
    historyRequest(mineId) {
      const zone: ValleZoneKey = { preset: 'control', mineId }
      // Its column added and scrolled to when needed, then the history shown in it (S31.11, S32.14).
      if (!order.value.includes(mineId)) reveal(mineId)
      else deps.scrollTo?.(mineId)
      if (order.value.includes(mineId)) sendZone(zone, { kind: 'history-request' })
    },
    mapMarker: (zone, mineId) => void sendZone(zone, { kind: 'map-marker', mineId }),
    showMine(zone) {
      if (!sameZone(openZone.value, zone)) {
        dismiss()
        sendZone(zone, { kind: 'menu' })
      }
      sendZone(zone, { kind: 'show', content: 'mine' })
    }
  }
}
