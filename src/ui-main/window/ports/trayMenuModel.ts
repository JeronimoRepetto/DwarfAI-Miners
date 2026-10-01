// TrayMenuModel: the menu the `TrayController` port shows (./trayController.ts; 05 §3.14; frozen copy 16 §4.14). The
// port names it and no other document defines it, so it is fixed here from the sentence that names it (05 §3.14):
// "Open, Quit … and, after a separator, Stop everything and quit". Each item carries the label it shows (design's copy,
// ADR-002 O-3) and what choosing it runs. Type-only (R2).

/** The items the tray menu holds (05 §3.14 `TrayMenuModel`). */
export type TrayMenuItemId = 'open' | 'quit' | 'stop-everything'

/** One entry of the tray menu: an item the person can choose, or the separator before the secondary action. */
export type TrayMenuEntry =
  { kind: 'item'; id: TrayMenuItemId; label: string; choose(): void } | { kind: 'separator' }

/** The tray menu, in the order it shows. */
export type TrayMenuModel = readonly TrayMenuEntry[]
