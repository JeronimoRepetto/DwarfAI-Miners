// layer: L8
// The loopback ingress on this OS's real network stack (17 §1.8; ADR-016 item 2; 18 T-41, C-16b;
// 13 FM-038). Runs only in `pnpm test:os`, on Windows, macOS and Linux alike. Every connection goes
// to an address of this machine: nothing leaves it.
import { connect } from 'node:net'
import { networkInterfaces } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { drawToken } from '../../modules/preferences/testing/inMemoryChannelTokens'
import { INGRESS_HOST } from './httpIngress'
import { hookBody, post, startHarness, type Harness } from './testing/ingressHarness'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setUp(): Promise<Harness> {
  const harness = await startHarness()
  cleanups.push(() => harness.ingress.close())
  return harness
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

describe('the loopback ingress on this OS (ADR-016 item 2)', () => {
  it('[ADR-016] the listener binds 127.0.0.1 only and a connection to another interface address is refused', async () => {
    const h = await setUp()

    expect(await connects(INGRESS_HOST, h.port)).toBe(true)
    const others = otherInterfaceAddresses()
    expect(others.length).toBeGreaterThan(0)
    const reached = await Promise.all(others.map((address) => connects(address, h.port)))
    expect(Object.fromEntries(others.map((address, i) => [address, reached[i]]))).toStrictEqual(
      Object.fromEntries(others.map((address) => [address, false]))
    )
  })

  it('[FM-038] a rejected hook call is answered 401 over the real socket', async () => {
    const h = await setUp()

    const wrong = await post(h.port, {
      headers: { 'x-dwarfai-token': drawToken() },
      body: hookBody()
    })
    expect(wrong.status).toBe(401)
    expect(wrong.body).toBe('')
    expect(wrong.headers.connection).toBe('close')

    h.setState('off')
    const off = await post(h.port, { headers: { 'x-dwarfai-token': h.token }, body: hookBody() })
    expect(off.status).toBe(401)
    expect(h.evidence).toStrictEqual([])
  })
})
