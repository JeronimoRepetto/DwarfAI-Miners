// The suppliers driving port `SessionChannels` (05 §3.4, 16 §4.4): the only door other modules use
// to reach a live session. A session is live from the moment one of the registry's drivers hands
// it out (`launch`, `resume`, `adopt`) until its stream delivered `exited` (15 §1.4: last event,
// exactly once). The registry returned here is the one the rest of the Host uses, so no session
// escapes the index.
import type { DriverRegistry } from '../ports/driverRegistry'
import type {
  DriverEvent,
  DriverSession,
  ProviderDriver,
  SessionRef
} from '../ports/providerDriver'

export interface SessionChannels {
  // the only door other modules use to reach a live session
  sessionFor(ref: SessionRef): DriverSession | null // ADR-009 D3 DriverSession (effective capabilities, answer*, close, …)
}

/** Provider identity (ADR-015 item 7): `(providerId, providerSessionId, providerAgentId?)`. */
function identityKey(ref: SessionRef): string {
  return JSON.stringify([ref.providerId, ref.providerSessionId, ref.providerAgentId ?? null])
}

export function trackLiveSessions(registry: DriverRegistry): {
  registry: DriverRegistry
  channels: SessionChannels
} {
  const live = new Map<string, DriverSession>()
  const tracked = new WeakMap<ProviderDriver, ProviderDriver>()

  /** The same session, whose stream drops it from the index once `exited` passed through. */
  const admit = (session: DriverSession): DriverSession => {
    const key = identityKey(session.ref)
    let stream: AsyncIterable<DriverEvent> | null = null
    const watched: DriverSession = {
      get ref() {
        return session.ref
      },
      get capabilities() {
        return session.capabilities
      },
      events() {
        stream ??= watchExit(session.events(), () => {
          if (live.get(key) === watched) live.delete(key)
        })
        return stream
      },
      sendTurn: (input) => session.sendTurn(input),
      interrupt: () => session.interrupt(),
      answerPermission: (req) => session.answerPermission(req),
      answerQuestion: (req) => session.answerQuestion(req),
      close: (mode) => session.close(mode)
    }
    live.set(key, watched)
    return watched
  }

  const track = (driver: ProviderDriver): ProviderDriver => {
    const known = tracked.get(driver)
    if (known !== undefined) return known
    const { resume, adopt, observer } = driver
    const wrapped: ProviderDriver = {
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
    tracked.set(driver, wrapped)
    return wrapped
  }

  return {
    registry: { drivers: (id) => registry.drivers(id).map(track) },
    channels: { sessionFor: (ref) => live.get(identityKey(ref)) ?? null }
  }
}

/** The same events, calling `onExited` when `exited` is read. */
function watchExit(
  source: AsyncIterable<DriverEvent>,
  onExited: () => void
): AsyncIterable<DriverEvent> {
  return {
    [Symbol.asyncIterator]() {
      const inner = source[Symbol.asyncIterator]()
      return {
        async next() {
          const result = await inner.next()
          if (result.done !== true && result.value.t === 'exited') onExited()
          return result
        },
        return: async () => (await inner.return?.()) ?? { value: undefined, done: true }
      }
    }
  }
}
