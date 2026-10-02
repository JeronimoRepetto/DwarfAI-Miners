// The HostCopyPreparer double: answers each prepare with a scripted outcome and counts the calls.
// By default the copy is `copyDir`, a folder that is not the app directory, as ADR-002 D5 and the
// HostCopyPreparer contract (../testing/copyPreparer.contract.ts) require: the Host never runs from
// the install folder. Never imported by production code (R14).
import type { HostCopyPreparer, PreparedHostCopy } from '../ports'

export class FakeCopyPreparer {
  prepared = 0
  outcome: PreparedHostCopy

  /** `dir`: the app directory the copy is made from; `copyDir`: where its copy is (`<copy root>/<version>`). */
  constructor(dir: string, copyDir: string) {
    this.outcome = { ok: true, sourceDir: dir, contentDir: copyDir }
  }

  readonly prepare: HostCopyPreparer = () => {
    this.prepared += 1
    return Promise.resolve(this.outcome)
  }
}
