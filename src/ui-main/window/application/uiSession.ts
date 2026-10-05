// The UI-main session store (ADR-024 items 1, 3; ADR-033 item 4; 14 §2.2 A-N17…A-N19, §3.9): the state of the app run
// that every window shares and no window owns — the draft and the chat view state per dwarf (in the `SessionStore`
// port), the partial picks of an open question, the open chat and the current mine per host, Valle's session fields
// and Veta's risen chat. Renderers read it whole (A-N17) and change it one patch at a time (A-N18); each patch reaches
// every other mode window with the window it came from (A-N19), so each window mirrors the store.
//
// - Never persisted, never sent to the Host (INV-113): no patch kind reaches the client; the one thing asked of it is
//   to hear the Host's frames.
// - A dwarf's entries are dropped when the Host reports its departure (`dwarf.departed`, INV-34; 07 S2.04): its draft,
//   chat view, open chat per host, Valle's `talkedTo` entries, `focusedPin` and `secondPaneDwarfId` (14 §3.9 comment).
//   UI main emits the patches that say so to every window, with `origin: 'hidden'`, the one `WindowMode` no mode
//   window runs in: no window sent them.
// - Cleared whole on every entry into tray-only (07 S10.14, S10.15; NFR-PERS-06): no window exists then, so nothing is
//   pushed; the next window reads the empty store.
// - The store hears the Host only while it holds something: it subscribes at its first patch and unsubscribes when it
//   is cleared, so an empty store, and tray-only, keep no subscription and so no `ui` connection (ADR-003 item 12).
import {
  dwarfIdSchema,
  type ChannelKey,
  type DwarfId,
  type UiSessionChange,
  type UiSessionPatch,
  type UiSessionSnapshot,
  type WindowMode
} from '@dwarfai/contracts'
import type { HostClient, HostEvent } from '../ports/hostClient'
import type { SessionStore } from '../ports/sessionStore'

/** A-N19 `onUiSessionChanged` (14 §2.2). */
export const UI_SESSION_CHANGED_PUSH = 'ui:session:changed' satisfies ChannelKey

/** The origin of a patch UI main emits itself (on a departure): no mode window runs in `hidden`. */
const FROM_UI_MAIN: WindowMode = 'hidden'

/**
 * The B-F08 frame name (14 §3.5). Its catalog entry and data schema land with the issue that publishes it (later:
 * ISSUE-082), so the frame is recognised by name and only its `dwarfId` is read, checked as a DwarfId.
 */
const DWARF_DEPARTED = 'dwarf.departed'

/** A chat with no stored view shows its latest messages: the view a dropped one leaves behind (ADR-024 item 3). */
const NO_STORED_VIEW = { scrollAnchor: 'bottom' } as const

/** An open mode window, as the pushes reach it. */
export interface UiSessionWindow {
  readonly webContentsId: number
  send(push: string, payload: unknown): void
}

/** The window a patch came from: its `webContents` and its mode. */
export interface UiSessionOrigin {
  webContentsId: number
  mode: WindowMode
}

export interface UiSessionDeps {
  /** Drafts and chat view state per dwarf (ADR-024 item 3). */
  store: SessionStore
  /** The open mode windows. */
  windows(): readonly UiSessionWindow[]
  /** The Host's frames, for `dwarf.departed`, heard while the store holds something; nothing is sent through it. */
  host: Pick<HostClient, 'subscribe'>
}

export interface UiSession {
  /** A-N17: the whole store now. */
  get(): UiSessionSnapshot
  /** A-N18: applies one patch and pushes it (A-N19) to every other mode window with its origin's mode. */
  patch(p: UiSessionPatch, origin: UiSessionOrigin): void
  /** Drops a departed dwarf's entries and pushes the patches to every mode window (INV-34). */
  dropDwarf(dwarfId: DwarfId): void
  /** Empties the store: UI main entered tray-only (S10.14, S10.15). */
  clear(): void
  /** Reset metrics (ADR-024 item 8): empties the store but for the drafts (INV-113); nothing is pushed (14 §3.9). */
  clearExceptDrafts(): void
  /** Stops hearing the Host's frames (the app is closing). */
  dispose(): void
}

/** The fields of the snapshot kept here; drafts and chat views are in the `SessionStore`. */
type SessionFields = Omit<UiSessionSnapshot, 'drafts' | 'chatViews'>

const emptyFields = (): SessionFields => ({
  askPicks: {},
  openChat: {},
  currentMine: {},
  valle: {}
})

const OPEN_CHAT_HOSTS = ['panel', 'veta', 'valle'] as const

/** The dwarf a `dwarf.departed` frame reports, or null for any other event. */
function departedDwarfOf(event: HostEvent): DwarfId | null {
  if (event.kind !== 'frame') return null
  const name: string = event.frame.name
  if (name !== DWARF_DEPARTED) return null
  const data = event.frame.data as { dwarfId?: unknown } | null
  const dwarfId = dwarfIdSchema.safeParse(data?.dwarfId)
  return dwarfId.success ? dwarfId.data : null
}

export function createUiSession(deps: UiSessionDeps): UiSession {
  const { store, windows } = deps
  /** The dwarfs the store may hold a draft or a view for (the port has no listing). */
  const dwarfs = new Set<DwarfId>()
  let fields = emptyFields()

  function apply(p: UiSessionPatch): void {
    switch (p.kind) {
      case 'draft':
        store.setDraft(p.dwarfId, p.text)
        dwarfs.add(p.dwarfId)
        return
      case 'chat-view':
        store.setView(p.dwarfId, p.view)
        dwarfs.add(p.dwarfId)
        return
      case 'ask-picks':
        if (p.picks === null) delete fields.askPicks[p.askId]
        else fields.askPicks[p.askId] = structuredClone(p.picks)
        return
      case 'open-chat':
        fields.openChat[p.host] = p.dwarfId
        return
      case 'current-mine':
        fields.currentMine[p.host] = p.mineId
        return
      case 'valle':
        // A patch of Valle's fields: each field it carries replaces that field.
        for (const [key, value] of Object.entries(structuredClone(p.patch))) {
          if (value !== undefined) Object.assign(fields.valle, { [key]: value })
        }
        return
      case 'veta-risen-chat':
        fields.vetaRisenChat = p.dwarfId
        return
    }
  }

  function push(change: UiSessionChange, except?: number): void {
    for (const window of windows()) {
      if (window.webContentsId !== except) window.send(UI_SESSION_CHANGED_PUSH, change)
    }
  }

  /** The patches that drop `dwarfId`'s entries other than its draft and view, each applied here. */
  function departurePatches(dwarfId: DwarfId): UiSessionPatch[] {
    const patches: UiSessionPatch[] = []
    for (const host of OPEN_CHAT_HOSTS) {
      if (fields.openChat[host] === dwarfId)
        patches.push({ kind: 'open-chat', host, dwarfId: null })
    }
    const valle: UiSessionSnapshot['valle'] = {}
    const talkedTo = fields.valle.talkedTo
    if (talkedTo !== undefined && Object.values(talkedTo).includes(dwarfId)) {
      valle.talkedTo = Object.fromEntries(
        Object.entries(talkedTo).filter(([, talked]) => talked !== dwarfId)
      ) as typeof talkedTo
    }
    if (fields.valle.focusedPin === dwarfId) valle.focusedPin = null
    if (fields.valle.secondPaneDwarfId === dwarfId) valle.secondPaneDwarfId = null
    if (Object.keys(valle).length > 0) patches.push({ kind: 'valle', patch: valle })
    for (const patch of patches) apply(patch)
    return patches
  }

  function dropDwarf(dwarfId: DwarfId): void {
    const patches: UiSessionPatch[] = []
    if (store.draft(dwarfId) !== '') patches.push({ kind: 'draft', dwarfId, text: '' })
    if (store.view(dwarfId) !== null) {
      patches.push({ kind: 'chat-view', dwarfId, view: structuredClone(NO_STORED_VIEW) })
    }
    store.dropDwarf(dwarfId)
    dwarfs.delete(dwarfId)
    patches.push(...departurePatches(dwarfId))
    for (const patch of patches) push({ ...patch, origin: FROM_UI_MAIN })
  }

  /** Stops the Host subscription; null while the store holds nothing. */
  let unsubscribe: (() => void) | null = null
  function stopListening(): void {
    unsubscribe?.()
    unsubscribe = null
  }

  return {
    get() {
      const drafts: UiSessionSnapshot['drafts'] = {} as UiSessionSnapshot['drafts']
      const chatViews: UiSessionSnapshot['chatViews'] = {} as UiSessionSnapshot['chatViews']
      for (const dwarfId of dwarfs) {
        const draft = store.draft(dwarfId)
        if (draft !== '') drafts[dwarfId] = draft
        const view = store.view(dwarfId)
        if (view !== null) chatViews[dwarfId] = view
      }
      return { drafts, chatViews, ...structuredClone(fields) }
    },
    patch(p, origin) {
      unsubscribe ??= deps.host.subscribe((event) => {
        const dwarfId = departedDwarfOf(event)
        if (dwarfId !== null) dropDwarf(dwarfId)
      })
      apply(p)
      push({ ...p, origin: origin.mode }, origin.webContentsId)
    },
    dropDwarf,
    clear() {
      for (const dwarfId of dwarfs) store.dropDwarf(dwarfId)
      dwarfs.clear()
      fields = emptyFields()
      stopListening()
    },
    clearExceptDrafts() {
      for (const dwarfId of [...dwarfs]) {
        const draft = store.draft(dwarfId)
        store.dropDwarf(dwarfId)
        // INV-113: a draft is UI-memory only and survives the reset (ADR-024 item 8).
        if (draft === '') dwarfs.delete(dwarfId)
        else store.setDraft(dwarfId, draft)
      }
      fields = emptyFields()
      if (dwarfs.size === 0) stopListening()
    },
    dispose: stopListening
  }
}
