// The Host's lifecycle state (07 machine 12A; ADR-002 D6, D8): the one holder of the state and the
// job status that `hello.ok` (ADR-003 item 5), HOST_NOT_READY (14 §3.3) and `SnapshotMeta.state`
// read, and the HostStateSink the boot reports into (S12.04–S12.06). The upgrade handshake reports
// `upgrade-pending` into it (S12.13, later: ISSUE-032).
//
// Every change — of the state or of the job status — is published as `host.state` (B-F04), which
// reaches the `ui` connections only (14 §2.4; the `notifier` never receives it, 14 I-18). A report
// equal to the current one changes nothing and publishes nothing.
//
// Until the boot's first report — only between the bind and the end of boot step 1 — the state is
// `starting` (S12.04) and the job status is not known yet, so it reads `n/a`; the boot reports the
// real one with `starting` as soon as step 1 ends.
import type { HostFrameName } from '@dwarfai/contracts'
import type { HostStateReport, HostStateSink } from '../../wiring/boot'
import type { FramePublisher } from '../connectionRegistry'

/**
 * The frames the Host lifecycle publishes, for `hello.ok.capabilities` (14 §1.3): `host.state`
 * here, `host.closing` from the clean exit (cleanExit.ts).
 */
export const LIFECYCLE_FRAMES: readonly HostFrameName[] = Object.freeze([
  'host.state',
  'host.closing'
])

export class HostStateHolder implements HostStateSink {
  private latest: HostStateReport = { state: 'starting', jobStatus: 'n/a' }

  constructor(private readonly frames: FramePublisher) {}

  report(report: HostStateReport): void {
    const { state, jobStatus } = report
    if (state === this.latest.state && jobStatus === this.latest.jobStatus) return
    this.latest = { state, jobStatus }
    this.frames.publish('host.state', { state, jobStatus })
  }

  current(): HostStateReport {
    return this.latest
  }
}
