// The OpenCode plugin asks (ADR-011 item 7; ADR-016 item 4; ADR-010 item 10; 08 §4 "the caller
// resolves SessionRef → dwarfId before calling"): what a `permission.asked` report of DwarfAI's
// OpenCode plugin becomes in the Host broker, and the address the person's answer goes to.
//
// - The report's session is resolved to its dwarf and folder through the lookup the Host binds
//   (wiring/routes/asking.ts: observation's `ProviderIdentity → DwarfId` index, whose `cwd` is the
//   session's folder). Then one `open(dwarfId, input)` on the `http` channel: a permission whose
//   tool is OpenCode's permission kind, whose line is that kind and its patterns, redacted and cut
//   to one line (ADR-007 item 4), with Allow once and Deny reject both offered (15 §2.7: OpenCode
//   lists `once`, `always`, `reject`). `open` is idempotent by `(dwarfId, providerRequestId)`
//   (INV-71), so a report sent twice opens one ask. What the ask becomes is the broker's emission
//   from the session's capabilities (ADR-011 item 5), which the Host gates on
//   `opencode-permissions` (ADR-011 item 7): a card while it is `on-verified`; otherwise a launched
//   session's request is `auto-denied` with one chat line and answered Deny on this same channel,
//   and an observed session's is no ask at all (the broker refuses it; one
//   `asking.plugin-evidence.refused` record).
// - Before `open`, the server origin and the session's folder are recorded for the request
//   (`targetOf`, read by OpenCodePluginAskChannel.ts), because an auto-denied request is answered
//   from inside `open`. A refused `open` forgets them. At most `MAX_TARGETS` are kept, the oldest
//   forgotten first: an answer to a forgotten request is `not-open`.
// - A report whose session observation has not matched yet (a session started a moment ago) is
//   tried again after each delay of `OPENCODE_REPORT_RETRY_MS` (the ingress route nudged the
//   observer for it), then dropped with one `asking.plugin-evidence.unmatched` record: OpenCode
//   reports an ask once, so without a retry its card would never open. At most
//   `MAX_PENDING_REPORTS` wait at once.
// - Evidence, never a command (ADR-016 item 4): nothing here answers an ask; `permission.replied`
//   reports are not read (SP-09 has no passed record, so a reply made elsewhere is never claimed,
//   21 §2 4a: `answeredElsewhere: false`).
//
// Package gaps (resolved here, recorded in the PR): the retry delays (1, 2, 4 and 8 s, 15 s in all,
// longer than observation's poll period) and the two caps.
//
// Evaluated candidate: the legacy `src/main/opencodePermissions/openCodePermissionRegistry.ts`
// (found tree) — replaced. It kept its own ask state for asks pushed by the `permission.ask` hook,
// which OpenCode 1.18.32 never calls (S-011-1); the broker owns ask state (ADR-010), and only the
// answer address is kept here.
import { HostInvariantError } from '../../../../kernel/domain/errors'
import type { DwarfId } from '../../../../kernel/domain/values'
import type { DiagnosticsLog } from '../../../../kernel/ports/diagnosticsLog'
import type { Scheduler } from '../../../../kernel/ports/scheduler'
import type { AskInput } from '../../../suppliers'
import type { AskBroker } from '../../application/askBroker'
import type { OpenCodeAnswerTarget, OpenCodeAnswerTargets } from './OpenCodePluginAskChannel'

/** The delays after which a report of a session not yet matched is tried again. */
export const OPENCODE_REPORT_RETRY_MS: readonly number[] = Object.freeze([
  1_000, 2_000, 4_000, 8_000
])
/** The answer addresses kept at once. */
const MAX_TARGETS = 256
/** The reports waiting for their session at once. */
const MAX_PENDING_REPORTS = 64
/** The provider the plugin reports on (catalog id), for diagnostics. */
const OPENCODE_PROVIDER_ID = 'opencode'

/** A `permission.asked` report of the plugin, as the ingress route accepted it. */
export interface OpenCodePermissionReport {
  readonly sessionId: string
  /** OpenCode's permission id: the ask's `providerRequestId`. */
  readonly requestId: string
  /** OpenCode's permission kind (`edit`, `bash`, …). */
  readonly permission: string
  readonly patterns: readonly string[]
  /** `http://<loopback>:<port>` of the server that asked. */
  readonly serverOrigin: string
}

/** The dwarf an OpenCode session belongs to, and the session's folder. */
export interface OpenCodePluginSession {
  readonly dwarfId: DwarfId
  readonly directory: string
}

export interface OpenCodePluginAsksDeps {
  /** The session's dwarf and folder, or `null` while no dwarf carries it. */
  sessionOf(providerSessionId: string): OpenCodePluginSession | null
  asks: Pick<AskBroker, 'open'>
  /** The one redaction rule (`contracts/logging` `redactSecrets`), bound by the Host (05 R9). */
  redact(text: string): string
  scheduler: Scheduler
  log: DiagnosticsLog
}

export class OpenCodePluginAsks implements OpenCodeAnswerTargets {
  private readonly targets = new Map<string, OpenCodeAnswerTarget>()
  private pending = 0

  constructor(private readonly deps: OpenCodePluginAsksDeps) {}

  /** Opens the report's ask now, or once its session is known; never throws. */
  report(report: OpenCodePermissionReport): void {
    if (this.tryOpen(report)) return
    if (this.pending >= MAX_PENDING_REPORTS) return this.record('asking.plugin-evidence.unmatched')
    this.pending += 1
    this.retry(report, 0)
  }

  targetOf(dwarfId: DwarfId, providerRequestId: string): OpenCodeAnswerTarget | null {
    return this.targets.get(keyOf(dwarfId, providerRequestId)) ?? null
  }

  private retry(report: OpenCodePermissionReport, attempt: number): void {
    const delay = OPENCODE_REPORT_RETRY_MS[attempt]
    if (delay === undefined) {
      this.pending -= 1
      return this.record('asking.plugin-evidence.unmatched')
    }
    this.deps.scheduler.after(delay, () => {
      if (this.tryOpen(report)) this.pending -= 1
      else this.retry(report, attempt + 1)
    })
  }

  /** False only while the report's session is not known yet. */
  private tryOpen(report: OpenCodePermissionReport): boolean {
    let session: OpenCodePluginSession | null
    try {
      session = this.deps.sessionOf(report.sessionId)
    } catch {
      session = null
    }
    if (session === null) return false
    const key = keyOf(session.dwarfId, report.requestId)
    this.remember(key, { serverOrigin: report.serverOrigin, directory: session.directory })
    try {
      this.deps.asks.open(session.dwarfId, this.inputOf(report))
    } catch (error) {
      this.targets.delete(key)
      this.record(
        error instanceof HostInvariantError
          ? 'asking.plugin-evidence.refused'
          : 'asking.plugin-evidence.failed',
        session.dwarfId
      )
    }
    return true
  }

  private inputOf(report: OpenCodePermissionReport): AskInput {
    const line =
      report.patterns.length === 0
        ? report.permission
        : `${report.permission}: ${report.patterns.join(', ')}`
    return {
      kind: 'permission',
      providerRequestId: report.requestId,
      channel: 'http',
      payload: {
        toolName: report.permission,
        requestText: this.deps.redact(line.split(/\r?\n/)[0] ?? '')
      },
      options: { hasAllowOnce: true, hasRejectOnce: true }
    }
  }

  private remember(key: string, target: OpenCodeAnswerTarget): void {
    this.targets.delete(key)
    this.targets.set(key, target)
    if (this.targets.size <= MAX_TARGETS) return
    const oldest = this.targets.keys().next().value
    if (oldest !== undefined) this.targets.delete(oldest)
  }

  /** One record with allowlisted fields only (19 §7): never an id, a pattern or an address. */
  private record(event: string, dwarfId?: DwarfId): void {
    this.deps.log.record({
      level: 'warn',
      event,
      subsystem: 'asking',
      provider: OPENCODE_PROVIDER_ID,
      ...(dwarfId === undefined ? {} : { dwarfId })
    })
  }
}

const keyOf = (dwarfId: DwarfId, providerRequestId: string): string =>
  `${dwarfId}\n${providerRequestId}`
