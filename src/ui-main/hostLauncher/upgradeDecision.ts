// The ADR-002 D8 decision the UI takes after `hello` when it meets the running Host (07 S12.B01–
// S12.B03; 13 FM-131…FM-133; UC-026), as one pure table:
//
// | the Host's answer                                   | decision                                 |
// | --------------------------------------------------- | ---------------------------------------- |
// | an older `endpointGeneration`, or refused as one    | blocking-notice-then-upgrade-drain (D8.4) |
// | a newer `endpointGeneration`                        | incompatible-offer-stop-all (D8.5)        |
// | same generation, same `protocolVersion`             | attach (D8.1)                            |
// | same generation, a lower `protocolVersion` (newer UI) | attach-compat-and-request-upgrade (D8.2) |
// | same generation, a higher `protocolVersion` (older UI) | incompatible-offer-stop-all (D8.5)     |
//
// - `protocolVersion` only tells compat apart (14 §1.3): it never gates a feature; what the Host
//   serves is read from `hello.ok.capabilities` (upgradeFlow.ts).
// - The app versions never decide: two builds with one `protocolVersion` changed nothing on the
//   wire, so they attach normally (D8 item 1). The UI's version names the target of the upgrade.
// - An upgrade never goes towards an older version (D8 item 5, IR-21-08): an older UI is never told
//   to request one, whatever the generation.
// - A Host refuses a hello of another generation with INCOMPATIBLE_GENERATION (ADR-003 item 5); a
//   newer UI meets it from an older Host (UC-026), since a newer Host still answers the older
//   generation's hello (17 §1.6).

export interface UiBuildFacts {
  /** This UI build's private protocol version (contracts PROTOCOL_VERSION). */
  protocolVersion: number
  /** The generation this UI build speaks first (ADR-003 item 5; `1` in v1). */
  endpointGeneration: number
  /** This UI build's app version: the name of its versioned copy (ADR-002 D5). */
  appVersion: string
}

/** What the running Host answered to this UI's hello. */
export type HostAnswerFacts =
  | { kind: 'hello-ok'; protocolVersion: number; endpointGeneration: number; hostVersion: string }
  /** The Host refused the hello with INCOMPATIBLE_GENERATION. */
  | { kind: 'incompatible-generation' }

export type UpgradeDecision =
  /** D8 item 1: a normal attach (S12.B01). */
  | 'attach'
  /** D8 item 2: compat mode, then `host.upgrade.request` (S12.B02; FM-131). */
  | 'attach-compat-and-request-upgrade'
  /** D8 item 4: the blocking notice; `host.shutdown {upgrade-drain}` only on confirmation (FM-132). */
  | 'blocking-notice-then-upgrade-drain'
  /** D8 item 5: incompatible; only Stop everything and quit is offered (FM-133). */
  | 'incompatible-offer-stop-all'

export function decideUpgrade(ui: UiBuildFacts, host: HostAnswerFacts): UpgradeDecision {
  if (host.kind === 'incompatible-generation') return 'blocking-notice-then-upgrade-drain'
  if (host.endpointGeneration > ui.endpointGeneration) return 'incompatible-offer-stop-all'
  if (host.protocolVersion > ui.protocolVersion) return 'incompatible-offer-stop-all'
  if (host.endpointGeneration < ui.endpointGeneration) return 'blocking-notice-then-upgrade-drain'
  if (host.protocolVersion === ui.protocolVersion) return 'attach'
  return 'attach-compat-and-request-upgrade'
}
