// SingleInstanceLock: driven port of the window module, main half (05 §3.14; frozen copy 16 §4.14).
// Adapter `ElectronSingleInstanceLock`, double `FakeSingleInstanceLock` (16 §4.14 table).
// verbatim: 16 §4.14 — the one added line is the prettier-ignore directive that keeps it byte-identical.

// prettier-ignore
export interface SingleInstanceLock { acquire(): boolean; onSecondLaunch(h: () => void): void }
