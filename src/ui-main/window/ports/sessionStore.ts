// SessionStore: driven port of the window module, main half (05 §3.14; frozen copy 16 §4.14): the UI-main session
// store of ADR-024 items 1, 3, drafts and chat view state per dwarf, in memory only. Never persisted, never sent to the
// Host (INV-113); a dwarf's entries are dropped on its departure (INV-34). Adapter `InMemorySessionStore`, which is
// also its own double (16 §4.14 table). Type-only (16 §4.14; R2).
import type { ChatViewState, DwarfId } from '@dwarfai/contracts'

// verbatim: 05 §3.14 (the `SessionStore` interface, byte-for-byte; `prettier-ignore` keeps its alignment)
// prettier-ignore
export interface SessionStore {                                 // UI-main session store (ADR-024): drafts + ChatViewState per dwarf, never persisted
  draft(dwarfId: DwarfId): string; setDraft(dwarfId: DwarfId, text: string): void
  view(dwarfId: DwarfId): ChatViewState | null; setView(dwarfId: DwarfId, v: ChatViewState): void
  dropDwarf(dwarfId: DwarfId): void
}
// end verbatim: 05 §3.14
