// The Host's lifecycle state as the transport reads it for `hello.ok` (ADR-003 item 5) and for
// HOST_NOT_READY (14 §3.3): the HostStateSink the boot reports into (07 machine 12A, S12.04–S12.06).
// The `host.state` frame that pushes each change to attached clients is ISSUE-028's.
//
// Until the boot's first report — only between the bind and the end of boot step 1 — the state is
// `starting` (S12.04) and the job status is not known yet, so it reads `n/a`; the boot reports the
// real one with `starting` as soon as step 1 ends.
import type { HostStateReport, HostStateSink } from '../wiring/boot'

export class HostStateHolder implements HostStateSink {
  private latest: HostStateReport = { state: 'starting', jobStatus: 'n/a' }

  report(report: HostStateReport): void {
    this.latest = { ...report }
  }

  current(): HostStateReport {
    return this.latest
  }
}
