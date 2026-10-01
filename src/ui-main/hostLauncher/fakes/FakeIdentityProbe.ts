// The ProcessIdentityProbe double: a set of live `(pid, processStartTimeMs)` identities. Never
// imported by production code (R14).
import type { ProcessIdentityProbe, ProcessStart } from '../ports'

export class FakeIdentityProbe {
  private readonly live = new Set<string>()
  readonly asked: ProcessStart[] = []

  alive(owner: ProcessStart): this {
    this.live.add(key(owner))
    return this
  }

  dies(owner: ProcessStart): void {
    this.live.delete(key(owner))
  }

  readonly probe: ProcessIdentityProbe = (owner) => {
    this.asked.push(owner)
    return Promise.resolve(this.live.has(key(owner)))
  }
}

function key(owner: ProcessStart): string {
  return `${owner.pid}@${owner.processStartTimeMs}`
}
