// layer: L2
// L2 flow (17 §1.2): 07 S14.10 across the Host's boot step 6 (16 §8.2; ADR-016 item 3; #1289). The
// parts are composed as host/main.ts composes them: the config writer engine with the Claude Code
// hooks target over a FakeFs (the entry rendered with the port persisted in `app_meta`,
// bridges/hostConfigWriter.ts `persistedIngressPort`), behind the Host's config writer
// (`hostConfigWriter`, and the cut-2 rollback choices of wiring/cut2Rollback.ts for a rollback
// build); the transport's own port choice (transport/ingress/ingressPort.ts) over a scripted bind
// in which the persisted port is taken; and boot step 6 (wiring/hookIngress.ts
// `startHookIngressAtBoot`) with the Host's entry follower (`claudeHookEntryFollower`). The
// database is a copy of the migrated template; the real 127.0.0.1 listener is the L8 suite's
// (hookIngress.os.test.ts).
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeFs } from '../../kernel/fakes/FakeFs'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type { ChannelToken } from '../../modules/preferences'
import { buildHookCommand } from '../../modules/preferences/adapters/external-config/claudeHooks/hookCommand'
import { isLegacyHookCommand } from '../../modules/preferences/adapters/external-config/claudeHooks/hookCommand'
import { fixture } from '../../modules/preferences/adapters/external-config/claudeHooks/testing/claudeHooksWorld'
import { ClaudeHooksConfigWriter } from '../../modules/preferences/adapters/external-config/claudeHooks/ClaudeHooksConfigWriter'
import { ConfigWriterEngine } from '../../modules/preferences/adapters/external-config/configWriterEngine'
import { SqliteChannelTokenStore } from '../../modules/preferences/adapters/sqlite/SqliteChannelTokenStore'
import { SqliteConfigWriteLedger } from '../../modules/preferences/adapters/sqlite/SqliteConfigWriteLedger'
import { SqliteIntegrationSettingStore } from '../../modules/preferences/adapters/sqlite/SqliteIntegrationSettingStore'
import { drawToken, hashOf } from '../../modules/preferences/testing/inMemoryChannelTokens'
import { SqliteTransactionRunner } from '../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../platform/sqlite/testing/templateDb'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import { openIngressPort, type ListenOutcome } from '../../transport/ingress/ingressPort'
import {
  claudeHookEntryFollower,
  hostConfigWriter,
  persistedIngressPort
} from '../bridges/hostConfigWriter'
import { appMetaIngressPort } from '../bridges/ingressPort'
import { cut2RollbackChoices } from '../cut2Rollback'
import { startHookIngressAtBoot } from '../hookIngress'

const SETTINGS = '/home/person/.claude/settings.json'
/** The port the first boot persisted, which another program holds at the next boot. */
const PERSISTED = 45_123
/** The port the OS hands the ingress instead. */
const NEW_PORT = 45_124

/** The Host's config-writer parts over one database and one FakeFs, as one build composes them. */
function host(db: SqliteDatabase, fs: FakeFs, rolledBack: boolean) {
  const log = new RecordingDiagnosticsLog()
  const ids = new SequenceIdGenerator()
  const clock = new FakeClock(1_760_000_000_000)
  const ingressPort = appMetaIngressPort(db)
  const choices = cut2RollbackChoices(rolledBack)
  const engine = new ConfigWriterEngine({
    fs,
    transactions: new SqliteTransactionRunner(db),
    ledger: new SqliteConfigWriteLedger({ db }),
    settings: new SqliteIntegrationSettingStore({ db }),
    tokens: new SqliteChannelTokenStore({ db, ids }),
    clock,
    ids,
    scheduler: new FakeScheduler(clock),
    log,
    targets: [
      new ClaudeHooksConfigWriter({
        path: SETTINGS,
        platform: 'linux',
        ingressPort: persistedIngressPort(ingressPort),
        keepOldAppEntries: choices.keepsOldAppEntries
      })
    ]
  })
  const minted: string[] = []
  return {
    log,
    minted,
    ingressPort,
    writer: choices.externalConfig(
      hostConfigWriter({ claudeHooks: engine, ingressPort, log }),
      log
    ),
    /** Boot step 6: the ingress binds (the persisted port taken by `holder`), then the entry follows. */
    bootStep6: (taken: number | null) =>
      startHookIngressAtBoot(
        {
          start: () =>
            openIngressPort({
              record: ingressPort,
              log,
              onPortChanged: () => undefined,
              listen: (port): Promise<ListenOutcome> =>
                Promise.resolve(port === taken ? 'taken' : { bound: port === 0 ? NEW_PORT : port })
            })
        },
        log,
        claudeHookEntryFollower({
          engine,
          rolledBack: choices.rolledBack,
          mintCredential: () => {
            const value = drawToken()
            minted.push(value)
            return { value, sha256: hashOf(value) }
          }
        })
      ),
    tokens: new SqliteChannelTokenStore({ db, ids }),
    setting: () => new SqliteIntegrationSettingStore({ db }).get('claude-hooks')
  }
}

const decoder = new TextDecoder()
async function read(fs: FakeFs): Promise<string | null> {
  const bytes = await fs.readFile(SETTINGS)
  return bytes.ok ? decoder.decode(bytes.value) : null
}

function commandsOf(text: string | null): string[] {
  const settings = JSON.parse(text ?? '{}') as {
    hooks?: Record<string, Array<{ hooks: Array<{ command?: string }> }>>
  }
  return Object.values(settings.hooks ?? {}).flatMap((groups) =>
    groups.flatMap((group) => group.hooks.flatMap((handler) => handler.command ?? []))
  )
}

const ourCommand = (port: number, token: string): string =>
  buildHookCommand({ port, token, platform: 'linux' })

/** A first cut-2 boot persisted its port; the person turned "Claude Code · instant updates" on. */
async function enabledAtFirstBoot(seed: string) {
  const db = openTemplateCopy().db
  const fs = new FakeFs()
  fs.addFile(SETTINGS, seed)
  const first = host(db, fs, false)
  await first.bootStep6(null)
  expect(first.ingressPort.read()).toBe(NEW_PORT)
  // The port the entry is written with: the first boot's, persisted (moved back for the scenario).
  first.ingressPort.write(PERSISTED)
  const token = drawToken() as ChannelToken
  expect(
    await first.writer.install('claude-hooks', token, 'settings', hashOf(token))
  ).toMatchObject({
    ok: true
  })
  expect(commandsOf(await read(fs))).toContain(ourCommand(PERSISTED, token))
  return { db, fs, token }
}

describe('the Host follows a new ingress port with its own Claude hook entry (07 S14.10)', () => {
  it('[S14.10, ADR-016] the persisted ingress port is taken at boot: step 6 binds a new port and the entry now names it, with a fresh active token', async () => {
    const { db, fs, token } = await enabledAtFirstBoot(fixture('foreign-only.settings'))
    const next = host(db, fs, false)

    await next.bootStep6(PERSISTED)

    expect(next.ingressPort.read()).toBe(NEW_PORT)
    const [fresh] = next.minted
    expect(fresh).toBeTypeOf('string')
    const commands = commandsOf(await read(fs))
    expect(commands).toContain(ourCommand(NEW_PORT, fresh ?? ''))
    expect(commands).not.toContain(ourCommand(PERSISTED, token))
    expect(next.tokens.active('claude-hooks')).toStrictEqual({ hash: hashOf(fresh ?? '') })
    expect(next.setting()).toMatchObject({ state: 'on-verified', consentOrigin: 'settings' })
    // Logged: the port change by the ingress, the rewrite by the writer, never the token.
    expect(next.log.byEvent('ingress.port')).toContainEqual(
      expect.objectContaining({ outcome: 'degraded', causeClass: 'port-taken' })
    )
    expect(next.log.byEvent('config.write')).toContainEqual(
      expect.objectContaining({
        outcome: 'ok',
        subsystem: 'claude-hooks',
        msg: 'settings',
        causeClass: 'ingress-port-changed'
      })
    )
    expect(JSON.stringify(next.log.entries)).not.toContain(fresh)
  })

  it('[S14.10] a boot whose persisted port is free writes nothing', async () => {
    const { db, fs } = await enabledAtFirstBoot(fixture('foreign-only.settings'))
    const before = await read(fs)
    const next = host(db, fs, false)

    await next.bootStep6(null)

    expect(next.ingressPort.read()).toBe(PERSISTED)
    expect(await read(fs)).toBe(before)
    expect(next.minted).toStrictEqual([])
  })

  it('[S14.10, ADR-016] with the integration off, a new ingress port writes nothing', async () => {
    const db = openTemplateCopy().db
    const fs = new FakeFs()
    const original = fixture('foreign-only.settings')
    fs.addFile(SETTINGS, original)
    host(db, fs, false).ingressPort.write(PERSISTED)
    const next = host(db, fs, false)

    await next.bootStep6(PERSISTED)

    expect(next.ingressPort.read()).toBe(NEW_PORT)
    expect(await read(fs)).toBe(original)
    expect(next.tokens.active('claude-hooks')).toBeNull()
  })

  it("[S14.10, ADR-016] an old-app entry is never written: with no entry of the Host's own it stays byte for byte", async () => {
    const db = openTemplateCopy().db
    const fs = new FakeFs()
    const original = fixture('foreign-and-old-app.settings')
    fs.addFile(SETTINGS, original)
    host(db, fs, false).ingressPort.write(PERSISTED)
    const next = host(db, fs, false)

    await next.bootStep6(PERSISTED)

    expect(await read(fs)).toBe(original)
    expect(commandsOf(original).some(isLegacyHookCommand)).toBe(true)
  })

  it('[S14.10, ADR-016] a cut-2 rollback build never rewrites the entry, whatever port it binds', async () => {
    const { db, fs } = await enabledAtFirstBoot(fixture('foreign-only.settings'))
    const before = await read(fs)
    const rollback = host(db, fs, true)

    await rollback.bootStep6(PERSISTED)

    expect(rollback.ingressPort.read()).toBe(NEW_PORT)
    expect(await read(fs)).toBe(before)
    expect(rollback.minted).toStrictEqual([])
  })
})
