// The Host recovery report of ADR-015 item 5 (canonical owner), copied field for field: ADR-015
// wins on any difference, and this copy is then a defect. `contracts/wire` carries the same type
// for the wire (`host.recovered`, 14 §3.6); the Host module states it here because a module's
// domain imports no `contracts` (05 §2.2, R1). Pure types.

/** ADR-015 item 5 `UnrecoveredReason`. */
export type UnrecoveredReason =
  | 'turn-lost' // a turn was in progress on a stdio driver; the session itself may have resumed
  | 'no-resume' // the driver has resume === 'none'
  | 'stale-ref' // the provider no longer knows the session id
  | 'resume-error' // the provider refused or failed the resume
  | 'end-failed' // a surviving stdio process could not be ended (item 4)

/** ADR-015 item 5 `HostRecoveryReport` (ids are spelled `string` by the owner). */
export interface HostRecoveryReport {
  hostEpoch: string
  at: number
  resumed: string[] // dwarfIds; diagnostics only, never shown
  unrecovered: Array<{
    dwarfId: string
    reason: UnrecoveredReason
    messageIds?: string[] // sends marked ✕ host-interrupted (ADR-022), listed here instead of their own notice
  }>
}
