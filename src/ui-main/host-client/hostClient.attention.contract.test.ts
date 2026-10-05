// layer: L6
import { afterEach, describe, expect, it } from 'vitest'
import type { OsNotification } from '@dwarfai/contracts'
import { RecordingUiLog } from '../hostLauncher/fakes/RecordingUiLog'
import type { AttentionFrame } from '../window/ports/hostClient'
import { createHostClient, type HostClientService } from './HostClient'
import { FAKE_HOST_CAPABILITIES, FakeHost } from './testing/FakeHost'
import { FakeHostClientTimers } from './testing/FakeHostClientTimers'

// L6 (17 §1.6): the real HostClient against FakeHost hands the composition the level-3 frames of its `notifier`
// connection (ADR-003 item 12; 14 B-F22, B-F23, §2.3 "Notifier scope"; ADR-018 item 5), each checked against its
// strict() schema (14 §1.4), so the presenter of ISSUE-113 draws them with a window open and in tray mode alike.

const MINE = '01890a5d-ac96-774b-bcce-b302099a8111'
const DWARF = '01890a5d-ac96-774b-bcce-b302099ad111'
const NOTIFICATION: OsNotification = {
  key: `${DWARF}:question:ask-1`,
  kind: 'question',
  title: 'Ember has a question',
  body: 'Mine one',
  mineId: MINE as OsNotification['mineId'],
  dwarfId: DWARF as OsNotification['dwarfId'],
  sensitive: true
}

const clients: HostClientService[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose()
})

async function settle(rounds = 20): Promise<void> {
  for (let round = 0; round < rounds; round += 1)
    await new Promise((resolve) => setImmediate(resolve))
}

function world() {
  const host = new FakeHost({
    capabilities: [...FAKE_HOST_CAPABILITIES, 'frame:attention.notify', 'frame:attention.withdraw']
  })
  const client = createHostClient({
    launcher: { ensureHostRunning: () => Promise.resolve('attached') },
    connect: host.connect,
    readToken: () => Promise.resolve(host.token),
    protocolVersion: 1,
    client: { appVersion: '0.0.0-test', buildId: 'test', pid: 4242 },
    timers: new FakeHostClientTimers(),
    log: new RecordingUiLog(),
    hungHost: { endHungHost: () => Promise.resolve({ outcome: 'identity-missing' }) }
  })
  clients.push(client)
  const frames: AttentionFrame[] = []
  return { host, client, frames, record: (frame: AttentionFrame) => frames.push(frame) }
}

describe('HostClient notifier attention frames (ISSUE-113)', () => {
  it('[ADR-018] attention.notify and attention.withdraw on the notifier connection reach onAttentionFrame with no window subscribed', async () => {
    const { host, client, frames, record } = world()
    client.onAttentionFrame(record)
    expect(await client.ensureHost()).toBe('available')
    await settle()
    // Tray mode: only the notifier connection is held (no `subscribe` handler, so no `ui` connection).
    expect(host.liveConnections('ui')).toBe(0)

    host.publishToNotifiers('attention.notify', NOTIFICATION)
    host.publishToNotifiers('attention.withdraw', { keys: [NOTIFICATION.key] })
    await settle()

    expect(frames).toEqual([
      { name: 'attention.notify', data: NOTIFICATION },
      { name: 'attention.withdraw', data: { keys: [NOTIFICATION.key] } }
    ])
  })

  it('[ADR-019] an attention frame that fails its strict schema is dropped and the next one still arrives', async () => {
    const { host, client, frames, record } = world()
    client.onAttentionFrame(record)
    await client.ensureHost()
    await settle()

    host.publishToNotifiers('attention.notify', { ...NOTIFICATION, sensitive: false })
    host.publishToNotifiers('attention.notify', { ...NOTIFICATION, extra: 'field' })
    host.publishToNotifiers('attention.withdraw', { keys: [1] })
    host.publishToNotifiers('attention.notify', NOTIFICATION)
    await settle()

    expect(frames).toEqual([{ name: 'attention.notify', data: NOTIFICATION }])
  })

  it('[FM-048] a handler that throws never breaks the notifier connection, and an unsubscribed handler receives nothing', async () => {
    const { host, client, frames, record } = world()
    const unsubscribe = client.onAttentionFrame(() => {
      throw new Error('display failed')
    })
    client.onAttentionFrame(record)
    await client.ensureHost()
    await settle()

    host.publishToNotifiers('attention.notify', NOTIFICATION)
    await settle()
    unsubscribe()
    host.publishToNotifiers('attention.withdraw', { keys: [NOTIFICATION.key] })
    await settle()

    expect(frames.map((f) => f.name)).toEqual(['attention.notify', 'attention.withdraw'])
    expect(client.state().state).toBe('connected')
    expect(host.liveConnections('notifier')).toBe(1)
  })
})
