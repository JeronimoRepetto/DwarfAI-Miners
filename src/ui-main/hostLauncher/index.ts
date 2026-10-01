// The Host launcher's one entry point (05 §2.2): `ensureHostRunning()` through createHostLauncher
// (the rules, over ports) or createNodeHostLauncher (the same rules over the Node adapters, for UI
// main's composition root; wired by ISSUE-056).
export {
  createHostLauncher,
  type EnsureHostResult,
  type HostLauncher,
  type HostLauncherDeps
} from './launcher'
export { createNodeHostLauncher, type NodeHostLauncherOptions } from './nodeHostLauncher'
export { HOST_SPAWN_GATE_STALE_MS } from './spawnGate'
export {
  LOSER_POLL_MS,
  MIGRATING_EXTENSION_MS,
  READINESS_BUDGET_MS,
  READINESS_POLL_MS
} from './readiness'
