// The UI half of the ADR-002 D8 upgrade handshake (UC-026; ADR-027 item 4; 07 S12.B01–S12.B03,
// S12.B16; 13 FM-131…FM-133): what UI main does when its build and the running Host differ.
// After `hello` (attach 'current') it takes the decision of upgradeDecision.ts and then:
//
// - attach: nothing else happens here (S12.B01).
// - compat (a newer UI, same generation; FM-131): it reports compat mode, makes or reuses its own
//   versioned copy (`prepareTarget`, ADR-002 D5) and sends `host.upgrade.request {targetVersion,
//   targetDir}` (B-M06), then waits. The old Host drains when nothing is open (which may take as
//   long as a session that cannot resume runs, S12.15) and closes with `host.closing
//   {reason:'upgrade'}`; only then is the new Host started from that copy through
//   `ensureHostRunning` (ADR-002 D4), never while the old one holds the endpoint (D8 item 3).
// - blocking notice (a different generation; FM-132): it reports `generation-restart` and asks the
//   person. Declined: nothing is sent and the old Host keeps its sessions. Confirmed: it speaks the
//   previous generation for `hello` (14 §1.3) and sends the generation-stable `host.shutdown
//   {mode:'upgrade-drain'}` (B-M05, AMENDMENT-2), then waits as above (S12.B16). Dormant in v1,
//   where generation 1 is the only one: there is no previous generation to speak.
// - incompatible (an older UI; FM-133, D8 item 5): it reports `incompatible` and never sends
//   `host.upgrade.request` — an upgrade never goes towards an older version. It offers only Stop
//   everything and quit: confirmed, `host.shutdown {mode:'stop-all'}`; once that Host has closed
//   (`host.closing {reason:'stop-all'}`) it starts its own Host. A stop-all that could not end
//   every owned session keeps the Host running (S12.21): nothing is started.
//
// Only methods the Host lists in `hello.ok.capabilities` are ever sent (14 §1.3; ADR-027 item 4);
// an unlisted one leaves the UI as it is. A close the Host announced with `host.closing` is
// DwarfAI's own stop: it is reported as `restarting`, never as a lost connection, and nothing here
// raises the PO #62 "stopped unexpectedly" toast (ADR-002 D8). A connection that closes without
// `host.closing` is `lost`: the ordinary reconnect rule of ADR-002 D9 owns it (HostClient,
// ISSUE-051), not this flow.
//
// The reported phases are what HostClient maps onto `HostConnectionView` (14 §3.8: `connected` with
// `compat`, `unavailable` with `incompatible` or `generation-restart`, `connecting`); the notice and
// confirmation copy are design's (ADR-027 DG, O-5). Each decision is logged as `host.upgrade`
// (19 §9.1) with the decision as its cause class, never a path or a version.
import {
  isAdvertised,
  methodCapability,
  type DwarfId,
  type HelloOk,
  type HostMethods,
  type ProtocolErrorCode
} from '@dwarfai/contracts'
import type { UiLog, UiLogEntry } from '../diagnostics/uiLogger'
import type { CallAnswer, ClosingReason } from '../host-client/channel'
import type { EnsureHostResult } from './launcher'
import { decideUpgrade, type UiBuildFacts } from './upgradeDecision'

/** The two seam-B methods the handshake sends. */
export type LinkMethod = 'host.upgrade.request' | 'host.shutdown'

/** A call's answer and the `host.closing` reason: the one seam-B connection's own types (ISSUE-051). */
export type { CallAnswer, ClosingReason }

/**
 * One authenticated `ui` connection to the running Host (ADR-003 item 12): what the handshake
 * needs of the UI side of seam B. hostLink.ts is its Node adapter, over host-client/channel.ts,
 * the connection HostClient (ISSUE-051) holds its own connections with.
 */
export interface HostLink {
  /** What the Host answered to this connection's `hello`. */
  readonly helloOk: HelloOk
  /** Sends one request on this connection and resolves with its answer. */
  call<M extends LinkMethod>(
    method: M,
    params: HostMethods[M]['params']
  ): Promise<CallAnswer<HostMethods[M]['result']>>
  /**
   * Settles once the connection closed: with the reason of the `host.closing` the Host sent before
   * it, or null when it closed without one (a crash, a lost connection, or `close()`).
   */
  readonly closed: Promise<ClosingReason | null>
  close(): void
}

/** One connect-and-`hello` with role `ui`. */
export type HostAttach =
  | { kind: 'attached'; link: HostLink }
  /** The Host answered with a protocol error frame (INCOMPATIBLE_GENERATION, AUTH_FAILED, …). */
  | { kind: 'refused'; code: ProtocolErrorCode }
  | { kind: 'unreachable' }

/** What the flow reports while it runs, for HostClient's connection state. */
export type UpgradeFlowState =
  /** `connected`, not compat (S12.B01). */
  | { phase: 'attached'; compat: false; hostVersion: string }
  /** `connected` in compat mode (S12.B02). */
  | { phase: 'compat'; hostVersion: string }
  /** `unavailable {reason:'generation-restart'}`: the blocking notice (S12.B03). */
  | { phase: 'generation-restart' }
  /** `unavailable {reason:'incompatible'}`: only Stop everything and quit (S12.B03). */
  | { phase: 'incompatible'; hostVersion: string }
  /** `connecting`: the old Host closed on purpose and a Host is being started (S12.B16). */
  | { phase: 'restarting'; reason: 'upgrade' | 'stop-all' }

export type UpgradeFlowResult =
  | { kind: 'attached'; link: HostLink }
  /** Compat mode stays: the upgrade was not requested, or the Host refused it. */
  | { kind: 'compat'; link: HostLink; upgrade: 'not-advertised' | 'target-unavailable' | 'refused' }
  /** The old Host drained and closed; the new Host was ensured from this UI's copy. */
  | { kind: 'swapped'; ensure: EnsureHostResult }
  /** The newer Host stopped everything and closed; this UI's own Host was ensured. */
  | { kind: 'own-host'; ensure: EnsureHostResult }
  /** The person declined the notice or the stop-all: nothing was sent. */
  | { kind: 'declined' }
  | { kind: 'stop-all-incomplete'; link: HostLink; failed: DwarfId[] }
  /** The confirmed restart could not be asked: no previous-generation `hello`, or refused. */
  | { kind: 'restart-unavailable' }
  /** The connection closed without `host.closing`: ADR-002 D9's reconnect rule owns it. */
  | { kind: 'lost' }
  | { kind: 'not-attached'; first: Exclude<HostAttach, { kind: 'attached' }> }

export interface UpgradeFlowDeps {
  build: UiBuildFacts
  /** Opens a `ui` connection; 'previous' speaks generation N-1 for `hello` (ADR-002 D8 item 4). */
  attach(generation: 'current' | 'previous'): Promise<HostAttach>
  /** Makes or reuses this UI's versioned copy `host/<appVersion>/` (ADR-002 D5). */
  prepareTarget(): Promise<
    { ok: true; targetVersion: string; targetDir: string } | { ok: false; errCode: string }
  >
  /** ADR-002 D4: attach to or spawn the Host (launcher.ts). */
  ensureHostRunning(): Promise<EnsureHostResult>
  /** The person's answer to the blocking notice or the stop-all confirmation (copy: design). */
  confirm(question: 'generation-restart' | 'stop-everything'): Promise<boolean>
  report(state: UpgradeFlowState): void
  /** A UUIDv7 per intent (14 §1.6). */
  newRequestId(): string
  log: UiLog
}

const EVENT = 'host.upgrade'
const SUBSYSTEM = 'host-launcher'

export async function runUpgradeFlow(deps: UpgradeFlowDeps): Promise<UpgradeFlowResult> {
  const record = (entry: Omit<UiLogEntry, 'event' | 'subsystem'>): void =>
    deps.log.record({ ...entry, event: EVENT, subsystem: SUBSYSTEM })

  const first = await deps.attach('current')
  if (first.kind === 'unreachable') return { kind: 'not-attached', first }
  if (first.kind === 'refused' && first.code !== 'INCOMPATIBLE_GENERATION') {
    return { kind: 'not-attached', first }
  }
  const decision = decideUpgrade(
    deps.build,
    first.kind === 'refused'
      ? { kind: 'incompatible-generation' }
      : {
          kind: 'hello-ok',
          protocolVersion: first.link.helloOk.protocolVersion,
          endpointGeneration: first.link.helloOk.endpointGeneration,
          hostVersion: first.link.helloOk.hostVersion
        }
  )
  record({ level: 'info', outcome: 'ok', causeClass: decision })

  if (decision === 'blocking-notice-then-upgrade-drain') {
    if (first.kind === 'attached') first.link.close()
    return restartOlderGeneration(deps)
  }
  if (first.kind !== 'attached') return { kind: 'not-attached', first }
  const { link } = first
  const hostVersion = link.helloOk.hostVersion

  switch (decision) {
    case 'attach':
      deps.report({ phase: 'attached', compat: false, hostVersion })
      return { kind: 'attached', link }
    case 'attach-compat-and-request-upgrade':
      deps.report({ phase: 'compat', hostVersion })
      return requestUpgrade(deps, link, record)
    case 'incompatible-offer-stop-all':
      deps.report({ phase: 'incompatible', hostVersion })
      return stopNewerHost(deps, link)
  }
}

/** D8 item 2: compat mode, then `host.upgrade.request`; the new Host once the old one closed. */
async function requestUpgrade(
  deps: UpgradeFlowDeps,
  link: HostLink,
  record: (entry: Omit<UiLogEntry, 'event' | 'subsystem'>) => void
): Promise<UpgradeFlowResult> {
  if (!advertises(link, 'host.upgrade.request')) {
    return { kind: 'compat', link, upgrade: 'not-advertised' }
  }
  const target = await deps.prepareTarget()
  if (!target.ok) {
    record({ level: 'warn', outcome: 'failed', causeClass: 'target', errCode: target.errCode })
    return { kind: 'compat', link, upgrade: 'target-unavailable' }
  }
  const answer = await link.call('host.upgrade.request', {
    targetVersion: target.targetVersion,
    targetDir: target.targetDir,
    requestId: deps.newRequestId()
  })
  if (!answer.ok) {
    record({ level: 'warn', outcome: 'failed', causeClass: 'request', errCode: answer.error.code })
    return { kind: 'compat', link, upgrade: 'refused' }
  }
  return startAfterClose(deps, link, 'upgrade')
}

/** D8 item 4: the blocking notice; the generation-stable drain only on the person's confirmation. */
async function restartOlderGeneration(deps: UpgradeFlowDeps): Promise<UpgradeFlowResult> {
  deps.report({ phase: 'generation-restart' })
  if (!(await deps.confirm('generation-restart'))) return { kind: 'declined' }
  const previous = await deps.attach('previous')
  if (previous.kind !== 'attached' || !advertises(previous.link, 'host.shutdown')) {
    if (previous.kind === 'attached') previous.link.close()
    return { kind: 'restart-unavailable' }
  }
  const answer = await previous.link.call('host.shutdown', {
    mode: 'upgrade-drain',
    requestId: deps.newRequestId()
  })
  if (!answer.ok) {
    previous.link.close()
    return { kind: 'restart-unavailable' }
  }
  return startAfterClose(deps, previous.link, 'upgrade')
}

/** D8 item 5: an older UI offers only Stop everything and quit, then starts its own Host. */
async function stopNewerHost(deps: UpgradeFlowDeps, link: HostLink): Promise<UpgradeFlowResult> {
  if (!advertises(link, 'host.shutdown')) return { kind: 'declined' }
  if (!(await deps.confirm('stop-everything'))) return { kind: 'declined' }
  const answer = await link.call('host.shutdown', {
    mode: 'stop-all',
    requestId: deps.newRequestId()
  })
  if (answer.ok && answer.result.mode === 'stop-all' && answer.result.outcome.failed.length > 0) {
    return { kind: 'stop-all-incomplete', link, failed: answer.result.outcome.failed }
  }
  return startAfterClose(deps, link, 'stop-all')
}

/**
 * Waits for the Host to close the connection. Announced with `host.closing {reason}` as asked, it
 * is DwarfAI's own stop: `restarting`, then ensureHostRunning. Anything else is `lost`.
 */
async function startAfterClose(
  deps: UpgradeFlowDeps,
  link: HostLink,
  expected: 'upgrade' | 'stop-all'
): Promise<UpgradeFlowResult> {
  const reason = await link.closed
  if (reason !== expected) return { kind: 'lost' }
  deps.report({ phase: 'restarting', reason: expected })
  const ensure = await deps.ensureHostRunning()
  return expected === 'upgrade' ? { kind: 'swapped', ensure } : { kind: 'own-host', ensure }
}

function advertises(link: HostLink, method: LinkMethod): boolean {
  return isAdvertised(link.helloOk.capabilities, methodCapability(method))
}
