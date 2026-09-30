// PanelWindowController: driving port of the window module, main half (05 §3.14; frozen copy 16 §4.14).
// verbatim: 16 §4.14 — the one added line is the prettier-ignore directive that keeps it byte-identical.
//
// `show()` shows the Panel window if it is hidden and brings it to the front (S10.02: "brings the
// window forward, showing it if hidden"); the port has no separate focus member, so bringing forward
// is part of showing. `PanelLayout` and `PanelLayoutRequest` are the seam A shapes of the Panel
// layout rows (`panel:layout:get` / `panel:layout:set`, 14 §2.1), taken from the channel registry,
// never restated.
import type { z } from 'zod'
import type { CHANNELS } from '@dwarfai/contracts'

export type PanelLayout = z.infer<(typeof CHANNELS)['panel:layout:get']['response']>
export type PanelLayoutRequest = z.infer<(typeof CHANNELS)['panel:layout:set']['request']>

// prettier-ignore
export interface PanelWindowController { hide(): void; show(): void; toggleVisible(): void; setAlwaysOnTop(on: boolean): boolean; layout(): PanelLayout; setLayout(r: PanelLayoutRequest): PanelLayout }
