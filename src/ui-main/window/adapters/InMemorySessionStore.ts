// InMemorySessionStore: the adapter of the window module's `SessionStore` port and its own double (05 §3.14; 16 §4.14
// table): drafts and chat view state per dwarf, held in Electron main's memory only, so they die with the UI process
// and are never written to disk (ADR-024 items 1, 3; INV-113). A view is stored and answered as a copy, so no caller
// shares an object with the store.
import type { ChatViewState, DwarfId } from '@dwarfai/contracts'
import type { SessionStore } from '../ports/sessionStore'

export class InMemorySessionStore implements SessionStore {
  private readonly drafts = new Map<DwarfId, string>()
  private readonly views = new Map<DwarfId, ChatViewState>()

  draft(dwarfId: DwarfId): string {
    return this.drafts.get(dwarfId) ?? ''
  }

  setDraft(dwarfId: DwarfId, text: string): void {
    this.drafts.set(dwarfId, text)
  }

  view(dwarfId: DwarfId): ChatViewState | null {
    const view = this.views.get(dwarfId)
    return view === undefined ? null : structuredClone(view)
  }

  setView(dwarfId: DwarfId, v: ChatViewState): void {
    this.views.set(dwarfId, structuredClone(v))
  }

  dropDwarf(dwarfId: DwarfId): void {
    this.drafts.delete(dwarfId)
    this.views.delete(dwarfId)
  }
}
