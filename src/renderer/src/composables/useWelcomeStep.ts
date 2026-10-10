import { computed, readonly, shallowRef } from 'vue'
import type {
  HostFrame,
  IntegrationId,
  PreferencesView,
  SnapshotChunk,
  WelcomeResult,
  WelcomeStepState
} from '@dwarfai/contracts'
import { createReadModel, followHost, type HostFollower } from './readModel'
import { mintRequestId } from './requestIds'
import { useHostConnection } from './useHostConnection'

/*
 * The first-run consent step (AMENDMENT-7, OQ-68; 07 machine 41; UC-075; 14 §6.3 "First-run consent step", §6.4 row
 * "new `useWelcomeStep`": singleton; snapshot `preferences.welcome` + `preferences.changed`; A-N32).
 *
 * - The step is a read model (ADR-033 item 3; readModel.ts): the snapshot's `preferences` section sets it with its
 *   seq, and a B-F24 `preferences.changed` frame applies only when its seq is above the last one applied. The step is
 *   shown while the Host reports it `due`; every window closes it on the frame with `due: false` (S41.05). Nothing is
 *   kept across a reload: a window that closed without an answer reads the step due again (S41.08).
 * - Only the options in `welcome.offered` exist (AMENDMENT-9, OQ-70): a tool that is not installed has no option, and
 *   each offered one starts ticked. `answer(ticks)` sends A-N32 `answerWelcome` once, with the ticks as the person
 *   left them and one UUIDv7 per intent (14 §1.6); a tick for an option not offered is sent `false` (S41.04).
 *   Nothing is sent before that call (ADR-016 item 5).
 * - The answer never closes the step: the frame does. It only brings the per-integration failures (S41.05; 13 FM-148,
 *   FM-149), kept for one display until `acknowledge()`; while they are kept the step stays shown in this window. A
 *   refused or timed-out call reports nothing and leaves the step as the Host says (14 §3.10: a `TIMEOUT` keeps it
 *   shown, `preferences.changed` settles it).
 * - Read-only while the Host is not connected (ADR-002 D9; 13 FM-146): nothing leaves. One answer at a time.
 */

/** One option of the step: an offered integration and whether it starts ticked. */
export interface WelcomeOption {
  id: IntegrationId
  ticked: boolean
}

/** A write or revert of the answer that failed (16 §4.12 `WelcomeResult`). */
export interface WelcomeFailure {
  id: IntegrationId
  failure: NonNullable<WelcomeResult[IntegrationId]['failure']>
}

/** The ticks at "Activate", per option. */
export type WelcomeTicks = Partial<Record<IntegrationId, boolean>>

/** The order the step lists its options in: Claude Code, then OpenCode (07 S41.04 settles them in this order). */
const ORDER: readonly IntegrationId[] = ['claude-hooks', 'opencode-permissions']

const NOT_DUE: WelcomeStepState = { due: false, legacyFound: [], offered: [] }

const welcome = shallowRef<WelcomeStepState>(NOT_DUE)
const failures = shallowRef<WelcomeFailure[]>([])
const answering = shallowRef(false)

const due = computed(() => welcome.value.due)
const options = computed<WelcomeOption[]>(() =>
  welcome.value.due
    ? ORDER.filter((id) => welcome.value.offered.includes(id)).map((id) => ({ id, ticked: true }))
    : []
)
const shown = computed(() => due.value || failures.value.length > 0)

/** The step of one snapshot: the `preferences` section's `welcome`. */
function welcomeOf(chunks: readonly SnapshotChunk[]): WelcomeStepState {
  for (const chunk of chunks) {
    if (chunk.section !== 'preferences') continue
    return (chunk.data as PreferencesView).welcome
  }
  return NOT_DUE
}

const model = createReadModel<WelcomeStepState, HostFrame>({
  state: NOT_DUE,
  replace(data) {
    model.state = data
    welcome.value = data
  },
  apply(frame) {
    if (frame.name !== 'preferences.changed') return
    const data = (frame.data as PreferencesView).welcome
    model.state = data
    welcome.value = data
  }
})

const follower: HostFollower = followHost(
  {
    subscribe: (listener) => window.api.onHostEvent((frames) => listener(frames as HostFrame[])),
    snapshot: (params) => window.api.getHostSnapshot(params)
  },
  {
    model,
    sections: ['preferences'],
    dataOf: welcomeOf,
    settled: () => undefined
  }
)

/** The failures of one answer, in the step's order. */
function failuresOf(result: WelcomeResult): WelcomeFailure[] {
  const found: WelcomeFailure[] = []
  for (const id of ORDER) {
    const failure = result[id].failure
    if (failure !== undefined) found.push({ id, failure })
  }
  return found
}

async function answer(ticks: WelcomeTicks): Promise<void> {
  if (useHostConnection().readOnly.value) return
  if (answering.value || !welcome.value.due) return
  const offered = welcome.value.offered
  const ticked = (id: IntegrationId): boolean => offered.includes(id) && ticks[id] === true
  answering.value = true
  try {
    const result = await window.api.answerWelcome({
      claudeHooks: ticked('claude-hooks'),
      openCodePermissions: ticked('opencode-permissions'),
      requestId: mintRequestId()
    })
    if (result.ok) failures.value = failuresOf(result.value.integrations)
  } catch {
    // The answer never came: the frames still say whether the step is due.
  } finally {
    answering.value = false
  }
}

/** The failures were shown: they are not shown again. */
function acknowledge(): void {
  failures.value = []
}

function stop(): void {
  follower.stop()
  model.seq = 0
  model.state = NOT_DUE
  welcome.value = NOT_DUE
  failures.value = []
  answering.value = false
}

export function useWelcomeStep() {
  return {
    /** Whether the Host reports the step due, as the snapshot and the frames say it. */
    due,
    /** The offered options, each pre-selected; empty while the step is not due. */
    options,
    /** The last answer's per-integration failures, until acknowledged. */
    failures: readonly(failures),
    answering: readonly(answering),
    /** Whether this window shows the step: while it is due, or while an answer's failures wait to be read. */
    shown,
    /** Subscribes, then reads the snapshot; answers whether the step is now fed by the Host. */
    start: () => follower.start(),
    stop,
    answer,
    acknowledge
  }
}
