/*
 * The Valle stores (07 S39.03, S39.10, S39.13; ADR-024 items 1, 4, 8; 14 §3.9 A-N17, A-N20, A-N12; ISSUE-299): what the
 * Valle window reads before its first paint — the persisted `vallePreset`, `valleLayout`, `valleMosaicOrder`, `pins`,
 * `valleLastFrontMineId` and `mutedMineIds`, and the session's Valle fields — and reads again after Reset metrics.
 *
 * - The root mounts only once both reads answered (`readValleStores`, `main.ts`), so the first paint is the stored
 *   layout, never the defaults corrected a frame later.
 * - A key UI main does not answer, or a read that fails, opens on that store's default: UI main's store already fell
 *   back to its defaults and logged `uiprefs.corrupt` for a file it could not use (FM-053); the window never fails to
 *   open for it. A default here is the "never written" value 14 §3.9 gives each key (`null` for the mosaic order and the
 *   pins, so the first-visit rules apply), the Control room preset (ADR-024 item 8), and no stored layout (`null`: each
 *   preset's own defaults apply, machines 28 and 33).
 * - A-N12 (Reset metrics, S39.10): UI main rewrote the stores to defaults and cleared the session but for drafts; the
 *   window reads both again and applies what it is told.
 *
 * The bridge is injected (the house idiom over `vi.mock`); `main.ts` hands it the page's own `window.api`.
 */
import {
  uiSessionSnapshotSchema,
  type DwarfId,
  type MineId,
  type UiPreferenceKey,
  type UiPreferencesMap,
  type UiSessionSnapshot
} from '@dwarfai/contracts'
import { getCurrentScope, onScopeDispose, shallowRef, type Ref } from 'vue'

/** The persisted Valle keys of 14 §3.9 `UiPreferencesMap` (A-N20). */
export const VALLE_STORE_KEYS = [
  'vallePreset',
  'valleLayout',
  'valleMosaicOrder',
  'pins',
  'valleLastFrontMineId',
  'mutedMineIds'
] as const satisfies readonly UiPreferenceKey[]

/** What the Valle window opens on. */
export interface ValleStores {
  readonly preset: UiPreferencesMap['vallePreset']
  /** `null`: no layout stored, each preset's own defaults apply. */
  readonly layout: UiPreferencesMap['valleLayout'] | null
  readonly mosaicOrder: UiPreferencesMap['valleMosaicOrder']
  readonly pins: UiPreferencesMap['pins']
  readonly lastFrontMineId: UiPreferencesMap['valleLastFrontMineId']
  readonly mutedMineIds: UiPreferencesMap['mutedMineIds']
  /** The session's Valle fields (A-N17): its view state, its open chat and its current mine. */
  readonly session: {
    readonly valle: UiSessionSnapshot['valle']
    readonly openChat: DwarfId | null
    readonly currentMine: MineId | null
    /**
     * The Panel's open chat, when it has one: the chat talked to last before Valle opened, for the start-up pins
     * (07 S29.01, N-16, §24 I-29; ISSUE-302).
     */
    readonly panelOpenChat?: DwarfId
  }
}

/** Each store's default: never written (14 §3.9), the Control room preset (ADR-024 item 8), no stored layout. */
export const VALLE_STORE_DEFAULTS: ValleStores = {
  preset: 'control',
  layout: null,
  mosaicOrder: null,
  pins: null,
  lastFrontMineId: null,
  mutedMineIds: [],
  session: { valle: {}, openChat: null, currentMine: null }
}

/** The seam A members the stores read (14 A-N17, A-N20, A-N12). */
export interface ValleStoresBridge {
  getUiPreferences(request: { keys: UiPreferenceKey[] }): Promise<Partial<UiPreferencesMap>>
  getUiSession(): Promise<unknown>
  onUiPreferencesReset(listener: (payload: unknown) => void): () => void
}

async function preferences(bridge: ValleStoresBridge): Promise<Partial<UiPreferencesMap>> {
  try {
    return await bridge.getUiPreferences({ keys: [...VALLE_STORE_KEYS] })
  } catch {
    return {}
  }
}

async function session(bridge: ValleStoresBridge): Promise<ValleStores['session']> {
  let answered: unknown
  try {
    answered = await bridge.getUiSession()
  } catch {
    return VALLE_STORE_DEFAULTS.session
  }
  const parsed = uiSessionSnapshotSchema.safeParse(answered)
  if (!parsed.success) return VALLE_STORE_DEFAULTS.session
  const snapshot = parsed.data as UiSessionSnapshot
  return {
    valle: snapshot.valle,
    openChat: snapshot.openChat.valle ?? null,
    currentMine: snapshot.currentMine.valle ?? null,
    ...(snapshot.openChat.panel ? { panelOpenChat: snapshot.openChat.panel } : {})
  }
}

/** S39.03: the stores and the session, each key on its default when it is not answered. Never rejects. */
export async function readValleStores(bridge: ValleStoresBridge): Promise<ValleStores> {
  const stored = await preferences(bridge)
  const d = VALLE_STORE_DEFAULTS
  return {
    preset: stored.vallePreset ?? d.preset,
    layout: stored.valleLayout ?? d.layout,
    mosaicOrder: stored.valleMosaicOrder ?? d.mosaicOrder,
    pins: stored.pins ?? d.pins,
    lastFrontMineId: stored.valleLastFrontMineId ?? d.lastFrontMineId,
    mutedMineIds: stored.mutedMineIds ?? d.mutedMineIds,
    session: await session(bridge)
  }
}

export interface ValleStoresPart {
  /** What the window shows from; the root's first paint is `initial`. */
  stores: Readonly<Ref<ValleStores>>
}

/** The stores read before the first paint (`initial`), read again after each Reset metrics (S39.10). */
export function useValleStores(bridge: ValleStoresBridge, initial: ValleStores): ValleStoresPart {
  const stores = shallowRef<ValleStores>(initial)
  let reading = 0
  const stop = bridge.onUiPreferencesReset(() => {
    // The latest reset wins: an earlier read that answers after it is dropped.
    reading += 1
    const mine = reading
    void readValleStores(bridge).then((read) => {
      if (mine === reading) stores.value = read
    })
  })
  if (getCurrentScope() !== undefined) onScopeDispose(stop)
  return { stores }
}
