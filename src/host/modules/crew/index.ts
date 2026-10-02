// The crew module (05 §3.2): a mine's dwarfs. So far machine 1, the dwarf status (ADR-032): the
// four-value status derived from persisted facts, and the timer that moves an idle dwarf to asleep.
export type { DwarfStatusChanged } from './domain/events'
export {
  ASLEEP_AFTER_MS,
  classifyDwarfStatus,
  type DwarfStatus,
  type StatusFacts
} from './domain/status'
export { StatusTimer, type StatusTimerDeps } from './application/statusTimer'
