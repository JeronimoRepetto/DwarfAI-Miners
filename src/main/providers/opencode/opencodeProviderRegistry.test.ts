import { describe, expect, it, vi } from 'vitest'
import { FakeFs } from '../../adapters/fakeFs'
import { MemorySqlite } from '../../adapters/memorySqlite'
import { defaultConfig } from '../../config/config'
import { PROVIDER_REGISTRY, type ProviderContext } from '../registry'
import { OpenCodeProvider } from './opencodeProvider'
import { OPENCODE_SCHEMA, sessionInsert } from './stateSeed'
import { opencodeDbPath, opencodeWalPath } from './store'

/*
 * Issue #444. The registry row's one job: wire `providers.opencode.storeRoot`
 * through `expandPath` — no platform, no probe, no held-session lookup, as
 * `codexProviderRegistry.test.ts` proves for Codex's own row.
 */

const EXPANDED_ROOT = '/home/j/.local/share/opencode'

function context(
  expandPath: ProviderContext['expandPath'],
  sqlite = new MemorySqlite()
): ProviderContext {
  return {
    config: defaultConfig(),
    fs: new FakeFs(),
    sqlite,
    platform: {
      processProbe: {
        isCodexProcessRunning: vi.fn().mockResolvedValue(false),
        processStartTimeMs: vi.fn().mockResolvedValue(undefined)
      }
    } as unknown as ProviderContext['platform'],
    expandPath,
    isHeldSession: () => false,
    isPermissionPromptOpen: () => false,
    heldWorkspaceOf: () => undefined,
    openCodePendingAsk: () => undefined
  }
}

describe('PROVIDER_REGISTRY.opencode', () => {
  it('builds an OpenCodeProvider that answers to its own identity', () => {
    const provider = PROVIDER_REGISTRY.opencode(context((path) => path))
    expect(provider.kind).toBe('opencode')
    expect(provider).toBeInstanceOf(OpenCodeProvider)
  })

  it("wires the configured store root through expandPath, not the raw '~' value", async () => {
    const expandPath = vi.fn((path: string) =>
      path === '~/.local/share/opencode' ? EXPANDED_ROOT : path
    )
    const fake = new FakeFs()
    const dbPath = opencodeDbPath(EXPANDED_ROOT)
    const walPath = opencodeWalPath(EXPANDED_ROOT)
    fake.addFile(dbPath, 'x'.repeat(100), 0)
    fake.addFile(walPath, 'y'.repeat(10), 0)
    const sqlite = new MemorySqlite()
    sqlite.define(dbPath, OPENCODE_SCHEMA)
    sqlite.exec(
      dbPath,
      sessionInsert({
        id: 'ses_a',
        directory: '/home/j/Sample-Project',
        timeUpdatedMs: Date.now()
      })
    )

    const ctx = context(expandPath, sqlite)
    ctx.fs = fake
    const provider = PROVIDER_REGISTRY.opencode(ctx)

    const snapshots = await provider.scan()
    expect(expandPath).toHaveBeenCalledWith('~/.local/share/opencode')
    expect(snapshots.map((snapshot) => snapshot.sessionId)).toEqual(['ses_a'])
  })

  it('takes no platform, no process probe and no held-session lookup', () => {
    // Verified by construction: the factory's own destructured parameter list
    // (registry.ts) names only config, fs, sqlite, expandPath and
    // openCodePendingAsk for this row (#588 T4 added the last one) — this
    // asserts the built provider works with a context whose platform seam is
    // never touched.
    const provider = PROVIDER_REGISTRY.opencode(context((path) => path))
    expect(provider.transcriptPath?.('opencode:anything')).toBeUndefined()
    expect(provider.textDelivery?.('opencode:anything')).toBeNull()
  })

  it("wires openCodePendingAsk through to a scanned dwarf's pendingPermission (#588 T4)", async () => {
    const dbPath = opencodeDbPath(EXPANDED_ROOT)
    const walPath = opencodeWalPath(EXPANDED_ROOT)
    const fake = new FakeFs()
    fake.addFile(dbPath, 'x'.repeat(100), 0)
    fake.addFile(walPath, 'y'.repeat(10), 0)
    const sqlite = new MemorySqlite()
    sqlite.define(dbPath, OPENCODE_SCHEMA)
    sqlite.exec(
      dbPath,
      sessionInsert({ id: 'ses_a', directory: '/home/j/p', timeUpdatedMs: Date.now() })
    )

    const expandPath = (path: string) => (path === '~/.local/share/opencode' ? EXPANDED_ROOT : path)
    const ctx = context(expandPath, sqlite)
    ctx.fs = fake
    ctx.openCodePendingAsk = (sessionId) =>
      sessionId === 'ses_a'
        ? {
            provider: 'opencode',
            kind: 'asked',
            serverUrl: 'http://127.0.0.1:1/',
            sessionId: 'ses_a',
            requestId: 'per_1',
            permission: 'bash'
          }
        : undefined

    const provider = PROVIDER_REGISTRY.opencode(ctx)
    const [snapshot] = await provider.scan()
    expect(snapshot?.dwarfs[0]?.pendingPermission?.toolUseId).toBe('per_1')
    expect(snapshot?.dwarfs[0]?.waitingReason).toBe('approval')
  })
})
