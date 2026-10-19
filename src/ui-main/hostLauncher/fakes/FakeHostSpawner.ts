// The HostSpawner double: records every request and answers with a scripted outcome. A launched
// fake Host exits only when the test calls `exit(code)`; `release()` ends the watch, so its
// `exited` answers null, as the HostSpawner contract says (../testing/hostSpawner.contract.ts).
// Never imported by production code (R14).
import type { HostSpawnRequest, HostSpawner, LaunchOutcome, LaunchedHost } from '../ports'

export class FakeHostSpawner {
  readonly requests: HostSpawnRequest[] = []
  /** What the next spawn answers; `launched` builds a fresh fake Host. */
  outcome: 'launched' | Exclude<LaunchOutcome, { kind: 'launched' }> = 'launched'
  /** Called after each launch, e.g. to make the endpoint answer. */
  onLaunch: () => void = () => {}
  released = 0
  private exitHost: (code: number | null) => void = () => {}

  readonly spawn: HostSpawner = (request) => {
    this.requests.push(request)
    if (this.outcome !== 'launched') return Promise.resolve(this.outcome)
    let settle: (code: number | null) => void = () => {}
    const exited = new Promise<number | null>((resolve) => {
      settle = resolve
    })
    this.exitHost = settle
    const host: LaunchedHost = {
      how: 'detached',
      exited,
      release: () => {
        this.released += 1
        settle(null)
      }
    }
    this.onLaunch()
    return Promise.resolve({ kind: 'launched', host })
  }

  /** The last launched fake Host exits with `code`. */
  exit(code: number | null): void {
    this.exitHost(code)
  }
}
