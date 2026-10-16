import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import type { FileSystemSubject } from '../../../../kernel/testing/fileSystem.contract'
import { NodeFs } from '../../../../platform/fs/NodeFs'
import {
  engineWorld,
  runConfigWriterEngineContract,
  runExternalConfigWriterContract
} from '../../testing/externalConfigWriter.contract'
import type { ChannelToken } from '../../ports/externalConfigWriter'
import { hashOf } from '../../testing/inMemoryChannelTokens'
import { syntheticConfigTarget, syntheticLegacyEntry } from '../../testing/syntheticConfigTarget'
import { SqliteChannelTokenStore } from '../sqlite/SqliteChannelTokenStore'
import { SqliteConfigWriteLedger } from '../sqlite/SqliteConfigWriteLedger'
import { SqliteIntegrationSettingStore } from '../sqlite/SqliteIntegrationSettingStore'
import { SequenceIdGenerator } from '../../../../kernel/fakes/SequenceIdGenerator'
import { SqliteTransactionRunner } from '../../../../platform/sqlite/SqliteTransactionRunner'
import { ConfigWriterEngine } from './configWriterEngine'

// L3 (17 §1.3): the same suites as over FakeFs, on NodeFs over a per-test `mkdtemp` directory
// (17 §5.3), so the temp-and-rename write, the backups and the byte comparisons hold on a disk.
function disk(): FileSystemSubject {
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-config-writer-'))
  onTestFinished(() => rmSync(root, { recursive: true, force: true }))
  return {
    fs: new NodeFs(),
    pathOf: (...segments) => join(root, ...segments),
    seed: async (path, content) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
    }
  }
}

describe('ConfigWriterEngine over NodeFs', () => {
  runConfigWriterEngineContract(disk)

  runExternalConfigWriterContract(async () => {
    const w = await engineWorld(disk())
    return {
      writer: w.writer,
      target: 'opencode-plugin',
      lock: (locked) => w.fs.lock(w.path, locked),
      plantLegacy: () => w.seed(`x=1\n${syntheticLegacyEntry('old-token')}\n`)
    }
  })
})

// ADDED for ISSUE-227 (foreman decision, 2026-10-16): the engine makes a target's missing parent folder.
describe('ConfigWriterEngine over NodeFs and a missing target folder', () => {
  it('[ADR-016, FM-124] install makes the missing parent folders of the target on disk and writes the entry', async () => {
    const storage = disk()
    const w = await engineWorld(storage)
    const path = storage.pathOf('.config', 'opencode', 'plugin', 'config.ini')
    const engine = new ConfigWriterEngine({
      fs: w.fs,
      transactions: new SqliteTransactionRunner(w.db),
      ledger: new SqliteConfigWriteLedger({ db: w.db }),
      settings: new SqliteIntegrationSettingStore({ db: w.db }),
      tokens: new SqliteChannelTokenStore({ db: w.db, ids: new SequenceIdGenerator() }),
      clock: w.clock,
      ids: new SequenceIdGenerator(),
      scheduler: { after: (_ms, task) => (queueMicrotask(task), { cancel: () => undefined }) },
      log: w.log,
      targets: [syntheticConfigTarget('opencode-plugin', path)]
    })
    const TOKEN = 'tok-1' as ChannelToken

    const installed = await engine.install('opencode-plugin', TOKEN, 'settings', hashOf(TOKEN))

    expect(installed).toStrictEqual({ ok: true, value: { verified: true, backupPath: null } })
    expect(await w.read(path)).toContain(TOKEN)
  })
})
