// WindowFactory and the mode-window value types: driven port of the window module, main half (05 §3.14; frozen copy
// 16 §4.14). Adapter `ElectronWindows`, double `FakeWindowFactory` (16 §4.14 table).
// verbatim: 16 §4.14 — the added lines are the prettier-ignore directives that keep each declaration byte-identical and
// the eslint-disable lines for the three empty `extends ModeWindow` interfaces, which the frozen contract declares so.
// The one difference prettier cannot be kept from making: the run of spaces before `ModeWindow`'s trailing comment
// (three in 16 §4.14) is printed as one, because the comment lies outside the ignored declaration.
//
// `DisplayKey` and `Rect` are used by the frozen lines but declared by no owning document (07 N-13 notes that 06 does
// not list `DisplayKey`). Resolved here, as narrowly as the contract reads them: a display key is the string ADR-024 D5
// derives from stable display facts (never `display.id` alone, INV-118); a rectangle is Electron's own `Rectangle`
// shape in DIP.

/** ADR-024 D5: the stable key of a display, derived from stable display facts, never `display.id` alone (INV-118). */
export type DisplayKey = string

/** A rectangle in device-independent pixels, as Electron's `Rectangle` and `setBounds` take it. */
export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

// prettier-ignore
export interface WindowFactory { panel(): PanelWindow; veta(displayKey: DisplayKey): VetaWindow; valle(from: DisplayKey): ValleWindow } // keyed by ADR-024 D5 displayKey, never display.id
// prettier-ignore
export interface ModeWindow { placeAt(bounds: Rect): void; showInactive(): void; hide(): void; focus(): void; send(push: string, payload: unknown): void } // the members ADR-025 item 3 needs; push = a 14 §2.2 M→R member of this window (AMENDMENT-10, OQ-78)
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface PanelWindow extends ModeWindow {}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface VetaWindow extends ModeWindow {}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ValleWindow extends ModeWindow {}
