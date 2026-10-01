import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { endpointFor, type EndpointInput } from '@dwarfai/contracts'
import { RecordingDiagnosticsLog } from '../kernel/fakes/RecordingDiagnosticsLog'
import { NodeScheduler } from '../platform/clock/NodeScheduler'
import type { EndpointFacts } from '../platform/endpoint/nodeEndpointEnv'
import { createUiEndpoint } from './bootSteps'

// L6 (17 §1.6): the bind step's composition — the platform facts, the one ADR-002 D2 rule and the
// real endpoint server — on this OS's real transport. Synthetic SID only (privacy-guard).

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/**
 * A fresh folder for one case. On POSIX it sits directly under `/tmp`: a socket path must fit
 * `sun_path` (104 bytes on macOS), and the macOS runner's `os.tmpdir()`
 * (`/var/folders/<2>/<30>/T`) leaves too little room for it.
 */
function caseRoot(): string {
  const root =
    process.platform === 'win32'
      ? mkdtempSync(join(tmpdir(), 'dwarfai-022-wiring-'))
      : mkdtempSync('/tmp/dw022-')
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  return root
}

/**
 * Facts for this OS under `root`, as the platform adapter reads them: each OS runs its own rule,
 * with its own `sun_path` limit. The macOS home is `root`, so the socket never lands in the real
 * home.
 */
function factsForThisOs(root: string): EndpointInput {
  if (process.platform === 'win32') {
    return { platform: 'win32', hostDataDir: join(root, 'host'), userSid: 'S-1-5-5-0-4242', sha256 }
  }
  if (process.platform === 'darwin') {
    return {
      platform: 'darwin',
      hostDataDir: join(root, 'DwarfAI-Miners', 'host'),
      home: root,
      caseInsensitiveVolume: false,
      sha256
    }
  }
  return { platform: 'linux', hostDataDir: join(root, 'host'), sha256 }
}

function scheduler(): NodeScheduler {
  return new NodeScheduler({ onTaskError: () => {} })
}

describe('the bind step composition (ADR-002 D2, D3)', () => {
  it('[ADR-002] the bind step binds the endpoint the one pure rule names for the hostDataDir, and a client reaches it there', async () => {
    const input = factsForThisOs(caseRoot())
    const facts: EndpointFacts = () => Promise.resolve({ ok: true, value: input })
    const endpoint = createUiEndpoint({
      facts,
      log: new RecordingDiagnosticsLog(),
      scheduler: scheduler()
    })
    cleanups.push(() => endpoint.close())

    expect(await endpoint.bind()).toBe('bound')

    const named = endpointFor(input)
    if (!named.ok) throw new Error(named.error.kind)
    await new Promise<void>((resolve, reject) => {
      const socket = connect(named.value.path)
      socket.once('connect', () => {
        socket.destroy()
        resolve()
      })
      socket.once('error', reject)
    })
  })

  it('[ADR-002, FM-037] facts that cannot be read or an endpoint the rule refuses fail the bind with a typed code', async () => {
    const cases: Array<[Awaited<ReturnType<EndpointFacts>>, string]> = [
      [{ ok: false, cause: 'timed out after 5000 ms' }, 'ENDPOINT_FACTS_UNREADABLE'],
      [
        {
          ok: true,
          value: { platform: 'linux', hostDataDir: `/${'d'.repeat(120)}/host`, sha256 }
        },
        'ENDPOINT_SOCKET_PATH_TOO_LONG'
      ],
      [
        { ok: true, value: { platform: 'win32', hostDataDir: 'C:\\h\\host', sha256 } },
        'ENDPOINT_USER_SID_MISSING'
      ]
    ]
    for (const [answer, code] of cases) {
      const endpoint = createUiEndpoint({
        facts: () => Promise.resolve(answer),
        log: new RecordingDiagnosticsLog(),
        scheduler: scheduler()
      })

      await expect(endpoint.bind(), code).rejects.toMatchObject({ code })
    }
  })
})
