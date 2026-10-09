// The Host launcher's one entry point (05 §2.2): `ensureHostRunning()` through createHostLauncher
// (the rules, over ports) or createNodeHostLauncher (the same rules over the Node adapters, for UI
// main's composition root; wired by ISSUE-056), and the ADR-002 D8 upgrade handshake after `hello`
// (upgradeDecision, runUpgradeFlow over createNodeUpgradePorts; ISSUE-032), composed after every attach by
// createUpgradingLauncher (createNodeHostAttach gives both over one set of options); createNodeHostConnection
// is HostClient's connection to the same endpoint (ISSUE-051); createNodeHungHostEnder ends a hung Host after the
// identity check of ADR-002 D9 step 2 (ISSUE-052); createNodeRevertIntegrations runs the Host copy in the
// `--revert-integrations` mode and answers its exit code (ISSUE-225).
export {
  createHostLauncher,
  type EnsureHostResult,
  type HostLauncher,
  type HostLauncherDeps
} from './launcher'
export {
  createNodeHostAttach,
  createNodeHostConnection,
  createNodeHostLauncher,
  createNodeHungHostEnder,
  createNodeRevertIntegrations,
  createNodeUpgradePorts,
  nodeHostManifestPath,
  type NodeHostConnection,
  type NodeHostLauncherOptions,
  type NodeHungHostEnder,
  type NodeUpgradePorts
} from './nodeHostLauncher'
export { REVERT_INTEGRATIONS_FLAG, wantsRevertIntegrations } from './revertIntegrations'
export { endHungHost, type HungHostEnd, type HungHostPorts } from './hungHost'
export { decideUpgrade, type UpgradeDecision } from './upgradeDecision'
export {
  createUpgradingLauncher,
  type UpgradingLauncher,
  type UpgradingLaunchResult
} from './upgradingLauncher'
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
