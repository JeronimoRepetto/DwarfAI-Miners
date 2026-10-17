// layer: L8
// The OpenCode plugin route on this OS's real network stack (17 §1.8; ADR-016 items 1–2; 13
// FM-038). Runs only in `pnpm test:os`, on Windows, macOS and Linux alike. Every connection goes to
// an address of this machine: nothing leaves it. The tokens are drawn at run time.
import { connect } from 'node:net'
import { networkInterfaces } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { inMemoryChannelTokens } from '../../modules/preferences/testing/inMemoryChannelTokens'
import { ChannelTokenCheck } from '../auth/channelTokenCheck'
import { createHttpIngress, INGRESS_HOST, type HttpIngress } from './httpIngress'
import {
  createOpenCodePluginRoute,
  OPENCODE_PLUGIN_PATH,
  type OpenCodePluginEvidence
} from './openCodeRoutes'
import { InMemoryIngressPortRecord, post, T0 } from './testing/ingressHarness'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

interface World {
  ingress: HttpIngress
  port: number
  pluginToken: string
  claudeToken: string
  evidence: OpenCodePluginEvidence[]
}

async function setUp(): Promise<World> {
  const tokens = inMemoryChannelTokens()
  const log = new RecordingDiagnosticsLog()
  const evidence: OpenCodePluginEvidence[] = []
  const ingress = createHttpIngress({
    routes: [
      createOpenCodePluginRoute({
        tokens: new ChannelTokenCheck({ tokens: tokens.store, log }),
        observation: { nudge: () => undefined },
        evidence: { accept: (item) => void evidence.push(item) },
        log
      })
    ],
    clock: new FakeClock(T0),
    log,
    portRecord: new InMemoryIngressPortRecord(),
    onPortChanged: () => undefined
  })
  const port = await ingress.start()
  cleanups.push(() => ingress.close())
  return {
    ingress,
    port,
    pluginToken: tokens.issue('opencode-plugin', T0),
    claudeToken: tokens.issue('claude-hooks', T0),
    evidence
  }
}

/** Whether a TCP connection to `host:port` is accepted. */
function connects(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    socket.setTimeout(2_000)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('timeout', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('error', () => resolve(false))
  })
}

/** The IPv6 loopback and every non-loopback address of this machine's interfaces. */
function otherInterfaceAddresses(): string[] {
  const addresses = ['::1']
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      // Link-local IPv6 needs a zone id to be dialled; the IPv4 and global ones are enough.
      if (entry.internal || entry.address.startsWith('fe80')) continue
      addresses.push(entry.address)
    }
  }
  return addresses
}

const REPORT = JSON.stringify({
  event: {
    type: 'permission.asked',
    properties: { id: 'per-1', sessionID: 'ses-1', permission: 'edit', patterns: ['a.txt'] }
  },
  serverUrl: 'http://127.0.0.1:4096/'
})

describe('the OpenCode plugin route on this OS (ADR-016 item 2)', () => {
  it('[ADR-016] the ingress binds 127.0.0.1 explicitly and answers nothing on another interface', async () => {
    const w = await setUp()

    expect(await connects(INGRESS_HOST, w.port)).toBe(true)
    const others = otherInterfaceAddresses()
    expect(others.length).toBeGreaterThan(0)
    const reached = await Promise.all(others.map((address) => connects(address, w.port)))
    expect(Object.fromEntries(others.map((address, i) => [address, reached[i]]))).toStrictEqual(
      Object.fromEntries(others.map((address) => [address, false]))
    )

    const accepted = await post(w.port, {
      path: OPENCODE_PLUGIN_PATH,
      headers: { 'x-dwarfai-token': w.pluginToken },
      body: REPORT
    })
    expect(accepted.status).toBe(204)
    expect(w.evidence).toHaveLength(1)
  })

  it('[FM-038] a Claude hook token on the OpenCode route is answered 401 over the real socket', async () => {
    const w = await setUp()

    const crossed = await post(w.port, {
      path: OPENCODE_PLUGIN_PATH,
      headers: { 'x-dwarfai-token': w.claudeToken },
      body: REPORT
    })

    expect(crossed.status).toBe(401)
    expect(crossed.body).toBe('')
    expect(crossed.headers.connection).toBe('close')
    expect(w.evidence).toStrictEqual([])
  })
})
