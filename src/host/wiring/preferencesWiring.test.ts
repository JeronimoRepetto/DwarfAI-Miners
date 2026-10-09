// layer: L2
// L2 (17 §1.2): the "Claude Code · instant updates" toggle as host/wiring/preferencesWiring.ts
// wires it (16 §4.12 `setClaudeHooks`, AMENDMENT-7; 16 §7.3, §7.4; 07 machine 14; ADR-016 items 1,
// 5–7; UC-076): the real preferences module over a copy of the template database, the real config
// writer engine with the `claude-hooks` target over FakeFs and the hand-written `settings.json`
// fixtures, the transport's credential minter, the Reset saga of ISSUE-212, and the hook ingress
// route of ISSUE-133 with the channel token check of ISSUE-219 over the same `channel_tokens`.
// `IntegrationChanged` reaches the connections as `integration.changed` (B-F25).
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { HOST_FRAME_SCHEMAS } from '@dwarfai/contracts'
import { HostInvariantError } from '../kernel/domain/errors'
import type { HostEpoch } from '../kernel/domain/values'
import { FakeClock } from '../kernel/fakes/FakeClock'
import { FakeFs } from '../kernel/fakes/FakeFs'
import { FakeScheduler } from '../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../kernel/fakes/RecordingDiagnosticsLog'
import { SequenceIdGenerator } from '../kernel/fakes/SequenceIdGenerator'
import { InProcessEventBus } from '../kernel/InProcessEventBus'
import type { FileSystemSubject } from '../kernel/testing/fileSystem.contract'
import { SqliteLedgerRepository } from '../modules/ledger/adapters/SqliteLedgerRepository'
import type {
  ExternalConfigWriter,
  MintedCredential,
  PreferencesEvent
} from '../modules/preferences'
import {
  claudeHooksWorld,
  fixture
} from '../modules/preferences/adapters/external-config/claudeHooks/testing/claudeHooksWorld'
import { SqliteChannelTokenStore } from '../modules/preferences/adapters/sqlite/SqliteChannelTokenStore'
import { SqliteIntegrationSettingStore } from '../modules/preferences/adapters/sqlite/SqliteIntegrationSettingStore'
import { SqliteTransactionRunner } from '../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../platform/sqlite/testing/templateDb'
import { ChannelTokenCheck } from '../transport/auth/channelTokenCheck'
import { mintCredential } from '../transport/auth/mintCredential'
import { ConnectionRegistry } from '../transport/connectionRegistry'
import { Dispatcher } from '../transport/dispatcher'
import { createClaudeHooksRoute } from '../transport/ingress/claudeHooksRoute'
import { SectionRegistry } from '../transport/snapshot/sectionRegistry'
import { createFeatureFlagReader, featureFlagConfigFilePath } from './featureFlagReader'
import { createModuleResetSteps } from './moduleResetSteps'
import { servePreferences, unavailableSecretStore } from './preferencesWiring'

const T0 = 1_790_000_000_000

function validateFrame(name: string, data: unknown): void {
  const schemas: Readonly<Record<string, z.ZodTypeAny | undefined>> = HOST_FRAME_SCHEMAS
  const schema = schemas[name]
  if (schema === undefined) throw new Error(`no contract schema for ${name}`)
  schema.parse(data)
}

/** A connection registry that validates and records every frame published to it. */
class RecordingConnections extends ConnectionRegistry {
  readonly frames: Array<{ name: string; data: unknown }> = []
  override publish: ConnectionRegistry['publish'] = (name, data) => {
    validateFrame(name, data)
    this.frames.push({ name, data })
  }
}

function memory(): FileSystemSubject {
  const fs = new FakeFs()
  return {
    fs,
    pathOf: (...segments) => ['/home/j', ...segments].join('/'),
    seed: async (path, content) => fs.addFile(path, content)
  }
}

/** The module wired as host/main.ts wires it, over the real `claude-hooks` writer. */
async function host() {
  const clock = new FakeClock(T0)
  const scheduler = new FakeScheduler(clock)
  const log = new RecordingDiagnosticsLog()
  const connections = new RecordingConnections()
  const served = servePreferences({
    dispatcher: new Dispatcher({ log, clock, scheduler, state: () => 'ready' }),
    sections: new SectionRegistry(),
    connections
  })
  const { db } = openTemplateCopy()
  const transactions = new SqliteTransactionRunner(db)
  const ids = new SequenceIdGenerator()
  const world = await claudeHooksWorld(memory(), db)
  // The engine holds the `claude-hooks` target only: the OpenCode target is not built yet (later:
  // ISSUE-227), so DwarfAI owns nothing there and the Reset saga's revert of it has nothing to do.
  const writer: ExternalConfigWriter = {
    install: (target, token, origin) => world.writer.install(target, token, origin),
    verify: (target) => world.writer.verify(target),
    revert: (target) =>
      target === 'claude-hooks'
        ? world.writer.revert(target)
        : Promise.resolve({ ok: true, value: undefined }),
    findLegacy: (target) => world.writer.findLegacy(target)
  }
  // The transport's minter, recorded so a case can find the token the entry was written with.
  const minted: MintedCredential[] = []
  const wired = served.wire({
    db,
    transactions,
    bus: new InProcessEventBus<PreferencesEvent>({
      transactionScope: transactions,
      onHandlerError: (failure) => {
        throw failure.error
      }
    }),
    clock,
    ids,
    hostEpoch: 'epoch-0221' as HostEpoch,
    log,
    featureFlags: await createFeatureFlagReader({
      env: {},
      fs: new FakeFs(),
      configFilePath: featureFlagConfigFilePath('/data'),
      log
    }),
    maintenance: {
      deleteBackups: () => undefined,
      truncateWal: () => undefined,
      vacuum: () => undefined
    },
    ledger: new SqliteLedgerRepository({ db, scope: transactions, ids, clock }),
    moduleSteps: createModuleResetSteps({
      db,
      scope: transactions,
      clock,
      mapSites: [],
      random: () => 0
    }).steps,
    secrets: unavailableSecretStore,
    externalConfig: writer,
    mintCredential: () => {
      const credential = mintCredential()
      minted.push(credential)
      return credential
    },
    ready: () => false
  })
  const tokens = new SqliteChannelTokenStore({ db, ids })
  const ingress = createClaudeHooksRoute({
    tokens: new ChannelTokenCheck({ tokens, log }),
    preferences: wired.preferences.queries,
    observation: { nudge: () => undefined },
    evidence: { accept: () => undefined },
    log
  })
  const changed = () =>
    connections.frames.filter((frame) => frame.name === 'integration.changed').map((f) => f.data)
  return {
    wired,
    commands: wired.preferences.commands,
    queries: wired.preferences.queries,
    world,
    minted,
    tokens,
    ingress,
    log,
    changed,
    settings: new SqliteIntegrationSettingStore({ db })
  }
}

describe('the Claude Code instant updates toggle, wired (16 §4.12 setClaudeHooks)', () => {
  it('[US-SET-013.AC01, S14.02, ADR-016] turning it on writes the entry with a freshly minted token; the ingress accepts that token only once on-verified', async () => {
    const h = await host()
    await h.world.seed(fixture('foreign-only.settings'))
    // A token in the shape of a real one: refused while the integration is off.
    const early = mintCredential()
    expect(h.ingress.admits(early.value)).toBe(false)

    const result = await h.commands.setClaudeHooks(true, 'settings')

    expect(result).toStrictEqual({ ok: true, value: { state: 'on-verified' } })
    expect(h.queries.integrationState('claude-hooks')).toBe('on-verified')
    expect(h.settings.get('claude-hooks').consentOrigin).toBe('settings')
    expect(h.minted).toHaveLength(1)
    const token = h.minted[0]?.value ?? ''
    expect(await h.world.read()).toContain(token)
    expect(h.tokens.active('claude-hooks')).toStrictEqual({ hash: h.minted[0]?.sha256 })
    expect(h.ingress.admits(token)).toBe(true)
    expect(h.ingress.admits(early.value)).toBe(false)
    expect(h.changed()).toStrictEqual([
      { id: 'claude-hooks', state: 'on-verified', consentOrigin: 'settings' }
    ])
    // NFR-SEC-12: the plaintext token reaches no log record.
    expect(JSON.stringify(h.log.entries)).not.toContain(token)
  })

  it('[US-SET-013.AC04, S14.06, FM-148] turning it off leaves settings.json byte-identical to before the enable and the old token refused; over a locked file the option stays on with config-revert-failed', async () => {
    const h = await host()
    const before = fixture('foreign-only.settings')
    await h.world.seed(before)
    await h.commands.setClaudeHooks(true, 'settings')
    const token = h.minted[0]?.value ?? ''

    h.world.fs.lock(h.world.path)
    expect(await h.commands.setClaudeHooks(false, 'settings')).toStrictEqual({
      ok: false,
      error: 'config-revert-failed'
    })
    expect(h.queries.integrationState('claude-hooks')).toBe('on-verified')
    expect(await h.world.read()).toContain(token)
    expect(h.ingress.admits(token)).toBe(true)

    h.world.fs.lock(h.world.path, false)
    expect(await h.commands.setClaudeHooks(false, 'settings')).toStrictEqual({
      ok: true,
      value: { state: 'off' }
    })
    expect(await h.world.read()).toBe(before)
    expect(h.tokens.active('claude-hooks')).toBeNull()
    expect(h.ingress.admits(token)).toBe(false)
    expect(h.changed()).toStrictEqual([
      { id: 'claude-hooks', state: 'on-verified', consentOrigin: 'settings' },
      { id: 'claude-hooks', state: 'on-verified', consentOrigin: 'settings' },
      { id: 'claude-hooks', state: 'off' }
    ])
  })

  it('[US-SET-013.AC03] after Reset metrics the toggle reads off and the entry is gone', async () => {
    const h = await host()
    const before = fixture('foreign-only.settings')
    await h.world.seed(before)
    await h.commands.setClaudeHooks(true, 'settings')
    const token = h.minted[0]?.value ?? ''

    const reset = await h.commands.resetMetrics({ confirmed: 'yes' })

    expect(reset).toMatchObject({ outcome: 'reset' })
    expect(h.queries.integrationState('claude-hooks')).toBe('off')
    expect(h.queries.integrationSettings()).toContainEqual(
      expect.objectContaining({ id: 'claude-hooks', state: 'off' })
    )
    expect(await h.world.read()).toBe(before)
    expect(h.ingress.admits(token)).toBe(false)
  })

  it('[S14.05, S14.06, S14.07, S14.09, ADR-016] the claude-hooks transitions of machine 14 built in this cut reach their targets: off and on again, a failed verification turned on again with a new token, a locked old-app entry kept with config-revert-failed; add-panel is rejected', async () => {
    const h = await host()
    await h.world.seed(fixture('foreign-and-old-app.settings'))

    // S14.01 → S14.02: the old-app entry is replaced in the same write (16 §7.1).
    expect(await h.commands.setClaudeHooks(true, 'settings')).toMatchObject({ ok: true })
    // S14.05 → S14.06: the toggle turned off.
    expect(await h.commands.setClaudeHooks(false, 'settings')).toStrictEqual({
      ok: true,
      value: { state: 'off' }
    })
    expect(await h.world.read()).toBe(fixture('foreign-and-old-app.reverted.settings'))

    // S14.08 (its trigger is not built yet): the entry vanished and a verification marked the
    // integration on-unverified; S14.09: turning it on again writes it with a new token.
    await h.commands.setClaudeHooks(true, 'settings')
    await h.world.seed(fixture('foreign-and-old-app.reverted.settings'))
    h.settings.save({
      id: 'claude-hooks',
      state: 'on-unverified',
      consentOrigin: 'settings',
      changedAt: T0
    })
    expect(h.ingress.admits(h.minted[1]?.value)).toBe(false)
    expect(await h.commands.setClaudeHooks(true, 'settings')).toStrictEqual({
      ok: true,
      value: { state: 'on-verified' }
    })
    expect(h.minted).toHaveLength(3)
    expect(h.ingress.admits(h.minted[2]?.value)).toBe(true)
    expect(h.ingress.admits(h.minted[1]?.value)).toBe(false)

    // S14.07: a locked file keeps the integration on, with config-revert-failed (16 §7.4).
    h.world.fs.lock(h.world.path)
    expect(await h.commands.setClaudeHooks(false, 'settings')).toStrictEqual({
      ok: false,
      error: 'config-revert-failed'
    })
    expect(h.queries.integrationState('claude-hooks')).toBe('on-verified')
    h.world.fs.lock(h.world.path, false)

    // A locked old-app entry stays where it is: off stays off, with config-revert-failed.
    await h.commands.setClaudeHooks(false, 'settings')
    await h.world.seed(fixture('foreign-and-old-app.settings'))
    h.world.fs.lock(h.world.path)
    expect(await h.commands.setClaudeHooks(false, 'settings')).toStrictEqual({
      ok: false,
      error: 'config-revert-failed'
    })
    expect(await h.world.read()).toBe(fixture('foreign-and-old-app.settings'))
    expect(h.queries.integrationState('claude-hooks')).toBe('off')
    h.world.fs.lock(h.world.path, false)

    // A transition 07 does not list: claude-hooks has no Add-panel entry point (09 CHECK).
    await expect(h.commands.setClaudeHooks(true, 'add-panel')).rejects.toThrow(HostInvariantError)
    expect(h.queries.integrationState('claude-hooks')).toBe('off')
    expect(h.minted).toHaveLength(3)
  })
})
