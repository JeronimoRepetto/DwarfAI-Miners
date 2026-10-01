// B-M04 `session.snapshot` (14 §2.3, §3.7, §4; ADR-003 items 4, 7, frozen): a `ui` connection
// subscribes first, then reads the snapshot page by page (snapshot/snapshotService.ts); a
// `notifier` reads its names sections only; a `viewer` gets FORBIDDEN from the role table. The
// result is sensitive (14 §1.10, §3.5): the dispatcher never logs it.
//
// The params are the contract's, narrowed by the Host's own rules before anything runs
// (INVALID_PARAMS, like host.shutdown's served modes):
// - every requested section is registered, so advertised as `section:<name>` (14 §4.4);
// - a first read names no `cursor`; a continuation names its `snapshotId` and `cursor`, and no
//   `sections` (they were fixed when the snapshot was built).
import { HOST_METHOD_SCHEMAS, type SnapshotPage } from '@dwarfai/contracts'
import type { Dispatcher } from '../dispatcher'
import { METHOD_ROLES } from '../roles'
import type { SectionRegistry } from '../snapshot/sectionRegistry'
import type { SnapshotService } from '../snapshot/snapshotService'

export interface SessionSnapshotDeps {
  sections: SectionRegistry
  service: SnapshotService
}

/** Serves `session.snapshot` on `dispatcher`. */
export function registerSessionSnapshot(dispatcher: Dispatcher, deps: SessionSnapshotDeps): void {
  const params = HOST_METHOD_SCHEMAS['session.snapshot'].params.refine((p) => {
    const continuation = p.snapshotId !== undefined || p.cursor !== undefined
    if (continuation) {
      return p.snapshotId !== undefined && p.cursor !== undefined && p.sections === undefined
    }
    return (p.sections ?? []).every((name) => deps.sections.get(name) !== undefined)
  })
  dispatcher.register(
    'session.snapshot',
    params,
    METHOD_ROLES['session.snapshot'] ?? [],
    (snapshotParams, context): SnapshotPage => deps.service.read(snapshotParams, context)
  )
}
