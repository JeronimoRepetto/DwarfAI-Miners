// layer: L2
// The route of `LaunchHandedBack` (08 §0; 07 S5.13; ADR-028 D2, OQ-38 B; 14 §2.4 B-F18; ISSUE-182
// forward note of #1401): a "Let Jev choose" launch whose fallback carried the configured default
// settles `handed-back`, and every `ui` connection gets `launch.changed` with that state and the
// picks it put into the pickers, as 14 §3.6 `LaunchWire.picks`. No `launch.failed` is sent. The
// frame is checked against its 14 §3.5 schema.
import { describe, expect, it } from 'vitest'
import { HOST_FRAME_SCHEMAS, type HostFrameData, type HostFrameName } from '@dwarfai/contracts'
import type { EventId, HostEpoch, LaunchId, MineId, ProviderId } from '../../kernel/domain/values'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import type { LaunchingEvent, LaunchView } from '../../modules/launching'
import { routeLaunching } from './launching'

const LAUNCH = '00000000-0000-7000-8000-0000000182a1' as LaunchId
const MINE = '00000000-0000-7000-8000-0000000182a2' as MineId
const CODEX = 'codex' as ProviderId

const HANDED_BACK: LaunchView = {
  launchId: LAUNCH,
  mineId: MINE,
  state: 'handed-back',
  wayKind: 'jev',
  picks: { providerId: CODEX, model: 'gpt-5', effort: 'medium' },
  requestedAt: 1_790_000_000_000
}

describe('LaunchHandedBack route', () => {
  it('[S5.13, ADR-028] a handed-back launch reaches ui as launch.changed with the picks it put into the pickers', () => {
    const bus = new RecordingEventBus<LaunchingEvent>()
    const sent: Array<{ name: HostFrameName; data: unknown }> = []
    routeLaunching({
      events: bus,
      launching: {
        commands: { failureSeen: () => undefined } as never,
        snapshots: {
          view: (id) => (id === LAUNCH ? HANDED_BACK : null),
          snapshot: () => []
        }
      },
      conversation: { ingest: () => undefined },
      frames: {
        publishFrame<F extends HostFrameName>(name: F, data: HostFrameData[F]) {
          const schemas: Readonly<Record<string, { parse(value: unknown): unknown }>> =
            HOST_FRAME_SCHEMAS
          schemas[name]?.parse(data)
          sent.push({ name, data })
        },
        connections: () => [{ role: 'ui' }]
      }
    })

    bus.publish({
      type: 'LaunchHandedBack',
      v: 1,
      id: '00000000-0000-7000-8000-0000000182a3' as EventId,
      at: 1_790_000_000_500,
      hostEpoch: 'epoch-182' as HostEpoch,
      payload: { launchId: LAUNCH, mineId: MINE, picks: HANDED_BACK.picks ?? {} }
    })

    expect(sent).toEqual([
      {
        name: 'launch.changed',
        data: {
          launch: {
            launchId: LAUNCH,
            mineId: MINE,
            state: 'handed-back',
            wayKind: 'jev',
            picks: { providerId: CODEX, model: 'gpt-5', effort: 'medium' },
            requestedAt: 1_790_000_000_000
          }
        }
      }
    ])
  })
})
