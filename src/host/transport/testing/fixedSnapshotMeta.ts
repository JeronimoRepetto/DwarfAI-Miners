// A SnapshotMetaSource with the cut-0 boot values (ISSUE-026 lead decision: a fresh database has
// `resetEpoch` 0 and no mine row), for the tests that compose the Host dispatcher but never read
// the snapshot. Test-only (R14).
import type { SnapshotMeta } from '@dwarfai/contracts'
import { SNAPSHOT_TAIL, type SnapshotMetaSource } from '../snapshot/metaSection'

export function fixedSnapshotMeta(
  state: () => SnapshotMeta['state'] = () => 'ready'
): SnapshotMetaSource {
  return {
    hostVersion: () => '0.20.0',
    state,
    resetEpoch: () => 0,
    snapshotTail: () => SNAPSHOT_TAIL,
    minesEverKnown: () => false
  }
}
