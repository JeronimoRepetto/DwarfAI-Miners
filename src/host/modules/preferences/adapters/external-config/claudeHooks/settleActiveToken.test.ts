// layer: L3
// 07 S14.11 (16 §7.3; ADR-016 items 1, 6): the boot settlement of a write a crash (or a locked file)
// left between Tx A and Tx B re-verifies the `config_writes` row, and a row is verified only when
// DwarfAI's own entry carries the ACTIVE channel token. Tx A already made the new token's hash the
// active one, so an entry still holding the previous token is answered `401` by the hook ingress: it
// is a `mismatch`, and the row is reverted to `off` (16 §7.3: `'absent'` / `'mismatch'` → revert →
// `off`), never marked verified (issue #1307). Both rewrites that can leave the file behind are
// covered: a re-enable (S14.09) and a rewrite onto a new ingress port (S14.10). Over FakeFs and a
// copy of the template database, with the real `claude-hooks` target and its fixtures.
import { describe, expect, it } from 'vitest'
import type { Instant } from '../../../../../kernel/domain/values'
import { FakeFs } from '../../../../../kernel/fakes/FakeFs'
import { SequenceIdGenerator } from '../../../../../kernel/fakes/SequenceIdGenerator'
import type { FileSystemSubject } from '../../../../../kernel/testing/fileSystem.contract'
import { openTemplateCopy } from '../../../../../platform/sqlite/testing/templateDb'
import type { ChannelToken } from '../../../ports/externalConfigWriter'
import { hashOf } from '../../../testing/inMemoryChannelTokens'
import { SimulatedCrash } from '../../../testing/ScriptedToolFs'
import { SqliteChannelTokenStore } from '../../sqlite/SqliteChannelTokenStore'
import { SqliteIntegrationSettingStore } from '../../sqlite/SqliteIntegrationSettingStore'
import { buildHookCommand } from './hookCommand'
import { claudeHooksWorld, fixture, HOOK_TOKEN, INGRESS_PORT } from './testing/claudeHooksWorld'

const NEW_PORT = INGRESS_PORT + 1
const FRESH_TOKEN = 'beef'.repeat(16) as ChannelToken
const fresh = () => ({ token: FRESH_TOKEN, tokenSha256: hashOf(FRESH_TOKEN) })

function memory(): FileSystemSubject {
  const fs = new FakeFs()
  return {
    fs,
    pathOf: (...segments) => ['/home/j', ...segments].join('/'),
    seed: async (path, content) => fs.addFile(path, content)
  }
}

/** The `claude-hooks` world with DwarfAI's entry installed and verified under HOOK_TOKEN. */
async function installedWorld() {
  const { db } = openTemplateCopy()
  const port = { now: INGRESS_PORT }
  const w = await claudeHooksWorld(memory(), db, 'linux', { ingressPort: () => port.now })
  const tokens = new SqliteChannelTokenStore({ db, ids: new SequenceIdGenerator() })
  const settings = new SqliteIntegrationSettingStore({ db })
  const original = fixture('foreign-only.settings')
  await w.seed(original)
  await w.writer.install('claude-hooks', HOOK_TOKEN, 'settings', hashOf(HOOK_TOKEN))
  const rows = () =>
    db
      .all(`SELECT verified_at, reverted_at FROM config_writes ORDER BY written_at, id`)
      .map((row) => ({ ...row }))
  return { ...w, db, port, tokens, settings, original, rows }
}

/** S14.08 then S14.09: the entry failed a later check, and the person turns the integration on again. */
function turnedOnAgain(w: Awaited<ReturnType<typeof installedWorld>>): void {
  w.settings.save({
    id: 'claude-hooks',
    state: 'on-unverified',
    consentOrigin: 'settings',
    changedAt: 1_760_000_000_001 as Instant
  })
}

const commandOf = (port: number, token: string): string =>
  buildHookCommand({ port, token, platform: 'linux' })

describe('ConfigWriterEngine.settleUnverified verifies the active token (07 S14.11, issue #1307)', () => {
  it('[S14.11, S14.09, ADR-016] a re-enable that crashed before its write is not marked verified: the entry still holds the previous token, so the row is reverted and the integration is off', async () => {
    const w = await installedWorld()
    turnedOnAgain(w)
    w.fs.crashAt(w.path, 'before-write')
    await expect(
      w.writer.install('claude-hooks', FRESH_TOKEN, 'settings', hashOf(FRESH_TOKEN))
    ).rejects.toThrow(SimulatedCrash)
    // Tx A committed: the fresh token is active, the file still carries the previous one.
    expect(w.tokens.active('claude-hooks')).toStrictEqual({ hash: hashOf(FRESH_TOKEN) })
    expect(await w.read()).toContain(commandOf(INGRESS_PORT, HOOK_TOKEN))
    expect(await w.writer.verify('claude-hooks')).toBe('mismatch')

    await w.writer.settleUnverified()

    expect(w.setting().state).toBe('off')
    expect(w.rows()).toMatchObject([{ verified_at: null }])
    expect(w.rows()[0]?.reverted_at).not.toBeNull()
    // The stale entry is gone, every foreign byte as it was.
    expect(await w.read()).toBe(w.original)
    // The token never reaches the log (NFR-SEC-12).
    expect(JSON.stringify(w.log.entries)).not.toContain(HOOK_TOKEN)
    expect(JSON.stringify(w.log.entries)).not.toContain(FRESH_TOKEN)
  })

  it('[S14.11, S14.09, ADR-016] a re-enable left for boot by a locked file is not marked verified either', async () => {
    const w = await installedWorld()
    turnedOnAgain(w)
    w.fs.lock(w.path)
    expect(
      await w.writer.install('claude-hooks', FRESH_TOKEN, 'settings', hashOf(FRESH_TOKEN))
    ).toStrictEqual({ ok: false, error: 'io' })
    expect(w.rows()).toMatchObject([{ verified_at: null, reverted_at: null }])
    w.fs.lock(w.path, false)

    await w.writer.settleUnverified()

    expect(w.setting().state).toBe('off')
    expect(w.rows()).toMatchObject([{ verified_at: null }])
    expect(await w.read()).toBe(w.original)
  })

  it('[S14.11, S14.10, ADR-016] a port rewrite that crashed before its write is not marked verified: the row is reverted and the integration is off', async () => {
    const w = await installedWorld()
    w.port.now = NEW_PORT
    w.fs.crashAt(w.path, 'before-write')
    await expect(w.writer.followIngressPort('claude-hooks', fresh)).rejects.toThrow(SimulatedCrash)
    expect(w.tokens.active('claude-hooks')).toStrictEqual({ hash: hashOf(FRESH_TOKEN) })

    await w.writer.settleUnverified()

    expect(w.setting().state).toBe('off')
    expect(w.rows()).toMatchObject([{ verified_at: null }])
    expect(await w.read()).toBe(w.original)
  })

  it('[S14.11, S14.09] a re-enable whose write landed before the crash carries the active token and is verified', async () => {
    const w = await installedWorld()
    turnedOnAgain(w)
    w.fs.crashAt(w.path, 'after-write')
    await expect(
      w.writer.install('claude-hooks', FRESH_TOKEN, 'settings', hashOf(FRESH_TOKEN))
    ).rejects.toThrow(SimulatedCrash)

    await w.writer.settleUnverified()

    expect(w.setting()).toMatchObject({ state: 'on-verified', consentOrigin: 'settings' })
    expect(w.rows()).toMatchObject([{ reverted_at: null }])
    expect(w.rows()[0]?.verified_at).not.toBeNull()
    expect(await w.read()).toContain(commandOf(INGRESS_PORT, FRESH_TOKEN))
    expect(await w.writer.verify('claude-hooks')).toBe('verified')
  })
})
