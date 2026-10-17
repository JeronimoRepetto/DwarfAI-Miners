import { computed, readonly, shallowRef } from 'vue'
import type {
  HostFrame,
  HostFrames,
  HostRecoveryReportView,
  SnapshotChunk
} from '@dwarfai/contracts'
import { createReadModel, followHost, type HostFollower } from './readModel'
import { mintRequestId } from './requestIds'
import { useHostConnection } from './useHostConnection'

/*
 * The grouped recovery message's read model (14 §6.4 row "new recovery-message store": singleton; snapshot `recovery`
 * + B-F21 `host.recovered`; A-N10, A-N11; PO #90; ADR-015 item 5; 07 machine 16; ADR-033 items 2–3).
 *
 * - One report at a time (INV-58: one report per Host epoch): the snapshot's `recovery` section sets it with its seq,
 *   and a `host.recovered` frame above that seq replaces it whole. The message shows while the Host holds a report
 *   that is not `settled`, whatever else its state (`pending-display`, `shown`, `retrying`): the Host keeps it in
 *   every `ui` snapshot until it settles, so a window that closed before the person acted shows it again at the next
 *   attach (S16.08; 13 FM-023). Nothing is kept across a reload.
 * - `retry()` sends A-N10 `retryRecovery` and `dismiss()` A-N11 `dismissRecovery`, once each, with the report's
 *   `hostEpoch` and one UUIDv7 per intent (14 §1.6), one action at a time. The message follows the answer: Retry's
 *   settled report replaces the one shown; Dismiss's empty value settles it; `no-report` (that epoch has nothing
 *   unsettled) clears it. A refusal or a call that never answered reports nothing and leaves the message as the
 *   Host says (the frames still settle it).
 * - Dismiss is only A-N11: it never ends, stops or removes a dwarf in this window (ADR-015 item 5, OQ-43); the Host
 *   walks out the dwarfs still unrecovered, and the board hears it on its own frames.
 * - Hidden until built (21 §1 item 8; ISSUE-330 decision): A-N10 and A-N11 are unrouted until the step-3a switch
 *   (ISSUE-001), and the router answers them with a typed refusal. A report exists only for sessions the Host owns,
 *   which only that same switch launches, so before it there is no report and no message; a refusal that still came
 *   back would leave the message unchanged, never guess a settlement.
 * - Read-only while the Host is not connected (ADR-002 D9; 13 FM-146): nothing is sent.
 */

type Report = HostRecoveryReportView | null

const report = shallowRef<Report>(null)
const acting = shallowRef(false)

const shown = computed(() => report.value !== null && report.value.state !== 'settled')
const unrecovered = computed<HostRecoveryReportView['unrecovered']>(() =>
  shown.value ? report.value!.unrecovered : []
)

/** The report of one snapshot: the `recovery` section's data. */
function reportOf(chunks: readonly SnapshotChunk[]): Report {
  for (const chunk of chunks) if (chunk.section === 'recovery') return chunk.data
  return null
}

const model = createReadModel<Report, HostFrame>({
  state: null,
  replace(data) {
    model.state = data
    report.value = data
  },
  apply(frame) {
    if (frame.name !== 'host.recovered') return
    const data = (frame.data as HostFrames['host.recovered']).report
    model.state = data
    report.value = data
  }
})

const follower: HostFollower = followHost(
  {
    subscribe: (listener) => window.api.onHostEvent((frames) => listener(frames as HostFrame[])),
    snapshot: (params) => window.api.getHostSnapshot(params)
  },
  { model, sections: ['recovery'], dataOf: reportOf, settled: () => undefined }
)

/** The report an action may be sent for: one shown, while the Host is connected and no other action runs. */
function actionable(): HostRecoveryReportView | null {
  if (useHostConnection().readOnly.value || acting.value || !shown.value) return null
  return report.value
}

/** The Host has nothing unsettled for the epoch acted on: the message closes. */
function clear(): void {
  model.state = null
  report.value = null
}

async function retry(): Promise<void> {
  const target = actionable()
  if (target === null) return
  acting.value = true
  try {
    const answer = await window.api.retryRecovery({
      hostEpoch: target.hostEpoch,
      requestId: mintRequestId()
    })
    if (!answer.ok) return
    if (answer.value.ok) {
      model.state = answer.value.value
      report.value = answer.value.value
    } else clear()
  } catch {
    // The answer never came: the frames still say whether the report settled.
  } finally {
    acting.value = false
  }
}

async function dismiss(): Promise<void> {
  const target = actionable()
  if (target === null) return
  acting.value = true
  try {
    const answer = await window.api.dismissRecovery({
      hostEpoch: target.hostEpoch,
      requestId: mintRequestId()
    })
    // Both outcomes close it: dismissed (settled), or `no-report`.
    if (answer.ok) clear()
  } catch {
    // The answer never came: the frames still say whether the report settled.
  } finally {
    acting.value = false
  }
}

function stop(): void {
  follower.stop()
  model.seq = 0
  clear()
  acting.value = false
}

export function useRecoveryReport() {
  return {
    /** The Host's recovery report as the snapshot and the frames say it; null when there is none. */
    report: readonly(report),
    /** Whether the one recovery message shows: a report that has not settled. */
    shown,
    /** What could not be recovered, in the report's order; empty while the message is not shown. */
    unrecovered,
    /** A Retry or Dismiss is on its way. */
    acting: readonly(acting),
    /** Subscribes, then reads the snapshot; answers whether the report is now fed by the Host. */
    start: () => follower.start(),
    stop,
    retry,
    dismiss
  }
}
