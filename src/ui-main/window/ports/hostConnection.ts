// HostConnection: ADR-002 D9's state type, the state of the HostClient port (05 §3.14; 16 §4.14.1 "Name"). Type-only.
//
// The copy below is byte-for-byte its owner's (AGENTS §9). Its last line ends in a trailing comment that lies outside
// the type alias, where no `prettier-ignore` reaches, so this file holds the copy alone and is listed in
// .prettierignore; everything else stays formatted by prettier.

// verbatim: ADR-002 D9 (the `HostConnection` type, byte-for-byte)
type HostConnection =
  | { state: 'connecting' }                          // spawn/readiness, ≤ 15 s (+30 s while migrating)
  | { state: 'connected'; hostVersion: string; compat: boolean }
  | { state: 'reconnecting'; since: number }         // lost after being connected
  | { state: 'unavailable'; reason: 'spawn-failed' | 'crash-loop' | 'incompatible' | 'elevated-refused' | 'in-job'
      | 'unresponsive'     // a hung Host whose endpoint stays bound (AR-13-02, AMENDMENT-2; `14` is canonical)
      | 'generation-restart'; restart?: { resumable: number; waiting: number } }   // D8 item 4 (AMENDMENT-11, OQ-79)
// end verbatim: ADR-002 D9

export type { HostConnection }
