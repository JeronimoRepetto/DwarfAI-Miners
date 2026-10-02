// The ProcessIdentityProbe double: a set of live `(pid, processStartTimeMs)` identities. Like the real probe it
// compares start times with the one ADR-014 tolerance (IDENTITY_TOLERANCE_MS), as the ProcessIdentityProbe contract
// says (../testing/identityProbe.contract.ts). Never imported by production code (R14).
import type { ProcessIdentityProbe, ProcessStart } from '../ports'
import { IDENTITY_TOLERANCE_MS } from '../processStart'

export class FakeIdentityProbe {
  private readonly live: ProcessStart[] = []
  readonly asked: ProcessStart[] = []

  alive(owner: ProcessStart): this {
    this.live.push(owner)
    return this
  }

  dies(owner: ProcessStart): void {
    const at = this.live.findIndex(
      (process) =>
        process.pid === owner.pid && process.processStartTimeMs === owner.processStartTimeMs
    )
    if (at >= 0) this.live.splice(at, 1)
  }

  readonly probe: ProcessIdentityProbe = (owner) => {
    this.asked.push(owner)
    return Promise.resolve(
      this.live.some(
        (process) =>
          process.pid === owner.pid &&
          Math.abs(process.processStartTimeMs - owner.processStartTimeMs) <= IDENTITY_TOLERANCE_MS
      )
    )
  }
}
