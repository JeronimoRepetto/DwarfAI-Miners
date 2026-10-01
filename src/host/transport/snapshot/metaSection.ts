// The snapshot's `meta` section (14 §3.7 `SnapshotMeta`, §4.1, frozen): the Host's own section, read
// by `ui` only. Its values come from the SnapshotMetaSource the composition root binds (ISSUE-026
// lead decision): the boot state gives `hostVersion`, the lifecycle `state` (HostStateHolder) and
// `snapshotTail`; `resetEpoch` reads `app_meta` (HostDatabase, ISSUE-039) and `minesEverKnown`
// reads the `mines` table (later: ISSUE-082), which at cut 0 is empty, so `false` is its true value.
import type { SnapshotMeta } from '@dwarfai/contracts'
import type { SectionProvider } from './sectionRegistry'

/** 14 §4.1: the newest `SNAPSHOT_TAIL = 20` messages per present dwarf (architect value). */
export const SNAPSHOT_TAIL = 20

/** Where the `meta` section reads each of its values, at the instant the snapshot is built. */
export interface SnapshotMetaSource {
  hostVersion(): string
  state(): SnapshotMeta['state']
  resetEpoch(): number
  snapshotTail(): number
  minesEverKnown(): boolean
}

/** The `meta` provider over `source`. */
export function metaSection(source: SnapshotMetaSource): SectionProvider<'meta'> {
  return () => ({
    hostVersion: source.hostVersion(),
    state: source.state(),
    resetEpoch: source.resetEpoch(),
    snapshotTail: source.snapshotTail(),
    minesEverKnown: source.minesEverKnown()
  })
}
