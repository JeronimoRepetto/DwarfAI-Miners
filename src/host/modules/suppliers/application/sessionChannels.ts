// The suppliers driving ports `SessionChannels` (05 §3.4, 16 §4.4) and `SessionBindings`, and the
// one consumer of every session's event stream (15 §1.3 `events()`: "one consumer (module
// suppliers)").
//
// A session is live from the moment one of the registry's drivers hands it out (`launch`,
// `resume`, `adopt`) until its `exited` left suppliers (15 §1.4: last event, exactly once). The
// registry returned here is the one the rest of the Host uses, so no session escapes the index.
//
// The dwarf (ADR-009 D3 as amended 2026-10-02; ADR-015 item 7): a driver does not know the dwarf,
// which launching binds to the provider identity after `launch()` resolves and before the dwarf is
// published (15 §1.5, 07 S4.02). Until `bind` is called, the session's events are held in order —
// none is dropped, as 15 §1.4 forbids dropping `ask.*`, `turn.ended`, sealed `usage` and `exited`
// — and they leave, stamped, once it is bound. A resume that mints a new session id is bound again
// by the Host to the same dwarf (ADR-015 item 7); a session is never bound to a second dwarf.
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { DwarfId, Instant } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { DriverRegistry } from '../ports/driverRegistry'
import type {
  DriverEvent,
  DriverSession,
  ProviderDriver,
  SessionRef
} from '../ports/providerDriver'
import type { SuppliedEvent, SuppliedEventSink } from '../ports/suppliedEventSink'

export interface SessionChannels {
  // the only door other modules use to reach a live session
  sessionFor(ref: SessionRef): DriverSession | null // ADR-009 D3 DriverSession (effective capabilities, answer*, close, …)
}

/** Called by launching once the dwarf of a session exists (ADR-015 item 7). */
export interface SessionBindings {
  bind(ref: SessionRef, dwarfId: DwarfId): void
}

export interface LiveSessionsDeps {
  readonly sink: SuppliedEventSink
  /** `UsageObservation.observedAt` is when suppliers saw it (15 §1.2 "suppliers fills both"). */
  readonly clock: Clock
}

/** Provider identity (ADR-015 item 7): `(providerId, providerSessionId, providerAgentId?)`. */
function identityKey(ref: SessionRef): string {
  return JSON.stringify([ref.providerId, ref.providerSessionId, ref.providerAgentId ?? null])
}

/** What suppliers keeps per session it handed out. */
interface Tracked {
  readonly ref: SessionRef
  dwarfId: DwarfId | null
  /** Events read before the dwarf was bound, in driver order, with when suppliers read them. */
  readonly held: { event: DriverEvent; at: Instant }[]
}

export function trackLiveSessions(
  registry: DriverRegistry,
  deps: LiveSessionsDeps
): { registry: DriverRegistry; channels: SessionChannels; bindings: SessionBindings } {
  const live = new Map<string, DriverSession>()
  const sessions = new Map<string, Tracked>()
  const wrapped = new WeakMap<ProviderDriver, ProviderDriver>()

  const deliver = (entry: Tracked, dwarfId: DwarfId, event: DriverEvent, at: Instant): void => {
    deps.sink.deliver({ dwarfId, ref: entry.ref, event: stamp(event, dwarfId, at) })
    if (event.t === 'exited') sessions.delete(identityKey(entry.ref))
  }

  const receive = (key: string, event: DriverEvent): void => {
    const entry = sessions.get(key)
    if (entry === undefined) return
    if (event.t === 'exited') live.delete(key)
    const at = deps.clock.now()
    if (entry.dwarfId === null) entry.held.push({ event, at })
    else deliver(entry, entry.dwarfId, event, at)
  }

  /** Reads the stream to its end; a stream that throws is a lost transport (15 §1.3). */
  const pump = async (key: string, session: DriverSession): Promise<void> => {
    try {
      for await (const event of session.events()) {
        receive(key, event)
        if (event.t === 'exited') return
      }
    } catch {
      receive(key, { t: 'error', cause: { kind: 'transport-lost', detail: 'event stream failed' } })
      receive(key, { t: 'exited', code: null })
    }
  }

  /** The session other modules get: everything but the stream, which suppliers consumes. */
  const admit = (session: DriverSession): DriverSession => {
    const key = identityKey(session.ref)
    const shared: DriverSession = {
      get ref() {
        return session.ref
      },
      get capabilities() {
        return session.capabilities
      },
      events() {
        throw new HostInvariantError('suppliers is the one consumer of a session event stream')
      },
      sendTurn: (input) => session.sendTurn(input),
      interrupt: () => session.interrupt(),
      answerPermission: (req) => session.answerPermission(req),
      answerQuestion: (req) => session.answerQuestion(req),
      close: (mode) => session.close(mode)
    }
    live.set(key, shared)
    sessions.set(key, { ref: session.ref, dwarfId: null, held: [] })
    void pump(key, session)
    return shared
  }

  const track = (driver: ProviderDriver): ProviderDriver => {
    const known = wrapped.get(driver)
    if (known !== undefined) return known
    const { resume, adopt, observer } = driver
    const tracked: ProviderDriver = {
      profile: driver.profile,
      transport: driver.transport,
      detect: () => driver.detect(),
      probe: (install) => driver.probe(install),
      launch: async (req) => admit(await driver.launch(req)),
      ...(resume === undefined
        ? {}
        : { resume: async (ref: SessionRef) => admit(await resume.call(driver, ref)) }),
      ...(adopt === undefined
        ? {}
        : {
            adopt: async (ref: SessionRef) => {
              const session = await adopt.call(driver, ref)
              return session === null ? null : admit(session)
            }
          }),
      ...(observer === undefined ? {} : { observer: () => observer.call(driver) })
    }
    wrapped.set(driver, tracked)
    return tracked
  }

  return {
    registry: { drivers: (id) => registry.drivers(id).map(track) },
    channels: { sessionFor: (ref) => live.get(identityKey(ref)) ?? null },
    bindings: {
      bind(ref, dwarfId) {
        const entry = sessions.get(identityKey(ref))
        if (entry === undefined) {
          throw new HostInvariantError('bind: no session of this provider identity was handed out')
        }
        if (entry.dwarfId !== null) {
          if (entry.dwarfId === dwarfId) return
          throw new HostInvariantError('bind: the session is already bound to another dwarf')
        }
        entry.dwarfId = dwarfId
        for (const { event, at } of entry.held.splice(0)) deliver(entry, dwarfId, event, at)
      }
    }
  }
}

/** The driver event as the rest of the Host sees it: the driver-side payloads completed. */
function stamp(event: DriverEvent, dwarfId: DwarfId, observedAt: Instant): SuppliedEvent {
  switch (event.t) {
    case 'turn.ended':
      return { t: 'turn.ended', end: { ...event.end, dwarfId } }
    case 'usage':
      return { t: 'usage', observation: { ...event.observation, dwarfId, observedAt } }
    default:
      return event
  }
}
