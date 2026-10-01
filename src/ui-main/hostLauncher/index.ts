// The Host launcher's one entry point (05 §2.2): `ensureHostRunning()` through createHostLauncher
// (the rules, over ports) or createNodeHostLauncher (the same rules over the Node adapters, for UI
// main's composition root; wired by ISSUE-056), and the ADR-002 D8 upgrade handshake after `hello`
// (upgradeDecision, runUpgradeFlow over createNodeUpgradePorts; ISSUE-032).
export {
  createHostLauncher,
  type EnsureHostResult,
  type HostLauncher,
  type HostLauncherDeps
} from './launcher'
export {
  createNodeHostLauncher,
  createNodeUpgradePorts,
  type NodeHostLauncherOptions,
  type NodeUpgradePorts
} from './nodeHostLauncher'
export { decideUpgrade, type UpgradeDecision } from './upgradeDecision'
export {
  runUpgradeFlow,
  type HostAttach,
  type HostLink,
  type UpgradeFlowDeps,
  type UpgradeFlowResult,
  type UpgradeFlowState
} from './upgradeFlow'
export { HOST_SPAWN_GATE_STALE_MS } from './spawnGate'
export { winLaunchPrebuildsDir } from './win-launch/nativeWinLaunch'
export {
  LOSER_POLL_MS,
  MIGRATING_EXTENSION_MS,
  READINESS_BUDGET_MS,
  READINESS_POLL_MS
} from './readiness'
