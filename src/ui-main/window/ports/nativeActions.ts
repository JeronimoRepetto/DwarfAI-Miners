// FilePicker, ClipboardPort, ExternalOpener: driven ports of the window module, main half (05 §3.14; frozen copy
// 16 §4.14). Native and user-initiated; a cancelled picker answers `[]` (16 §4.14 table). Adapters
// `ElectronFilePicker`, `ElectronClipboard`, `ElectronExternalOpener`; doubles `Fake*` each (16 §4.14 table).
// verbatim: 16 §4.14 — the added lines are the prettier-ignore directives that keep each one byte-identical.
//
// `FolderPicker` (16 §4.14) is not declared here: its one caller, A-30's folder picker, is built with
// `mines.declare` (ISSUE-091), which declares it beside its adapter.

/**
 * Package gap: 16 §4.14 names `WindowRef` as the parent of a picker but does not define it. It is an opaque handle on
 * one window of the app, the window's Electron id, so the port never carries an Electron object; the picker adapter
 * resolves it to the window the dialog is attached to.
 */
export interface WindowRef {
  readonly windowId: number
}

// prettier-ignore
export interface FilePicker { pickMany(parent: WindowRef): Promise<string[]> }
// prettier-ignore
export interface ClipboardPort { write(text: string): void }
// prettier-ignore
export interface ExternalOpener { openPath(p: string): Promise<string | null>; openExternal(url: string): Promise<void> }
