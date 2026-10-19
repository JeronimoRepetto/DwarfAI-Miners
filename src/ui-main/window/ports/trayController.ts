// TrayController: driven port of the window module, main half (05 §3.14; frozen copy 16 §4.14). Adapter
// `ElectronTray` ← `shell/tray.ts` (R), double `FakeTrayController` (16 §4.14 table). The tray/menu-bar icon of the
// tray process, shown for the Host's whole life (ADR-018 item 5; ADR-002 D7): `create` shows the icon with its menu,
// `destroy` removes it, and only when the Host exits. Where the desktop has no system tray, `create` throws (13
// FM-050: "`TrayController.create` fails"). Its menu type is ./trayMenuModel.ts. Type-only (R2).
//
// The copy below is byte-for-byte its owner's (AGENTS §9). Its trailing comment lies outside the interface, where no
// `prettier-ignore` reaches, so this file holds the copy alone and is listed in .prettierignore.
import type { TrayMenuModel } from './trayMenuModel'

export type { TrayMenuEntry, TrayMenuItemId, TrayMenuModel } from './trayMenuModel'

// verbatim: 16 §4.14 (the `TrayController` line, byte-for-byte)
export interface TrayController { create(menu: TrayMenuModel): void; destroy(): void }   // tray/menu-bar icon whenever the Host runs (OQ-40 A); TrayMenuModel = Open, Quit (closes windows, icon stays, ends no session; OQ-44, OQ-47) and, after a separator, Stop everything and quit (confirmation, then stop-all; OQ-47, ADR-018 D5); destroy() only when the Host exits
// end verbatim: 16 §4.14
