// `SettingsMirrorBridge` core (21 §3, cuts 1–3e; 14 §5 row "Presence and notifications"): while Settings still writes
// through the legacy store, the Host reads the same values through this one-way mirror.
//
// - It forwards the keys its halves declare (mirrorHalf.ts) with `preferences.set` (14 §2.3 B-M13; 14 §3.4
//   `PreferenceSetParams`), each with a fresh `requestId` (14 §1.6), over the `ui` connection, or a short-lived one
//   when no window holds it (HostClient `withUiConnection`).
// - On attach (the HostClient becoming `connected`), it reads every listed key from the legacy store and the Host's
//   values from the snapshot `preferences` section, and sends one `preferences.set` per key whose Host value differs.
// - After every legacy write of a listed key, it sends that key's stored value once, whatever the Host holds (the
//   same value publishes nothing, 16 §4.12). A write of an unlisted key sends nothing.
// - A key it could not send (the Host detached, or the call failed) is pending: it is sent at the next attach even
//   when the Host's value already matches. Nothing is ever written back: the legacy store stays the source of truth,
//   and no renderer action writes the Host copy (21 §3).
// - The keys are `HostPreferenceKey`s (14 §3.4) only, and the runtime guard refuses anything else, so no secret
//   (ADR-017 item 3) and no integration gate (ADR-016 item 5; 18 C-21) is ever mirrored.
//
// Composed only by `src/ui-main/index.ts` (05 R16). Deleted in 4a, when the direction flips (ISSUE-230, ISSUE-236).
import type {
  HostPreferenceKey,
  HostPreferences,
  PreferenceSetParams,
  SnapshotPage
} from '@dwarfai/contracts'
import type { HostClient, HostConnection } from '../../ui-main/window/ports/hostClient'
import type { MirrorHalf } from './mirrorHalf'

/** The legacy store's write notifications: `key` was saved by today's settings handler. */
export interface LegacySettingsWrites {
  /** Calls `listener` after each save of a Host-read preference; answers the unsubscribe. */
  onWrite(listener: (key: HostPreferenceKey) => void): () => void
}

/** The HostClient members the mirror uses: the connection state and the `ui` connection, nothing else. */
export type MirrorHostClient = Pick<HostClient, 'state' | 'onStateChange' | 'withUiConnection'>

export interface SettingsMirrorBridgeDeps {
  hostClient: MirrorHostClient
  legacy: LegacySettingsWrites
  /** The halves whose keys are mirrored; a key belongs to one half only. */
  halves: readonly MirrorHalf[]
  /** A fresh UUIDv7 `requestId` per `preferences.set` (14 §1.6). */
  newRequestId(): string
}

export interface SettingsMirrorBridge {
  /** Settles once every attach pass and write mirror started so far has finished. */
  idle(): Promise<void>
  /** Stops listening to the HostClient and the legacy store. */
  dispose(): void
}

/** Every writable `HostPreferenceKey` (14 §3.4): the record makes the list exhaustive at compile time. */
const MIRRORABLE: { readonly [K in HostPreferenceKey]: true } = {
  subagentDelegationOn: true,
  routingProfile: true,
  defaultProvider: true,
  defaultModel: true,
  defaultEffort: true,
  systemNotificationsOn: true
}

type Ui = Parameters<Parameters<HostClient['withUiConnection']>[0]>[0]

/** The halves' keys, each to its half; throws on a key that is not a writable Host preference or is listed twice. */
function keysOf(halves: readonly MirrorHalf[]): Map<HostPreferenceKey, MirrorHalf> {
  const owners = new Map<HostPreferenceKey, MirrorHalf>()
  for (const half of halves) {
    for (const key of half.keys) {
      if (!Object.hasOwn(MIRRORABLE, key)) {
        throw new Error(`${String(key)} is not a mirrorable preference`)
      }
      if (owners.has(key)) throw new Error(`${key} is listed by two mirror halves`)
      owners.set(key, half)
    }
  }
  return owners
}

export function createSettingsMirrorBridge(deps: SettingsMirrorBridgeDeps): SettingsMirrorBridge {
  const { hostClient, legacy, newRequestId } = deps
  const owners = keysOf(deps.halves)
  const pending = new Set<HostPreferenceKey>()
  let queue: Promise<void> = Promise.resolve()
  let disposed = false

  /** Runs `job` after every job queued before it, so the Host receives the writes in the order they were saved. */
  const enqueue = (job: () => Promise<void>): void => {
    queue = queue.then(() => (disposed ? undefined : job())).catch(() => {})
  }

  const connected = (): boolean => hostClient.state().state === 'connected'

  const readLegacy = <K extends HostPreferenceKey>(key: K): Promise<HostPreferences[K]> =>
    (owners.get(key) as MirrorHalf<K>).readLegacy(key)

  /** Sends `key`'s legacy value; a key that could not be sent stays pending for the next attach. */
  const send = async (
    ui: Ui,
    key: HostPreferenceKey,
    read: Promise<unknown> = readLegacy(key)
  ): Promise<void> => {
    try {
      const value = await read
      await ui.call('preferences.set', {
        key,
        value,
        requestId: newRequestId()
      } as PreferenceSetParams)
      pending.delete(key)
    } catch {
      pending.add(key)
    }
  }

  /** The Host's preferences from the snapshot `preferences` section, following its pages; none when it is absent. */
  const hostPreferences = async (ui: Ui): Promise<HostPreferences | undefined> => {
    let page: SnapshotPage = await ui.snapshot({ sections: ['preferences'] })
    for (;;) {
      const chunk = page.chunks.find((c) => c.section === 'preferences')
      if (chunk !== undefined) return chunk.data.preferences
      if (page.next === undefined) return undefined
      page = await ui.snapshot({
        sections: ['preferences'],
        snapshotId: page.snapshotId,
        cursor: page.next
      })
    }
  }

  const attachPass = async (): Promise<void> => {
    if (owners.size === 0 || !connected()) return
    await hostClient.withUiConnection(async (ui) => {
      const host = await hostPreferences(ui)
      for (const key of owners.keys()) {
        const read = readLegacy(key)
        read.catch(() => {}) // a failed read is handled by `send`, which keeps the key pending
        if (!pending.has(key) && host !== undefined) {
          const value = await read.catch(() => undefined)
          if (Object.is(host[key], value)) continue
        }
        await send(ui, key, read)
      }
    })
  }

  const mirrorWrite = async (key: HostPreferenceKey): Promise<void> => {
    pending.add(key)
    if (!connected()) return
    await hostClient.withUiConnection((ui) => send(ui, key))
  }

  let wasConnected = connected()
  const stopState = hostClient.onStateChange((next: HostConnection) => {
    const attached = next.state === 'connected' && !wasConnected
    wasConnected = next.state === 'connected'
    if (attached) enqueue(attachPass)
  })
  const stopWrites = legacy.onWrite((key) => {
    if (owners.has(key)) enqueue(() => mirrorWrite(key))
  })
  if (wasConnected) enqueue(attachPass)

  return {
    idle: () => queue,
    dispose: () => {
      disposed = true
      stopState()
      stopWrites()
    }
  }
}
