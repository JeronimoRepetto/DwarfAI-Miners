import { describe, expect, it } from 'vitest'
import { FakeFs } from '../../../../kernel/fakes/FakeFs'
import type { FileSystemSubject } from '../../../../kernel/testing/fileSystem.contract'
import {
  engineWorld,
  runConfigWriterEngineContract,
  runExternalConfigWriterContract
} from '../../testing/externalConfigWriter.contract'
import type { ChannelToken } from '../../ports/externalConfigWriter'
import { syntheticLegacyEntry } from '../../testing/syntheticConfigTarget'
import { SqliteIntegrationSettingStore } from '../sqlite/SqliteIntegrationSettingStore'

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
      await w.writer.install('opencode-plugin', 'tok-1' as ChannelToken, 'settings')
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
      await w.writer.install('opencode-plugin', 'tok-2' as ChannelToken, 'settings')
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
    await w.writer.install('opencode-plugin', 'tok-1' as ChannelToken, 'settings')

    await w.writer.install('opencode-plugin', 'tok-2' as ChannelToken, 'settings')

    expect(await w.read()).toContain('tok-1')
    expect(await w.read()).not.toContain('tok-2')
  })
})
