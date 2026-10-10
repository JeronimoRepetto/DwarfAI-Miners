import { ref } from 'vue'
import type {
  HostFrame,
  IntegrationSetting,
  IntegrationState,
  PreferencesView,
  SnapshotChunk
} from '@dwarfai/contracts'
import { createReadModel, followHost, type HostFollower } from './readModel'
import { mintRequestId } from './requestIds'
import { useHostConnection } from './useHostConnection'

/*
 * Settings → Integrations "Claude Code · instant updates" (AMENDMENT-7, OQ-68; US-SET-013; UC-076; 14 §6.4 row
 * "new `useClaudeHooksSettings`", per-call: snapshot `preferences.integrations` + `integration.changed`; A-N31).
 *
 * - The state is a read model (ADR-033 item 3; readModel.ts): the snapshot's `preferences` section sets it with its
 *   seq, and a B-F25 `integration.changed` frame for `claude-hooks` applies only when its seq is above the last one
 *   applied; frames buffered while the snapshot was read at or below its seq are dropped. A new install reads `off`
 *   (US-SET-013.AC02), and so does every view until the snapshot answered.
 * - `setEnabled(on)` calls A-N31 `setClaudeHooksEnabled({ on, requestId })`, one UUIDv7 per intent (14 §1.6); the Host
 *   records the consent origin `settings`. The answer never sets the state: every window, this one included, follows
 *   the Host's `integration.changed` (16 §7.4 "the UI reflects the real state"). It only says whether the Host could
 *   do it: `failure` is `config-write-failed` or `config-revert-failed` (a locked settings.json keeps the option on);
 *   the notice's words are design's (13 FM-148, `⟦COPY NEEDED: config-write failure⟧`), not this composable's.
 * - Read-only while the Host is not connected (ADR-002 D9; 13 FM-146): nothing leaves. One request at a time.
 */

type HooksFailure = 'config-write-failed' | 'config-revert-failed'

const CLAUDE_HOOKS = 'claude-hooks'

export interface ClaudeHooksSettingsDeps {
  /** A UUIDv7 per toggle intent (14 §1.6); the default mints one from the clock and the platform's random source. */
  newRequestId?: () => string
}

/** The Claude hooks setting of one snapshot: the `preferences` section's `integrations` row. */
function settingOf(chunks: readonly SnapshotChunk[]): IntegrationSetting | undefined {
  for (const chunk of chunks) {
    if (chunk.section !== 'preferences') continue
    const view = chunk.data as PreferencesView
    return view.integrations.find((setting) => setting.id === CLAUDE_HOOKS)
  }
  return undefined
}

export function useClaudeHooksSettings(deps: ClaudeHooksSettingsDeps = {}) {
  const { newRequestId = mintRequestId } = deps
  const state = ref<IntegrationState>('off')
  const failure = ref<HooksFailure | null>(null)
  const applying = ref(false)

  const model = createReadModel<{ state: IntegrationState }, HostFrame>({
    state: { state: 'off' },
    replace(data) {
      model.state.state = data.state
      state.value = data.state
    },
    apply(frame) {
      if (frame.name !== 'integration.changed') return
      const data = frame.data as { id: string; state: IntegrationState }
      if (data.id !== CLAUDE_HOOKS) return
      model.state.state = data.state
      state.value = data.state
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
      dataOf: (chunks) => ({ state: settingOf(chunks)?.state ?? 'off' }),
      settled: () => undefined
    }
  )

  async function setEnabled(on: boolean): Promise<void> {
    if (useHostConnection().readOnly.value) return
    if (applying.value) return
    applying.value = true
    try {
      const answer = await window.api.setClaudeHooksEnabled({ on, requestId: newRequestId() })
      failure.value = answer.ok && !answer.value.ok ? answer.value.error : null
    } catch {
      // The answer never came: the frames still say what the Host holds.
      failure.value = null
    } finally {
      applying.value = false
    }
  }

  return {
    /** The Host's state of the integration, as the snapshot and the frames say it. */
    state,
    /** The last toggle's failure outcome, or null. */
    failure,
    applying,
    /** Subscribes, then reads the snapshot; answers whether the state is now fed by the Host. */
    start: () => follower.start(),
    stop: () => follower.stop(),
    setEnabled
  }
}
