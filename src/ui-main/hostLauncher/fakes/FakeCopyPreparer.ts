// The HostCopyPreparer double: answers each prepare with a scripted outcome and counts the calls.
// By default the copy is the source itself, so a test that is not about the copy sees the paths it
// configured. Never imported by production code (R14).
import type { HostCopyPreparer, PreparedHostCopy } from '../ports'

export class FakeCopyPreparer {
  prepared = 0
  outcome: PreparedHostCopy

  constructor(dir: string) {
    this.outcome = { ok: true, sourceDir: dir, contentDir: dir }
  }

  readonly prepare: HostCopyPreparer = () => {
    this.prepared += 1
    return Promise.resolve(this.outcome)
  }
}
