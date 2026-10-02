// The crew module (05 §3.2): a mine's dwarfs. So far machine 1, the dwarf status (ADR-032): the
// four-value status derived from persisted facts, and the timer that moves an idle dwarf to asleep;
// and machine 2, presence (07 §2): rank by depth, the pending end of each end, the one departure.
export type { DwarfStatusChanged } from './domain/events'
export type { Dwarf, DwarfArrival } from './domain/dwarf'
export {
  departureCause,
  type DepartureCause,
  type DwarfPresence,
  type DwarfProcessState,
  type EndReason
} from './domain/presence'
export { rankForDepth, type DwarfRank } from './domain/rank'
export {
  ASLEEP_AFTER_MS,
  classifyDwarfStatus,
  type DwarfStatus,
  type StatusFacts
} from './domain/status'
export { StatusTimer, type StatusTimerDeps } from './application/statusTimer'
