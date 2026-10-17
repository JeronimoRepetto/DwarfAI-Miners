// layer: L2
// L2 (17 §1.2): the `DelegationFailed` route (08 §2.8; 16 §5.4 "Parent chat line"; ISSUE-206) on a
// `RecordingEventBus`, with crew's queries and conversation's `ingest` as recording doubles: the line
// names the parent by crew's display name, a parent no longer present gets nothing, and a failing
// write is logged by class only and never reaches the publisher. The flow cases (every failure of
// machine 8, replay, the turn-input push) are in flows/delegation.test.ts.
import { describe, expect, it } from 'vitest'
import type { DwarfId, EventId, HostEpoch } from '../../kernel/domain/values'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import type { ConversationCommands } from '../../modules/conversation'
import type { CrewQueries, DwarfView } from '../../modules/crew'
import type { DelegationFailed } from '../../modules/delegation'
import { registerDelegationFailed } from './delegationFailed'

const PARENT = '00000000-0000-7000-8000-0000000c2071' as DwarfId
const DELEGATION =
  '00000000-0000-7000-8000-0000000c2072' as DelegationFailed['payload']['delegationId']
const TASK = 'Map the old shafts below the north seam'

type Ingested = Parameters<ConversationCommands['ingest']>

function world(parent: { departed: boolean } | null, ingestThrows = false) {
  const bus = new RecordingEventBus<DelegationFailed>()
  const log = new RecordingDiagnosticsLog()
  const ingested: Ingested[] = []
  const crew: Pick<CrewQueries, 'get' | 'displayName'> = {
    get: (dwarfId) => (dwarfId === PARENT && parent !== null ? (parent as DwarfView) : null),
    displayName: () => 'Grumli the Bold'
  }
  registerDelegationFailed({
    bus,
    crew,
    conversation: {
      ingest: (...args: Ingested) => {
        if (ingestThrows) throw new Error('the message log is unavailable')
        ingested.push(args)
      }
    },
    log
  })
  const fail = (failure: DelegationFailed['payload']['failure']) =>
    bus.publish({
      type: 'DelegationFailed',
      v: 1,
      id: '00000000-0000-7000-8000-0000000c2073' as EventId,
      at: 1_790_000_000_000,
      hostEpoch: 'epoch-206' as HostEpoch,
      payload: { delegationId: DELEGATION, parentDwarfId: PARENT, failure }
    })
  return { log, ingested, fail }
}

describe('the DelegationFailed route (08 §2.8; ISSUE-206)', () => {
  it("[US-DLG-005.AC01] the line names the parent by crew's display name, keyed by its delegation", () => {
    const w = world({ departed: false })

    w.fail('worker-failed')

    expect(w.ingested).toStrictEqual([
      [
        PARENT,
        [
          {
            sourceKey: `delegation-failed:${DELEGATION}`,
            role: 'system-line',
            text: 'Jev could not take this subtask. Grumli the Bold continues it with its own subagent.',
            providerTime: null
          }
        ],
        'live-stream'
      ]
    ])
    expect(w.log.entries).toMatchObject([
      {
        level: 'warn',
        event: 'delegation.failed',
        causeClass: 'worker-failed',
        delegationId: DELEGATION,
        dwarfId: PARENT
      }
    ])
  })

  it('[S8.09] a parent whose session is gone when the failure is routed gets no line', () => {
    const departed = world({ departed: true })
    const unknown = world(null)

    departed.fail('worker-lost')
    unknown.fail('worker-lost')

    expect(departed.ingested).toStrictEqual([])
    expect(unknown.ingested).toStrictEqual([])
    // The failure itself is still logged.
    expect(departed.log.entries.map((e) => e.event)).toStrictEqual(['delegation.failed'])
  })

  it('[NFR-SEC-12] a failing write is logged by class only and never reaches the publisher', () => {
    const w = world({ departed: false }, true)

    expect(() => w.fail('jev-unreachable')).not.toThrow()

    expect(w.log.entries.map((e) => [e.event, e.causeClass])).toStrictEqual([
      ['delegation.failed', 'jev-unreachable'],
      ['delegation.failed-line.failed', 'jev-unreachable']
    ])
    expect(JSON.stringify(w.log.entries)).not.toContain(TASK)
    expect(JSON.stringify(w.log.entries)).not.toContain('Grumli')
  })
})
