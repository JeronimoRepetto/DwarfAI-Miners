// layer: L2
// L2 (17 §1.2): the observed ask-resolution route (05 §4 row `ObservedAskClosed` → asking
// `resolveExternally`; 08 §2.3, keyed `(dwarfId, providerRequestId)`) over the asking module as the
// Host composes it (asking/testing/inMemoryAsking.ts) and a `RecordingEventBus`. The session is
// resolved to its dwarf through observation's `ProviderIdentity → DwarfId` index (16 §4.3); a session
// no dwarf carries is ignored and logged. Composing it into the Host's main is later: ISSUE-140.
//
// The events here are built from 08 §0's payload, not recorded from a provider: no observation
// adapter publishes `ObservedAskClosed` yet (OpenCode's signal waits on SP-09, ISSUE-229).
import { describe, expect, it } from 'vitest'
import type {
  AskId,
  DwarfId,
  EventId,
  HostEpoch,
  ProviderId,
  ProviderIdentity
} from '../../kernel/domain/values'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import { permissionAsk, questionAsk } from '../../modules/asking/testing/askRepository.contract'
import { inMemoryAsking } from '../../modules/asking/testing/inMemoryAsking'
import type { ObservedAskClosed, ObservedSessionStore } from '../../modules/observation'
import { registerAskResolutions } from './askResolutions'

const OPENCODE = 'opencode' as ProviderId
const CODEX = 'codex' as ProviderId
const DWARF = '00000000-0000-7000-8000-0000000136d1' as DwarfId
const OTHER = '00000000-0000-7000-8000-0000000136d2' as DwarfId
const SESSION = 'ses_0136000000000000000001'
const OTHER_SESSION = 'ses_0136000000000000000002'

function world() {
  const {
    asking,
    asks,
    bus: askingBus
  } = inMemoryAsking({
    channelFor: () => null,
    staleAnswerSafe: () => true
  })
  const bus = new RecordingEventBus<ObservedAskClosed>()
  const log = new RecordingDiagnosticsLog()
  const bound = new Map<string, DwarfId>([
    [`${OPENCODE}:${SESSION}`, DWARF],
    [`${CODEX}:${OTHER_SESSION}`, OTHER]
  ])
  const sessions: Pick<ObservedSessionStore, 'byIdentity'> = {
    byIdentity: (identity: ProviderIdentity) => {
      const dwarfId = bound.get(`${identity.providerId}:${identity.providerSessionId}`)
      return dwarfId === undefined ? null : ({ dwarfId } as never)
    }
  }
  const unsubscribe = registerAskResolutions({
    bus,
    sessions,
    asks: asking.resolutions,
    log
  })
  let n = 0
  const close = (
    identity: ProviderIdentity,
    providerRequestId: string,
    by: 'elsewhere' | 'cancelled'
  ) => {
    n += 1
    bus.publish({
      type: 'ObservedAskClosed',
      v: 1,
      id: `01890a5d-ac96-774b-bcce-${String(n).padStart(12, '0')}` as EventId,
      at: 1_790_000_000_000 + n,
      hostEpoch: 'epoch-0136' as HostEpoch,
      payload: { identity, providerRequestId, by }
    })
  }
  return { asks, askingBus, bus, log, close, unsubscribe }
}

const identity = (providerId: ProviderId, providerSessionId: string): ProviderIdentity => ({
  providerId,
  providerSessionId
})

describe('ObservedAskClosed → asking resolveExternally (05 §4)', () => {
  it('[US-OBS-004.AC09, S6.11] an observed resolution outside the app closes the ask of its dwarf answered-elsewhere with AskClosed only', () => {
    const w = world()
    const ask = permissionAsk(1, DWARF)
    w.asks.save(ask)

    w.close(identity(OPENCODE, SESSION), ask.providerRequestId, 'elsewhere')

    expect(w.asks.byId(ask.id as AskId)?.state).toBe('answered-elsewhere')
    expect(w.askingBus.published.map((event) => event.type)).toEqual(['AskClosed'])
    expect(w.askingBus.ofType('AskClosed')[0]?.payload).toEqual({
      askId: ask.id,
      dwarfId: DWARF,
      reason: 'answered-elsewhere'
    })
    expect(w.bus.handlerErrors).toEqual([])
    expect(w.log.entries).toEqual([])
  })

  it('[US-ASK-006.AC06, S6.13] an observed cancellation or withdrawal closes the ask cancelled with no notice', () => {
    const w = world()
    const ask = questionAsk(2, OTHER)
    w.asks.save(ask)

    w.close(identity(CODEX, OTHER_SESSION), ask.providerRequestId, 'cancelled')

    expect(w.asks.byId(ask.id as AskId)?.state).toBe('cancelled')
    expect(w.askingBus.ofType('AskClosed').map((event) => event.payload.reason)).toEqual([
      'cancelled'
    ])
    expect(w.log.entries).toEqual([])
  })

  it('[ADR-010] the resolution reaches only the dwarf its session resolves to', () => {
    const w = world()
    // The same provider request id on two dwarfs: only the identity's dwarf's ask closes.
    const mine = permissionAsk(3, DWARF)
    const theirs = permissionAsk(4, OTHER, { providerRequestId: mine.providerRequestId })
    w.asks.save(mine)
    w.asks.save(theirs)

    w.close(identity(OPENCODE, SESSION), mine.providerRequestId, 'elsewhere')

    expect(w.asks.byId(mine.id as AskId)?.state).toBe('answered-elsewhere')
    expect(w.asks.byId(theirs.id as AskId)?.state).toBe('open')
  })

  it('[ADR-010] a session no dwarf carries is ignored and logged, and no ask changes', () => {
    const w = world()
    const ask = permissionAsk(5, DWARF)
    w.asks.save(ask)

    // A known session id under another provider is another session (ProviderIdentity, 01).
    w.close(identity(CODEX, SESSION), ask.providerRequestId, 'elsewhere')

    expect(w.asks.byId(ask.id as AskId)?.state).toBe('open')
    expect(w.askingBus.published).toEqual([])
    expect(w.log.byEvent('asking.observed-resolution.unknown-session')).toEqual([
      {
        level: 'info',
        event: 'asking.observed-resolution.unknown-session',
        subsystem: 'asking',
        provider: CODEX
      }
    ])
    // Neither the session id nor the request id is logged (ADR-026).
    expect(JSON.stringify(w.log.entries)).not.toContain(SESSION)
    expect(JSON.stringify(w.log.entries)).not.toContain(ask.providerRequestId)
    expect(w.log.refused).toEqual([])
  })

  it('[ADR-010, S6.11] a repeated resolution of the same ask changes nothing', () => {
    const w = world()
    const ask = permissionAsk(6, DWARF)
    w.asks.save(ask)

    w.close(identity(OPENCODE, SESSION), ask.providerRequestId, 'elsewhere')
    w.close(identity(OPENCODE, SESSION), ask.providerRequestId, 'cancelled')

    expect(w.asks.byId(ask.id as AskId)?.state).toBe('answered-elsewhere')
    expect(w.askingBus.ofType('AskClosed')).toHaveLength(1)
  })

  it('[ADR-010] once unsubscribed the route applies nothing', () => {
    const w = world()
    const ask = permissionAsk(7, DWARF)
    w.asks.save(ask)
    w.unsubscribe()

    w.close(identity(OPENCODE, SESSION), ask.providerRequestId, 'elsewhere')

    expect(w.asks.byId(ask.id as AskId)?.state).toBe('open')
  })

  it('[ADR-010] a failing resolution is logged and never reaches the publisher', () => {
    const bus = new RecordingEventBus<ObservedAskClosed>()
    const log = new RecordingDiagnosticsLog()
    registerAskResolutions({
      bus,
      sessions: { byIdentity: () => ({ dwarfId: DWARF }) as never },
      asks: {
        resolveExternally: () => {
          throw new Error('the transaction failed')
        }
      },
      log
    })

    expect(() =>
      bus.publish({
        type: 'ObservedAskClosed',
        v: 1,
        id: '01890a5d-ac96-774b-bcce-000000013699' as EventId,
        at: 1_790_000_000_000,
        hostEpoch: 'epoch-0136' as HostEpoch,
        payload: {
          identity: identity(OPENCODE, SESSION),
          providerRequestId: 'request-9',
          by: 'elsewhere'
        }
      })
    ).not.toThrow()
    expect(bus.handlerErrors).toEqual([])
    expect(log.byEvent('asking.observed-resolution.failed')).toEqual([
      {
        level: 'warn',
        event: 'asking.observed-resolution.failed',
        subsystem: 'asking',
        provider: OPENCODE
      }
    ])
  })
})
