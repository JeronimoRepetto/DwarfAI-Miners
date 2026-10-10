import { describe, expect, it } from 'vitest'
import { FakeFs } from '../../../../kernel/fakes/FakeFs'
import type { FileSystemSubject } from '../../../../kernel/testing/fileSystem.contract'
import {
  engineWorld,
  runConfigWriterEngineContract,
  runExternalConfigWriterContract
} from '../../testing/externalConfigWriter.contract'
import type { ChannelToken } from '../../ports/externalConfigWriter'
import { SimulatedCrash } from '../../testing/ScriptedToolFs'
import { syntheticConfigTarget, syntheticLegacyEntry } from '../../testing/syntheticConfigTarget'
import { SqliteChannelTokenStore } from '../sqlite/SqliteChannelTokenStore'
import { SqliteConfigWriteLedger } from '../sqlite/SqliteConfigWriteLedger'
import { SequenceIdGenerator } from '../../../../kernel/fakes/SequenceIdGenerator'
import { SqliteTransactionRunner } from '../../../../platform/sqlite/SqliteTransactionRunner'
import { ConfigWriterEngine } from './configWriterEngine'
import { SqliteIntegrationSettingStore } from '../sqlite/SqliteIntegrationSettingStore'
import { hashOf } from '../../testing/inMemoryChannelTokens'

// L3 (17 §1.3): the config writer engine with the synthetic target over FakeFs and a copy of the
// template database; `configWriterEngine.disk.test.ts` runs the same suites over NodeFs.
function memory(): FileSystemSubject {
  const fs = new FakeFs()
  return {
    fs,
    pathOf: (...segments) => ['/home/j', ...segments].join('/'),
    seed: async (path, content) => fs.addFile(path, content)
  }
}

describe('ConfigWriterEngine over FakeFs', () => {
  runConfigWriterEngineContract(memory)

  runExternalConfigWriterContract(async () => {
    const w = await engineWorld(memory())
    return {
      writer: w.writer,
      target: 'opencode-plugin',
      lock: (locked) => w.fs.lock(w.path, locked),
      plantLegacy: () => w.seed(`x=1\n${syntheticLegacyEntry('old-token')}\n`)
    }
  })
})

// AMENDED for ISSUE-221 (appended, review F2): the engine's idempotent no-op (16 §7.5) agrees with the caller's,
// which mints a new token unless the integration is `on-verified`: an `on-unverified` integration whose entry still
// verifies (07 S14.08 → S14.09) is written again, so the file holds the token whose hash the caller issued.
describe('ConfigWriterEngine no-op guard (16 §7.5)', () => {
  it('[S14.08, S14.09] an on-unverified integration whose entry still verifies is written again with the new token and returns to on-verified', async () => {
    const w = await engineWorld(memory())
    const settings = new SqliteIntegrationSettingStore({ db: w.db })
    expect(
      await w.writer.install(
        'opencode-plugin',
        'tok-1' as ChannelToken,
        'settings',
        hashOf('tok-1' as ChannelToken)
      )
    ).toMatchObject({
      ok: true
    })
    settings.save({
      id: 'opencode-permissions',
      state: 'on-unverified',
      consentOrigin: 'settings',
      changedAt: 1
    })
    expect(await w.writer.verify('opencode-plugin')).toBe('verified')

    expect(
      await w.writer.install(
        'opencode-plugin',
        'tok-2' as ChannelToken,
        'settings',
        hashOf('tok-2' as ChannelToken)
      )
    ).toMatchObject({
      ok: true
    })

    const text = await w.read()
    expect(text).toContain('tok-2')
    expect(text).not.toContain('tok-1')
    expect(settings.get('opencode-permissions')).toMatchObject({ state: 'on-verified' })
  })

  it('[ADR-016] enabling an on-verified integration whose entry verifies stays a no-op', async () => {
    const w = await engineWorld(memory())
    await w.writer.install(
      'opencode-plugin',
      'tok-1' as ChannelToken,
      'settings',
      hashOf('tok-1' as ChannelToken)
    )

    await w.writer.install(
      'opencode-plugin',
      'tok-2' as ChannelToken,
      'settings',
      hashOf('tok-2' as ChannelToken)
    )

    expect(await w.read()).toContain('tok-1')
    expect(await w.read()).not.toContain('tok-2')
  })
})

// Owner amendment M (2026-10-09): the token hash of a write is issued in the engine's Tx A, with the
// `config_writes` row, and withdrawn in Tx B (failure), so the previous token is active again (16 §7.3).
describe('ConfigWriterEngine and the channel token (owner amendment M)', () => {
  const TOKEN = 'tok-1' as ChannelToken
  const TOKEN_2 = 'tok-2' as ChannelToken
  const tokenRows = (db: Awaited<ReturnType<typeof engineWorld>>['db']) =>
    db
      .all(`SELECT token_sha256, revoked_at FROM channel_tokens ORDER BY created_at, id`)
      .map((row) => ({ hash: row['token_sha256'], revoked: row['revoked_at'] !== null }))

  it('[FM-148, S14.04, ADR-016] a failed write withdraws its hash: the previous token is active again and no row of the failed one is left', async () => {
    const w = await engineWorld(memory())
    const tokens = new SqliteChannelTokenStore({ db: w.db, ids: new SequenceIdGenerator() })
    const settings = new SqliteIntegrationSettingStore({ db: w.db })
    await w.writer.install('opencode-plugin', TOKEN, 'settings', hashOf(TOKEN))
    // The slot now holds someone else's entry and the integration was marked on-unverified.
    await w.seed('dwarfai.hook=written-by-someone-else\nx=1\n')
    settings.save({
      id: 'opencode-permissions',
      state: 'on-unverified',
      consentOrigin: 'settings',
      changedAt: 1
    })

    const failed = await w.writer.install('opencode-plugin', TOKEN_2, 'settings', hashOf(TOKEN_2))

    expect(failed).toStrictEqual({ ok: false, error: 'foreign-entry-conflict' })
    expect(tokens.active('opencode-plugin')).toStrictEqual({ hash: hashOf(TOKEN) })
    expect(tokenRows(w.db)).toStrictEqual([{ hash: hashOf(TOKEN), revoked: false }])

    // A first enable that fails leaves no token at all.
    const fresh = await engineWorld(memory())
    await fresh.seed('dwarfai.hook=written-by-someone-else\n')
    await fresh.writer.install('opencode-plugin', TOKEN, 'settings', hashOf(TOKEN))
    expect(tokenRows(fresh.db)).toStrictEqual([])
  })

  it('[S14.11, FM-020, ADR-016] a crash after Tx A, settled at boot, leaves the file and the active hash on the same token', async () => {
    const w = await engineWorld(memory())
    const tokens = new SqliteChannelTokenStore({ db: w.db, ids: new SequenceIdGenerator() })
    await w.writer.install('opencode-plugin', TOKEN, 'settings', hashOf(TOKEN))
    new SqliteIntegrationSettingStore({ db: w.db }).save({
      id: 'opencode-permissions',
      state: 'on-unverified',
      consentOrigin: 'settings',
      changedAt: 1
    })
    w.fs.crashAt(w.path, 'after-write')
    await expect(
      w.writer.install('opencode-plugin', TOKEN_2, 'settings', hashOf(TOKEN_2))
    ).rejects.toThrow(SimulatedCrash)
    // Tx A committed both: the new hash is active with the unverified row.
    expect(tokens.active('opencode-plugin')).toStrictEqual({ hash: hashOf(TOKEN_2) })

    w.clock.advance(60_000)
    await w.boot().settleUnverified()

    expect(await w.read()).toContain(TOKEN_2)
    expect(await w.read()).not.toContain(TOKEN)
    expect(tokens.active('opencode-plugin')).toStrictEqual({ hash: hashOf(TOKEN_2) })
    expect(w.setting()).toMatchObject({ state: 'on-verified' })
  })

  it('[ADR-016] the hash is issued inside Tx A: when the Tx A write fails, no token is issued and the previous one stays', async () => {
    const w = await engineWorld(memory())
    const tokens = new SqliteChannelTokenStore({ db: w.db, ids: new SequenceIdGenerator() })
    /** The `config_writes` insert of Tx A fails once asked to. */
    class RefusingLedger extends SqliteConfigWriteLedger {
      refuse = false
      override record(row: Parameters<SqliteConfigWriteLedger['record']>[0]): void {
        if (this.refuse) throw new Error('the config_writes insert failed')
        super.record(row)
      }
    }
    const ledger = new RefusingLedger({ db: w.db })
    const engine = new ConfigWriterEngine({
      fs: w.fs,
      transactions: new SqliteTransactionRunner(w.db),
      ledger,
      settings: new SqliteIntegrationSettingStore({ db: w.db }),
      tokens,
      clock: w.clock,
      ids: new SequenceIdGenerator(),
      scheduler: { after: (_ms, task) => (queueMicrotask(task), { cancel: () => undefined }) },
      log: w.log,
      targets: [syntheticConfigTarget('opencode-plugin', w.path)]
    })
    await engine.install('opencode-plugin', TOKEN, 'settings', hashOf(TOKEN))
    new SqliteIntegrationSettingStore({ db: w.db }).save({
      id: 'opencode-permissions',
      state: 'on-unverified',
      consentOrigin: 'settings',
      changedAt: 1
    })
    ledger.refuse = true

    await expect(
      engine.install('opencode-plugin', TOKEN_2, 'settings', hashOf(TOKEN_2))
    ).rejects.toThrow('the config_writes insert failed')

    expect(tokens.active('opencode-plugin')).toStrictEqual({ hash: hashOf(TOKEN) })
    expect(tokenRows(w.db)).toStrictEqual([{ hash: hashOf(TOKEN), revoked: false }])
  })
})
