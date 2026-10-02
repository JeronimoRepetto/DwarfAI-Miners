// AutostartPort: driven port of the window module, main half (05 §3.14; frozen copy 16 §4.14): the per-OS login entry
// that starts the app with `--background` at OS login (ADR-027 item 7). `set(true)` writes or repairs the entry,
// `set(false)` removes it (a missing entry is already removed); either throws when the OS refuses. `get()` reads the
// entry back: `true` only when it exists, points at the app's launch path and starts at login, so an entry the person
// disabled in the OS's own startup list reads `false`, and `set(true)` never re-enables one (ADR-027 item 7; what each
// OS reports is S-027-4's). Adapter `ElectronAutostart`, double `FakeAutostartPort` (16 §4.14 table).
// verbatim: 16 §4.14 — the one added line is the prettier-ignore directive that keeps it byte-identical.

// prettier-ignore
export interface AutostartPort { get(): boolean; set(on: boolean): void } // login starts UI, Host or both: ADR-027 input
