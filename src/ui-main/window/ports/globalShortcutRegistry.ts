// GlobalShortcutRegistry: driven port of the window module, main half (05 §3.14; frozen copy 16 §4.14).
// Adapter `ElectronGlobalShortcut` ← `shell/shortcuts.ts`, double `FakeGlobalShortcutRegistry` (16 §4.14 table):
// `register` answers `false` when the combination is taken (by another application, or by another registrant of this
// process), and never throws.
// verbatim: 16 §4.14 — the one added line is the prettier-ignore directive that keeps it byte-identical.

// prettier-ignore
export interface GlobalShortcutRegistry { register(accel: string, onFire: () => void): boolean; unregister(accel: string): void }
