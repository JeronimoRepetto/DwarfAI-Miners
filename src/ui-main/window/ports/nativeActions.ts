// FilePicker, ClipboardPort, ExternalOpener: driven ports of the window module, main half (05 §3.14; frozen copy
// 16 §4.14). Native and user-initiated; a cancelled picker answers `[]` (16 §4.14 table). Adapters
// `ElectronFilePicker`, `ElectronClipboard`, `ElectronExternalOpener`; doubles `Fake*` each (16 §4.14 table).
// verbatim: 16 §4.14 — the added lines are the prettier-ignore directives that keep each one byte-identical, and the
// amendment header above `ClipboardPort`.
//
// `FolderPicker` (16 §4.14) is not declared here: its one caller, A-30's folder picker, is built with
// `mines.declare` (ISSUE-091), which declares it beside its adapter.

import type { ConsoleTarget } from '@dwarfai/contracts'

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
// Owner-approved amendment (2026-10-01, ISSUE-050): `write` answers a promise (was `void`). Electron 44's clipboard is
// asynchronous, so a write that fails after the call must be seen, and `copyText` then answers `copied: false`.
// prettier-ignore
export interface ClipboardPort { write(text: string): Promise<void> }
// prettier-ignore
export interface ExternalOpener { openPath(p: string): Promise<string | null>; openExternal(url: string): Promise<void> }

/**
 * Package gap (16 §4.14 names `NativeActions.raiseConsole(t)` and UC-036 a `WindowRaiser` in UI main, with no port of
 * their own): the driven port behind `raiseConsole` (ISSUE-170), one console target executed right after the person's
 * click (ADR-031 item 4): a `focus-terminal` target raises the window of that process, a `log` target opens the OS
 * terminal running its command, with no shell (05 R17). `'raised'` when it was done, `'failed'` otherwise (no toast,
 * PO #42). Adapter `TerminalConsoleRaiser`.
 */
export interface ConsoleRaiser {
  raise(t: ConsoleTarget): Promise<'raised' | 'failed'>
}
