import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FakeFs } from '../adapters/fakeFs'
import { MemorySqlite } from '../adapters/memorySqlite'
import { defaultConfig } from '../config/config'
import { DWARF_PROVIDERS } from '../domain/types'
import type { Provider } from './provider'
import {
  PROVIDER_REGISTRY,
  PROVIDER_TOKEN_DECLARATION,
  createProviders,
  type ProviderContext
} from './registry'

/*
 * Issue #78. `realProviders()` was an array literal inside the runtime's
 * constructor, so a third backend was a third `new XProvider({...})` written
 * inline among the wiring — the third of #78's four places.
 *
 * The registry is a table of factories keyed by provider identity, and these
 * are the two things that has to buy: the table is exhaustive over the shared
 * provider table (a member added to DWARF_PROVIDERS stops it compiling until
 * its factory row exists), and ONE entry is all it takes for a provider to be
 * built. (The end-to-end half, through today's runtime, left with that runtime:
 * ISSUE-243.)
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
    heldWorkspaceOf: () => undefined,
    // AMENDED for #588 T4: the context gained one more narrow seam, for the
    // OpenCode registry's own pending ask. Nothing here holds one either.
    openCodePendingAsk: () => undefined
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

// AMENDED for ISSUE-243 (was: describe('registering a provider'), one registry entry reaching the panel through today's
// runtime's poll loop, and the same runtime without it publishing nothing): today's runtime left the tree (21 §2 cut 5).

/*
 * Issue #540. `PROVIDER_TOKEN_DECLARATION` is the one pin: every provider
 * whose on-disk record can carry token usage says 'mines' here, and every
 * provider whose record proves none declares itself token-less, in its own
 * words, pinned to the build that reading was verified on. The table's type
 * is Record<DwarfProvider, ...>, exactly like PROVIDER_REGISTRY above, so a
 * provider added to DWARF_PROVIDERS with no row here stops this file
 * compiling — the same enforcement, proven the same indirect way the
 * registry's own describe above proves it: by asserting the two key sets
 * agree, not by trying to add a member to a string-literal union at runtime.
 */
describe('PROVIDER_TOKEN_DECLARATION', () => {
  it('declares exactly one entry per provider identity', () => {
    expect(Object.keys(PROVIDER_TOKEN_DECLARATION).sort()).toEqual([...DWARF_PROVIDERS].sort())
  })

  it('every token-less declaration names the build it was verified on', () => {
    for (const provider of DWARF_PROVIDERS) {
      const declaration = PROVIDER_TOKEN_DECLARATION[provider]
      if (declaration === 'mines') continue
      expect(declaration.tokenless).toBe(true)
      expect(declaration.verifiedOn.length).toBeGreaterThan(0)
    }
  })

  it('proves every "mines" provider has its own test asserting tokensObserved', () => {
    // A canary, not a re-run of those suites: if a provider's declaration
    // ever says 'mines' while its own test directory stops proving
    // tokensObserved anywhere, this fails loudly instead of the claim going
    // silently stale.
    for (const provider of DWARF_PROVIDERS) {
      if (PROVIDER_TOKEN_DECLARATION[provider] !== 'mines') continue
      const dir = join(import.meta.dirname, provider)
      const testFiles = readdirSync(dir).filter((name) => name.endsWith('.test.ts'))
      const provesTokens = testFiles.some((name) =>
        readFileSync(join(dir, name), 'utf8').includes('tokensObserved')
      )
      expect(provesTokens, `${provider}'s own tests never mention tokensObserved`).toBe(true)
    }
  })
})
