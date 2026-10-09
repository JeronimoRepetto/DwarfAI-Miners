// layer: L2
// L2 (17 §1.2): `PreferencesCommands.setClaudeHooks` (16 §4.12, AMENDMENT-7; 16 §7.3, §7.4; 07
// machine 14; ADR-016 items 1, 5–7; UC-076; 13 FM-148) over the in-memory integration settings
// and channel token stores, the scripted config writer and a recording bus that refuses a publish
// inside a transaction (16 §2.3). The scripted writer here also keeps the integration setting as
// the engine's Tx B and revert do (16 §7.3, §7.4; configWriterEngine.ts), which the real engine
// proves over FakeFs in host/wiring/preferencesWiring.test.ts.
import { describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { Result } from '../../../kernel/domain/values'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { PreferencesEvent } from '../domain/events'
import type { ChannelToken, ConfigTarget, ConsentOrigin } from '../ports/externalConfigWriter'
import { FakeExternalConfigWriter } from '../ports/fakes/FakeExternalConfigWriter'
import { FakeFeatureFlagReader } from '../ports/fakes/FakeFeatureFlagReader'
import { InMemoryChannelTokenStore } from '../ports/fakes/InMemoryChannelTokenStore'
import { InMemoryIntegrationSettingStore } from '../ports/fakes/InMemoryIntegrationSettingStore'
import { InMemoryPreferencesStore } from '../ports/fakes/InMemoryPreferencesStore'
import type { IntegrationSettingStore } from '../ports/integrationSettingStore'
import { drawToken, hashOf } from '../testing/inMemoryChannelTokens'
import { PreferencesService, type MintedCredential } from './preferencesService'

const T0 = 1_760_000_000_000
const EPOCH = 'epoch-0221'

/**
 * The scripted writer, keeping `integration_settings` as the engine does: `on-verified` with the
 * consent origin after a verified install, `off` after a revert; a failure leaves it as it was.
 */
class SettingsKeepingWriter extends FakeExternalConfigWriter {
  /** The plaintext token of every install, in order (the only place it may reach). */
  readonly tokens: string[] = []

  constructor(
    private readonly settings: IntegrationSettingStore,
    private readonly clock: FakeClock
  ) {
    super()
  }

  override async install(target: ConfigTarget, token: ChannelToken, origin: ConsentOrigin) {
    this.tokens.push(token)
    const result = await super.install(target, token, origin)
    if (result.ok) {
      this.settings.save({
        id: 'claude-hooks',
        state: 'on-verified',
        consentOrigin: origin,
        changedAt: this.clock.now()
      })
    }
    return result
  }

  override async revert(target: ConfigTarget): Promise<Result<void, 'locked' | 'io'>> {
    const result = await super.revert(target)
    if (result.ok)
      this.settings.save({ id: 'claude-hooks', state: 'off', changedAt: this.clock.now() })
    return result
  }
}

function world() {
  const clock = new FakeClock(T0)
  const settings = new InMemoryIntegrationSettingStore(T0)
  const tokens = new InMemoryChannelTokenStore()
  const writer = new SettingsKeepingWriter(settings, clock)
  const minted: MintedCredential[] = []
  let open = false
  const transactions: TransactionRunner = {
    inTransaction<T>(work: () => T): T {
      const before = tokens.snapshot()
      open = true
      try {
        return work()
      } catch (error) {
        tokens.restore(before)
        throw error
      } finally {
        open = false
      }
    }
  }
  const bus = new RecordingEventBus<PreferencesEvent>({
    transactionScope: { isInTransaction: () => open }
  })
  const preferences = new PreferencesService({
    store: new InMemoryPreferencesStore(),
    transactions,
    bus,
    clock,
    ids: new SequenceIdGenerator(),
    hostEpoch: EPOCH,
    featureFlags: new FakeFeatureFlagReader(),
    integrations: settings,
    tokens,
    externalConfig: writer,
    mintCredential: () => {
      const value = drawToken()
      const credential = { value, sha256: hashOf(value) }
      minted.push(credential)
      return credential
    }
  })
  const changes = () => bus.ofType('IntegrationChanged').map((event) => ({ ...event.payload }))
  return { preferences, settings, tokens, writer, bus, clock, minted, changes }
}

describe('PreferencesCommands.setClaudeHooks (16 §4.12, AMENDMENT-7)', () => {
  it("[US-SET-013.AC01, S14.02] turning the toggle on writes DwarfAI's hook entry, records origin settings and reaches on-verified, after which the ingress accepts the new token", async () => {
    const w = world()

    const result = await w.preferences.setClaudeHooks(true, 'settings')

    expect(result).toStrictEqual({ ok: true, value: { state: 'on-verified' } })
    expect(w.writer.installs).toStrictEqual([{ target: 'claude-hooks', origin: 'settings' }])
    expect(w.writer.installed('claude-hooks')).toBe(true)
    expect(w.settings.get('claude-hooks')).toMatchObject({
      state: 'on-verified',
      consentOrigin: 'settings'
    })
    expect(w.preferences.integrationState('claude-hooks')).toBe('on-verified')
    // The ingress authenticates against the active hash: the one of the token the entry holds.
    expect(w.minted).toHaveLength(1)
    expect(w.writer.tokens).toStrictEqual([w.minted[0]?.value])
    expect(w.tokens.active('claude-hooks')).toStrictEqual({
      hash: hashOf(w.writer.tokens[0] ?? '')
    })
    expect(w.changes()).toStrictEqual([{ id: 'claude-hooks', state: 'on-verified' }])
  })

  it('[US-SET-013.AC02, S14.01, NFR-SEC-10] a fresh install reads off and no hook entry exists until a consent', () => {
    const w = world()

    expect(w.preferences.integrationState('claude-hooks')).toBe('off')
    expect(w.preferences.integrationSettings()).toStrictEqual([
      { id: 'claude-hooks', state: 'off', changedAt: T0 },
      { id: 'opencode-permissions', state: 'off', changedAt: T0 }
    ])
    expect(w.writer.installed('claude-hooks')).toBe(false)
    expect(w.writer.installs).toStrictEqual([])
    expect(w.tokens.active('claude-hooks')).toBeNull()
    expect(w.bus.published).toStrictEqual([])
  })

  it('[US-SET-013.AC04, S14.06] turning it off removes the entry, revokes the token and leaves the file as before the enable', async () => {
    const w = world()
    await w.preferences.setClaudeHooks(true, 'settings')

    const result = await w.preferences.setClaudeHooks(false, 'settings')

    expect(result).toStrictEqual({ ok: true, value: { state: 'off' } })
    expect(w.writer.reverts).toStrictEqual(['claude-hooks'])
    expect(w.writer.installed('claude-hooks')).toBe(false)
    expect(w.tokens.active('claude-hooks')).toBeNull()
    expect(w.preferences.integrationState('claude-hooks')).toBe('off')
    expect(w.changes()).toStrictEqual([
      { id: 'claude-hooks', state: 'on-verified' },
      { id: 'claude-hooks', state: 'off' }
    ])
  })

  it('[FM-148, S14.04] a failed write leaves the option off, publishes IntegrationChanged off and answers config-write-failed', async () => {
    const w = world()
    w.writer.scriptInstall('claude-hooks', 'io')

    const result = await w.preferences.setClaudeHooks(true, 'settings')

    expect(result).toStrictEqual({ ok: false, error: 'config-write-failed' })
    expect(w.writer.installed('claude-hooks')).toBe(false)
    expect(w.preferences.integrationState('claude-hooks')).toBe('off')
    // Tx B (failure) deletes the Tx A rows: the token minted for the write is not active.
    expect(w.tokens.active('claude-hooks')).toBeNull()
    expect(w.changes()).toStrictEqual([{ id: 'claude-hooks', state: 'off' }])
  })

  it('[FM-148] a turn-off over a locked settings.json keeps the option on and answers config-revert-failed', async () => {
    const w = world()
    await w.preferences.setClaudeHooks(true, 'settings')
    const active = w.tokens.active('claude-hooks')
    w.writer.lock('claude-hooks')

    const result = await w.preferences.setClaudeHooks(false, 'settings')

    expect(result).toStrictEqual({ ok: false, error: 'config-revert-failed' })
    expect(w.writer.installed('claude-hooks')).toBe(true)
    expect(w.preferences.integrationState('claude-hooks')).toBe('on-verified')
    // The entry still holds its token, so the ingress keeps accepting it (16 §7.4).
    expect(w.tokens.active('claude-hooks')).toStrictEqual(active)
    expect(w.changes()).toStrictEqual([
      { id: 'claude-hooks', state: 'on-verified' },
      { id: 'claude-hooks', state: 'on-verified' }
    ])

    // Retry, the file released: a new call turns it off.
    w.writer.lock('claude-hooks', false)
    expect(await w.preferences.setClaudeHooks(false, 'settings')).toStrictEqual({
      ok: true,
      value: { state: 'off' }
    })
  })

  it('[ADR-016] origin add-panel is refused for claude-hooks', async () => {
    const w = world()

    await expect(w.preferences.setClaudeHooks(true, 'add-panel')).rejects.toThrow(
      HostInvariantError
    )
    await expect(w.preferences.setClaudeHooks(false, 'add-panel')).rejects.toThrow(
      HostInvariantError
    )
    expect(w.writer.installs).toStrictEqual([])
    expect(w.writer.reverts).toStrictEqual([])
    expect(w.minted).toStrictEqual([])
    expect(w.tokens.active('claude-hooks')).toBeNull()
    expect(w.bus.published).toStrictEqual([])
  })

  it('[ADR-016, S14.12] the first-run step enables through the same path with origin first-run', async () => {
    const w = world()

    const result = await w.preferences.setClaudeHooks(true, 'first-run')

    expect(result).toStrictEqual({ ok: true, value: { state: 'on-verified' } })
    expect(w.writer.installs).toStrictEqual([{ target: 'claude-hooks', origin: 'first-run' }])
    expect(w.settings.get('claude-hooks').consentOrigin).toBe('first-run')
  })

  it('[ADR-016] a new enable issues a new token and revokes the previous one; enabling an on-verified integration is a no-op', async () => {
    const w = world()
    await w.preferences.setClaudeHooks(true, 'settings')
    const first = w.tokens.active('claude-hooks')

    // On and verified: nothing is minted or written again (16 §7.5).
    expect(await w.preferences.setClaudeHooks(true, 'settings')).toStrictEqual({
      ok: true,
      value: { state: 'on-verified' }
    })
    expect(w.minted).toHaveLength(1)
    expect(w.tokens.active('claude-hooks')).toStrictEqual(first)

    await w.preferences.setClaudeHooks(false, 'settings')
    await w.preferences.setClaudeHooks(true, 'settings')

    expect(w.minted).toHaveLength(2)
    expect(w.tokens.active('claude-hooks')).toStrictEqual({ hash: w.minted[1]?.sha256 })
    expect(w.tokens.active('claude-hooks')).not.toStrictEqual(first)
    const rows = w.tokens.snapshot()
    expect(rows.filter((row) => row.revokedAt === null)).toHaveLength(1)
    expect(rows.find((row) => row.hash === first?.hash)?.revokedAt).not.toBeNull()
  })

  it('[ADR-016, NFR-SEC-12] the token plaintext reaches only the writer: never a stored row, a setting or an event', async () => {
    const w = world()
    await w.preferences.setClaudeHooks(true, 'settings')
    await w.preferences.setClaudeHooks(false, 'settings')
    await w.preferences.setClaudeHooks(true, 'settings')

    const values = w.minted.map((credential) => credential.value)
    expect(values).toHaveLength(2)
    const stored = JSON.stringify({
      tokens: w.tokens.snapshot(),
      settings: w.preferences.integrationSettings(),
      events: w.bus.published
    })
    for (const value of values) expect(stored).not.toContain(value)
    expect(w.tokens.snapshot().map((row) => row.hash)).toStrictEqual(
      w.minted.map((credential) => credential.sha256)
    )
  })

  it('[ADR-016] calls are answered one at a time: a turn-off asked during an enable settles after it', async () => {
    const w = world()

    const [on, off] = await Promise.all([
      w.preferences.setClaudeHooks(true, 'settings'),
      w.preferences.setClaudeHooks(false, 'settings')
    ])

    expect(on).toStrictEqual({ ok: true, value: { state: 'on-verified' } })
    expect(off).toStrictEqual({ ok: true, value: { state: 'off' } })
    expect(w.tokens.active('claude-hooks')).toBeNull()
    expect(w.changes()).toStrictEqual([
      { id: 'claude-hooks', state: 'on-verified' },
      { id: 'claude-hooks', state: 'off' }
    ])
  })
})
