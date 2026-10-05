// layer: L2
import { afterEach, describe, expect, it } from 'vitest'
import type { DwarfId, ProviderIdentity, StranglerDwarfIdentity } from '@dwarfai/contracts'
import { TODAY_SHAPES } from '@dwarfai/contracts'
import { defaultDwarf, type Dwarf, type ProviderSnapshot } from '../main/domain/types'
import { RecordingUiLog } from '../ui-main/hostLauncher/fakes/RecordingUiLog'
import { createHostClient, type HostClientService } from '../ui-main/host-client/HostClient'
import { FAKE_HOST_CAPABILITIES, FakeHost } from '../ui-main/host-client/testing/FakeHost'
import { FakeHostClientTimers } from '../ui-main/host-client/testing/FakeHostClientTimers'
import type { HostClient } from '../ui-main/window/ports/hostClient'
import {
  createLegacyDwarfIdBridge,
  createLegacyDwarfIdRows,
  createLegacyPushTap,
  createLegacyRegistryTap,
  type LegacyDwarfIdBridge
} from './LegacyDwarfIdBridge'
import { NOT_FOUND, NO_SUCH_DWARF } from './rowShapes/notFound'

// L2 (17 §1): `LegacyDwarfIdBridge` (21 §3, cuts 1–4; 14 §5; AMENDMENT-8, OQ-69) over the real HostClient and FakeHost,
// the in-process fake Host speaking seam B, answering B-M41 `strangler.dwarfIdentities` (14 §2.3, §3.4). The legacy side
// of the join is what `LegacyAgentRegistryFeed` wrote into today's in-memory agent registry: today's `ProviderSnapshot`s,
// with today's dwarf ids (`claude:<session>`, `claude:<session>:<agent>`, `codex:<thread>`, written by hand from the
// found tree's providers). The join is exact on the three parts of the provider identity (ADR-015 item 7).
// TC-088-01, TC-088-02.

const hostId = (n: number) =>
  `01920000-0000-7000-9000-0000000e00${String(n).padStart(2, '0')}` as DwarfId
const FOREMAN = hostId(1)
const SUBAGENT = hostId(2)
const CODEX = hostId(3)
const LATECOMER = hostId(4)

const SESSION = '9f1c2a7e-0000-4000-8000-00000000c1a0'
const AGENT = 'a5e1f0c2b3d4'
const THREAD = '0199aa00-0000-7000-8000-00000000c0de'
const LATE_SESSION = '9f1c2a7e-0000-4000-8000-00000000c1a1'

const identity = (
  providerId: string,
  providerSessionId: string,
  providerAgentId?: string
): ProviderIdentity => ({
  providerId,
  providerSessionId,
  ...(providerAgentId === undefined ? {} : { providerAgentId })
})
const entry = (dwarfId: DwarfId, id: ProviderIdentity): StranglerDwarfIdentity => ({
  dwarfId,
  providerId: id.providerId,
  identity: id
})

/** Today's dwarf as today's providers name it (claudeProvider.ts, codexProvider.ts). */
const legacyDwarf = (over: Partial<Dwarf> & Pick<Dwarf, 'id' | 'sessionId'>): Dwarf => ({
  ...defaultDwarf(),
  ...over
})
const claudeSession = (sessionId: string, dwarfs: Dwarf[]): ProviderSnapshot => ({
  provider: 'claude',
  sessionId,
  cwd: '/work/moria',
  status: 'busy',
  dwarfs,
  updatedAt: 1
})

const LEGACY_FOREMAN = `claude:${SESSION}`
const LEGACY_SUBAGENT = `claude:${SESSION}:${AGENT}`
const LEGACY_CODEX = `codex:${THREAD}`
const LEGACY_LATECOMER = `claude:${LATE_SESSION}`

const LEGACY_SESSIONS: ProviderSnapshot[] = [
  claudeSession(SESSION, [
    legacyDwarf({ id: LEGACY_FOREMAN, sessionId: SESSION, role: 'foreman' }),
    legacyDwarf({ id: LEGACY_SUBAGENT, sessionId: SESSION })
  ]),
  {
    provider: 'codex',
    sessionId: THREAD,
    cwd: '/work/moria',
    status: 'idle',
    dwarfs: [legacyDwarf({ id: LEGACY_CODEX, sessionId: THREAD, provider: 'codex' })],
    updatedAt: 1
  },
  claudeSession(LATE_SESSION, [legacyDwarf({ id: LEGACY_LATECOMER, sessionId: LATE_SESSION })])
]

const HOST_SIDE: StranglerDwarfIdentity[] = [
  entry(FOREMAN, identity('claude', SESSION)),
  entry(SUBAGENT, identity('claude', SESSION, AGENT)),
  entry(CODEX, identity('codex', THREAD))
]

const CAPABILITIES = [
  ...FAKE_HOST_CAPABILITIES,
  'section:dwarfs',
  'frame:dwarf.arrived',
  'frame:dwarf.departed',
  'strangler.dwarfIdentities'
]

const clients: HostClientService[] = []
const bridges: LegacyDwarfIdBridge[] = []
afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.dispose()
  for (const client of clients.splice(0)) client.dispose()
})

/** Lets the in-memory pipes and the promises behind them settle. */
async function settle(rounds = 20): Promise<void> {
  for (let round = 0; round < rounds; round += 1)
    await new Promise((resolve) => setImmediate(resolve))
}

/** The HostClient port, every member call recorded by name, with the method of each `call`. */
function recording(client: HostClient, calls: string[]): HostClient {
  return new Proxy(client, {
    get(target, member, receiver) {
      const value: unknown = Reflect.get(target, member, receiver)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        calls.push(member === 'call' ? `call ${String(args[0])}` : String(member))
        return (value as (...a: unknown[]) => unknown).apply(target, args)
      }
    }
  })
}

async function world(hostSide: StranglerDwarfIdentity[], legacy: ProviderSnapshot[]) {
  const host = new FakeHost({ capabilities: CAPABILITIES })
  host.board = [
    {
      section: 'meta',
      data: {
        hostVersion: '0.0.0-fake',
        state: 'ready',
        resetEpoch: 0,
        snapshotTail: 20,
        minesEverKnown: true
      }
    }
  ]
  let present = hostSide
  let reads = 0
  host.handle('strangler.dwarfIdentities', () => {
    reads += 1
    return present
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
  const calls: string[] = []
  const bridge = createLegacyDwarfIdBridge({
    client: recording(client, calls),
    legacy: { sessions: () => legacy }
  })
  bridges.push(bridge)
  await client.ensureHost()
  await settle()
  return {
    host,
    bridge,
    calls,
    reads: () => reads,
    /** The Host's present dwarfs change with no frame (a Host-driven re-bind, 14 §2.4). */
    setPresent: (next: StranglerDwarfIdentity[]) => {
      present = next
    }
  }
}

describe('LegacyDwarfIdBridge over HostClient and FakeHost (21 §3; 14 §5; AMENDMENT-8)', () => {
  it('[ADR-015] a Host dwarf id maps to the legacy id with the same provider identity and back', async () => {
    const { bridge } = await world(HOST_SIDE, LEGACY_SESSIONS)

    expect(await bridge.toLegacy(FOREMAN)).toBe(LEGACY_FOREMAN)
    expect(await bridge.toLegacy(CODEX)).toBe(LEGACY_CODEX)
    expect(await bridge.toHost(LEGACY_FOREMAN)).toBe(FOREMAN)
    expect(await bridge.toHost(LEGACY_CODEX)).toBe(CODEX)
  })

  it('[ADR-015] a Claude subagent and its parent map to two different legacy ids by providerAgentId', async () => {
    const { bridge } = await world(HOST_SIDE, LEGACY_SESSIONS)

    // Both carry the same provider session; only the agent id tells them apart (ADR-015 item 7).
    expect(await bridge.toLegacy(SUBAGENT)).toBe(LEGACY_SUBAGENT)
    expect(await bridge.toLegacy(FOREMAN)).toBe(LEGACY_FOREMAN)
    expect(await bridge.toHost(LEGACY_SUBAGENT)).toBe(SUBAGENT)
    expect(await bridge.toHost(LEGACY_FOREMAN)).toBe(FOREMAN)
  })

  it('[ADR-015] an unmatched dwarf answers the row’s own not-found shape and never a nearest match', async () => {
    // The Host knows a second subagent of the same session that today's registry does not list, and a Codex dwarf
    // whose thread today's registry lists under another provider: neither has an exact partner.
    const stranger = hostId(9)
    const misnamed = hostId(10)
    const { bridge } = await world(
      [
        ...HOST_SIDE,
        entry(stranger, identity('claude', SESSION, 'b0b0b0b0b0b0')),
        entry(misnamed, identity('opencode', THREAD))
      ],
      LEGACY_SESSIONS
    )
    expect(await bridge.toLegacy(stranger)).toBeNull()
    expect(await bridge.toLegacy(misnamed)).toBeNull()
    expect(await bridge.toLegacy(hostId(42))).toBeNull()
    // A legacy dwarf the Host does not list (today's registry still lists the latecomer) has no Host id.
    expect(await bridge.toHost(LEGACY_LATECOMER)).toBeNull()
    expect(await bridge.toHost('claude:not-a-session')).toBeNull()

    // Each row the bridge serves answers its own not-found shape, today's, and today's runtime is never reached.
    const reached: Array<[string, unknown]> = []
    const rows = createLegacyDwarfIdRows({
      bridge,
      legacy: {
        serve: (channel, payload) => {
          reached.push([channel, payload])
          return Promise.resolve('served')
        }
      }
    })
    const asked: Array<[string, unknown]> = [
      ['dwarf:activate', stranger],
      ['dwarf:sendText', { dwarfId: stranger, text: 'hello', pressEnter: true }],
      ['dwarf:kick', { dwarfId: stranger }],
      ['dwarf:retire', stranger]
    ]
    for (const [channel, payload] of asked) {
      const answer = await rows.serve(channel, payload)
      expect(answer, channel).toEqual(NOT_FOUND[channel as keyof typeof NOT_FOUND])
      expect(TODAY_SHAPES[channel]?.response.safeParse(answer).success, channel).toBe(true)
    }
    expect(NOT_FOUND['dwarf:sendText'].error).toBe(NO_SUCH_DWARF)
    expect(reached).toEqual([])

    // A settled send of a legacy dwarf the Host does not list is withheld: no guess and no legacy id reach a renderer.
    expect(
      await rows.push('dwarf:sendText:settled', {
        holdId: 'hold-1',
        dwarfId: LEGACY_LATECOMER,
        result: { delivered: true, via: 'claude-relay' }
      })
    ).toBeNull()
  })

  it('[ADR-015] a dwarf that arrived since the last read is found after the re-read before not-found', async () => {
    const { bridge, reads, setPresent } = await world(HOST_SIDE, LEGACY_SESSIONS)
    const before = reads()
    expect(before).toBeGreaterThanOrEqual(1)

    // The latecomer is present at the Host, but no frame has reached the bridge yet (a Host-driven re-bind has none).
    setPresent([...HOST_SIDE, entry(LATECOMER, identity('claude', LATE_SESSION))])
    expect(await bridge.toLegacy(LATECOMER)).toBe(LEGACY_LATECOMER)
    // Exactly one more read of B-M41, before the answer.
    expect(reads()).toBe(before + 1)
    expect(await bridge.toHost(LEGACY_LATECOMER)).toBe(LATECOMER)
    expect(reads()).toBe(before + 1)

    // A dwarf still unknown after that read is not found, after exactly one more read.
    expect(await bridge.toLegacy(hostId(42))).toBeNull()
    expect(reads()).toBe(before + 2)
  })

  it('[ADR-015] the Host side is re-read after every snapshot, dwarf.arrived and dwarf.departed frame', async () => {
    const { host, reads, setPresent, bridge } = await world(HOST_SIDE, LEGACY_SESSIONS)
    const before = reads()
    setPresent([...HOST_SIDE, entry(LATECOMER, identity('claude', LATE_SESSION))])
    host.publish('dwarf.arrived', { dwarf: {}, announce: false })
    await settle()
    expect(reads()).toBe(before + 1)
    // Read already: the answer needs no read of its own.
    expect(await bridge.toLegacy(LATECOMER)).toBe(LEGACY_LATECOMER)
    expect(reads()).toBe(before + 1)

    setPresent(HOST_SIDE)
    host.publish('dwarf.departed', { dwarfId: LATECOMER, mineId: hostId(50), cause: 'stopped' })
    await settle()
    expect(reads()).toBe(before + 2)
  })

  it('[ADR-015] the bridge is read-only toward the Host: it only subscribes and reads strangler.dwarfIdentities', async () => {
    const { host, bridge, calls } = await world(HOST_SIDE, LEGACY_SESSIONS)
    await bridge.toLegacy(FOREMAN)
    await bridge.toLegacy(hostId(42))
    await bridge.toHost(LEGACY_CODEX)
    host.publish('dwarf.departed', { dwarfId: CODEX, mineId: hostId(50), cause: 'stopped' })
    await settle()
    bridge.dispose()
    expect(new Set(calls)).toEqual(new Set(['subscribe', 'call strangler.dwarfIdentities']))
    expect(
      host.received
        .map((r) => r.method)
        .filter((m) => !['events.subscribe', 'session.snapshot'].includes(m))
    ).toEqual(
      Array(calls.filter((c) => c.startsWith('call ')).length).fill('strangler.dwarfIdentities')
    )
  })

  it('[ADR-015] a matched row reaches today’s runtime with the legacy id, and its settled push returns with the Host id', async () => {
    const { bridge } = await world(HOST_SIDE, LEGACY_SESSIONS)
    const reached: Array<[string, unknown]> = []
    const rows = createLegacyDwarfIdRows({
      bridge,
      legacy: {
        serve: (channel, payload) => {
          reached.push([channel, payload])
          return Promise.resolve({ delivered: true, via: 'claude-relay', holdId: 'hold-1' })
        }
      }
    })
    await rows.serve('dwarf:activate', SUBAGENT)
    await rows.serve('dwarf:sendText', { dwarfId: FOREMAN, text: 'hello', pressEnter: true })
    await rows.serve('dwarf:kick', { dwarfId: CODEX })
    await rows.serve('dwarf:retire', CODEX)
    // A row the bridge does not serve passes unchanged.
    await rows.serve('mine:history', 'mine-1')
    expect(reached).toEqual([
      ['dwarf:activate', LEGACY_SUBAGENT],
      ['dwarf:sendText', { dwarfId: LEGACY_FOREMAN, text: 'hello', pressEnter: true }],
      ['dwarf:kick', { dwarfId: LEGACY_CODEX }],
      ['dwarf:retire', LEGACY_CODEX],
      ['mine:history', 'mine-1']
    ])

    const settled = await rows.push('dwarf:sendText:settled', {
      holdId: 'hold-1',
      dwarfId: LEGACY_FOREMAN,
      result: { delivered: true, via: 'claude-relay' }
    })
    expect(settled).toEqual({
      holdId: 'hold-1',
      dwarfId: FOREMAN,
      result: { delivered: true, via: 'claude-relay' }
    })
    expect(TODAY_SHAPES['dwarf:sendText:settled']?.response.safeParse(settled).success).toBe(true)
    // A-P3 carries no dwarf id: it passes unchanged.
    const failed = {
      launchId: 'launch:1',
      provider: 'codex',
      mineId: 'mine-1',
      exitCode: 1,
      stderrTail: '',
      cause: 'exited-at-once'
    }
    expect(await rows.push('agent:launchFailed', failed)).toEqual(failed)
  })

  it('[ADR-015] the legacy side is what LegacyAgentRegistryFeed last wrote, and today’s pushes keep their order through the tap', async () => {
    const written: Array<readonly ProviderSnapshot[]> = []
    const tap = createLegacyRegistryTap({ replace: (sessions) => void written.push(sessions) })
    expect(tap.sessions()).toEqual([])
    tap.registry.replace(LEGACY_SESSIONS)
    expect(tap.sessions()).toEqual(LEGACY_SESSIONS)
    expect(written).toEqual([LEGACY_SESSIONS])

    // Pushes of other rows go out at once; with a mapping installed, the bridged ones keep their relative order.
    const delivered: Array<[string, unknown]> = []
    const deliver = (channel: string, payload: unknown) => void delivered.push([channel, payload])
    const pushes = createLegacyPushTap()
    pushes.send('mines:update', 1, deliver)
    expect(delivered).toEqual([['mines:update', 1]])
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const uninstall = pushes.install({
      pushChannels: ['dwarf:sendText:settled'],
      push: async (_channel, payload) => {
        if (payload === 'slow') await gate
        return payload === 'withheld' ? null : `${String(payload)}*`
      }
    })
    pushes.send('dwarf:sendText:settled', 'slow', deliver)
    pushes.send('dwarf:sendText:settled', 'withheld', deliver)
    pushes.send('dwarf:sendText:settled', 'fast', deliver)
    pushes.send('mines:update', 2, deliver)
    await settle()
    expect(delivered).toEqual([
      ['mines:update', 1],
      ['mines:update', 2]
    ])
    release()
    await settle()
    expect(delivered).toEqual([
      ['mines:update', 1],
      ['mines:update', 2],
      ['dwarf:sendText:settled', 'slow*'],
      ['dwarf:sendText:settled', 'fast*']
    ])
    uninstall()
    pushes.send('dwarf:sendText:settled', 'plain', deliver)
    expect(delivered.at(-1)).toEqual(['dwarf:sendText:settled', 'plain'])
  })
})
