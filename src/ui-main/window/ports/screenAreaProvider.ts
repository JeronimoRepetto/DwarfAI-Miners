// ScreenAreaProvider: driven port of the window module, main half (05 §3.14; frozen copy 16 §4.14). Adapter
// `ElectronScreenArea` ← `platform/screenArea.ts`, `windowMetrics.ts`; double `FakeScreenAreaProvider` (16 §4.14 table).
// verbatim: 16 §4.14 — the one added line is the prettier-ignore directive that keeps the declaration byte-identical.
// The one difference prettier cannot be kept from making: the run of spaces before the trailing comment (three in
// 16 §4.14) is printed as one, because the comment lies outside the ignored declaration.
//
// `DisplayInfo` is used by the frozen line but declared by no owning document (16 §4.14 says only that it "carries its
// displayKey"). Resolved here, as narrowly as the window module reads it: the display's key (ADR-024 D5), its whole
// rectangle, its work area, and whether it is the primary display (where a window with no display of its own docks,
// ADR-024 D5 "the default place on the primary display").
import type { DisplayKey, Rect } from './windowFactory'

/** One display as the window module sees it, keyed by its ADR-024 D5 `displayKey`, never `display.id` alone. */
export interface DisplayInfo {
  readonly displayKey: DisplayKey
  /** The whole display. */
  readonly bounds: Rect
  /** What is left once the OS reserved its own furniture (taskbar, Dock, top bar): what the Panel may span. */
  readonly workArea: Rect
  readonly primary: boolean
}

// prettier-ignore
export interface ScreenAreaProvider { workArea(displayKey: DisplayKey): Rect; bounds(displayKey: DisplayKey): Rect; displays(): DisplayInfo[] } // DisplayInfo carries its displayKey
