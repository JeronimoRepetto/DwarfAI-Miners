import { describe, expect, it, vi } from 'vitest'
import { FakeFs } from '../adapters/fakeFs'
import { MemorySqlite } from '../adapters/memorySqlite'
import { defaultConfig } from '../config/config'
import { DWARF_PROVIDERS, type Mine } from '../domain/types'
import { AgentRuntime } from '../runtime/runtime'
import type { Provider } from './provider'
import { PROVIDER_REGISTRY, createProviders, type ProviderContext } from './registry'

/*
 * Issue #78. `realProviders()` was an array literal inside the runtime's
 * constructor, so a third backend was a third `new XProvider({...})` written
 * inline among the wiring — the third of #78's four places.
 *
 * The registry is a table of factories keyed by provider identity, and these
 * are the two things that has to buy: the table is exhaustive over the shared
 * provider table (a member added to DWARF_PROVIDERS stops it compiling until
 * its factory row exists), and ONE entry is all it takes for a provider to be
 * built, scanned and published — asserted end to end through the real runtime
 * below, not against a seam that only the test can see.
 */

function context(): ProviderContext {
  return {
    config: defaultConfig(),
    fs: new FakeFs(),
    sqlite: new MemorySqlite(),
    platform: {
      processProbe: {
        isCodexProcessRunning: vi.fn().mockResolvedValue(false),
        processStartTimeMs: vi.fn().mockResolvedValue(undefined)
      }
    } as unknown as ProviderContext['platform'],
    expandPath: (path) => path,
    isHeldSession: () => false,
    isPermissionPromptOpen: () => false,
    // AMENDED for #237, step 5: the context gained one narrow seam, for the one
    // fact the Antigravity store cannot recover about a conversation this panel
    // holds. Nothing here holds one, so it answers undefined.
    heldWorkspaceOf: () => undefined
  }
}

describe('PROVIDER_REGISTRY', () => {
  it('registers exactly one factory per provider identity', () => {
    expect(Object.keys(PROVIDER_REGISTRY).sort()).toEqual([...DWARF_PROVIDERS].sort())
  })

  it('builds a provider that answers to the identity it was registered under', () => {
    // Nothing in the type system ties a factory's row to the `kind` its
    // provider reports, and a provider filed under the wrong identity would
    // mislabel every dwarf it found.
    for (const [kind, create] of Object.entries(PROVIDER_REGISTRY)) {
      expect(create(context()).kind).toBe(kind)
    }
  })
})

describe('createProviders', () => {
  it('builds every registered provider, in registration order', () => {
    const providers = createProviders(context())
    expect(providers.map((provider) => provider.kind)).toEqual(Object.keys(PROVIDER_REGISTRY))
  })

  it('hands each factory the same context, so nothing reads config twice', () => {
    const shared = context()
    const seen: ProviderContext[] = []
    createProviders(shared, {
      first: (given) => {
        seen.push(given)
        return stubProvider('first')
      },
      second: (given) => {
        seen.push(given)
        return stubProvider('second')
      }
    })
    expect(seen).toEqual([shared, shared])
  })
})

/** A provider with nothing behind it, for the entries a test invents. */
function stubProvider(mineName: string): Provider {
  return {
    kind: 'claude',
    scan: async () => [
      {
        provider: 'claude',
        sessionId: `${mineName}-session`,
        cwd: `C:\\work\\${mineName}`,
        status: 'busy',
        updatedAt: 1,
        dwarfs: [
          {
            id: `${mineName}:session`,
            provider: 'claude',
            role: 'worker',
            name: 'worker',
            status: 'working',
            sessionId: `${mineName}-session`
          }
        ]
      }
    ],
    feed: async () => null
  }
}

describe('registering a provider', () => {
  it('takes one entry to reach the panel, through the runtime that owns the loop', async () => {
    // #78's acceptance. The runtime builds the context and the providers
    // itself — this test adds a row and nothing else, then reads what the
    // panel would be sent. A FakeFs is what keeps the two real backends
    // finding nothing, so the mine that arrives can only be the new row's.
    const published: Mine[][] = []
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      home: 'C:\\Users\\j',
      fs: new FakeFs(),
      providerRegistry: { ...PROVIDER_REGISTRY, arrival: () => stubProvider('newcomer') },
      onMinesUpdated: (mines) => published.push(mines)
    })
    await runtime.refresh()

    expect(published.at(-1)?.map((mine) => mine.path)).toEqual(['C:\\work\\newcomer'])
  })

  it('is the only edit: the same runtime without that entry publishes nothing', async () => {
    // The other half of the claim. If the two real backends were finding
    // anything against a FakeFs, the assertion above would prove nothing.
    const published: Mine[][] = []
    const runtime = new AgentRuntime({
      config: defaultConfig(),
      home: 'C:\\Users\\j',
      fs: new FakeFs(),
      onMinesUpdated: (mines) => published.push(mines)
    })
    await runtime.refresh()

    expect(published.at(-1)).toEqual([])
  })
})
