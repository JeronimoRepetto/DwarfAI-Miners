// layer: L3
// 07 S14.10 (ADR-016 item 3; 16 §7.4 last bullet): when the hook ingress had to leave its persisted
// port, the config writer engine rewrites DwarfAI's own Claude Code hook entry onto the new port
// through the same write path as an enable (Tx A, ownership probe, one backup, atomic write,
// read-back, Tx B), with a fresh channel token. Only an `on-verified` integration with its own entry
// in place is followed; an old-app entry is never written; the rewrite stays revertible. Over FakeFs
// and a copy of the template database, with the real `claude-hooks` target and its fixtures.
import { describe, expect, it } from 'vitest'
import { FakeFs } from '../../../../../kernel/fakes/FakeFs'
import type { Instant } from '../../../../../kernel/domain/values'
import type { FileSystemSubject } from '../../../../../kernel/testing/fileSystem.contract'
import { openTemplateCopy } from '../../../../../platform/sqlite/testing/templateDb'
import type { ChannelToken } from '../../../ports/externalConfigWriter'
import { hashOf } from '../../../testing/inMemoryChannelTokens'
import { SqliteChannelTokenStore } from '../../sqlite/SqliteChannelTokenStore'
import { SqliteIntegrationSettingStore } from '../../sqlite/SqliteIntegrationSettingStore'
import { SequenceIdGenerator } from '../../../../../kernel/fakes/SequenceIdGenerator'
import { buildHookCommand, INSTALLED_CLAUDE_HOOK_EVENTS, isLegacyHookCommand } from './hookCommand'
import { claudeHooksWorld, fixture, HOOK_TOKEN, INGRESS_PORT } from './testing/claudeHooksWorld'

const NEW_PORT = INGRESS_PORT + 1
const FRESH_TOKEN = 'beef'.repeat(16) as ChannelToken
const fresh = () => ({ token: FRESH_TOKEN, tokenSha256: hashOf(FRESH_TOKEN) })

interface Handler {
  type?: unknown
  command?: unknown
}
type Settings = { hooks?: Record<string, Array<{ matcher?: unknown; hooks: Handler[] }>> } & Record<
  string,
  unknown
>

function memory(): FileSystemSubject {
  const fs = new FakeFs()
  return {
    fs,
    pathOf: (...segments) => ['/home/j', ...segments].join('/'),
    seed: async (path, content) => fs.addFile(path, content)
  }
}

function handlers(text: string | null): Array<{ event: string; handler: Handler }> {
  const settings = JSON.parse(text ?? '{}') as Settings
  return Object.entries(settings.hooks ?? {}).flatMap(([event, groups]) =>
    groups.flatMap((group) => group.hooks.map((handler) => ({ event, handler })))
  )
}

const commandsOf = (text: string | null): unknown[] =>
  handlers(text).map(({ handler }) => handler.command)

const commandFor = (port: number, token: string): string =>
  buildHookCommand({ port, token, platform: 'linux' })

/** The `claude-hooks` world whose persisted ingress port the test moves. */
async function portWorld() {
  const db = openTemplateCopy().db
  const port = { now: INGRESS_PORT }
  const w = await claudeHooksWorld(memory(), db, 'linux', { ingressPort: () => port.now })
  const tokens = new SqliteChannelTokenStore({ db, ids: new SequenceIdGenerator() })
  const settings = new SqliteIntegrationSettingStore({ db })
  return { ...w, port, tokens, settings }
}

describe('ConfigWriterEngine.followIngressPort with the claude-hooks target (07 S14.10)', () => {
  it('[S14.10, ADR-016] an on-verified entry written with the persisted port is rewritten onto the new ingress port with a fresh token, after one backup, foreign bytes identical, and still reverts to the original bytes', async () => {
    const w = await portWorld()
    const original = fixture('foreign-only.settings')
    await w.seed(original)
    await w.writer.install('claude-hooks', HOOK_TOKEN, 'settings', hashOf(HOOK_TOKEN))
    const installed = await w.read()
    w.port.now = NEW_PORT

    expect(await w.writer.followIngressPort('claude-hooks', fresh)).toBe('rewritten')

    const written = await w.read()
    const ours = handlers(written).filter(({ handler }) => {
      const command = handler.command
      return typeof command === 'string' && !commandsOf(original).includes(command)
    })
    expect(ours.map(({ event }) => event).sort()).toStrictEqual(
      [...INSTALLED_CLAUDE_HOOK_EVENTS].sort()
    )
    expect(ours.every(({ handler }) => handler.command === commandFor(NEW_PORT, FRESH_TOKEN))).toBe(
      true
    )
    for (const line of original.split(/\r?\n/)) expect(written).toContain(line)
    // One more backup: the file as it was just before the rewrite.
    expect((await w.backups()).map((backup) => backup.text)).toStrictEqual([original, installed])
    // The fresh token is the active one; the integration stays on with its consent.
    expect(w.tokens.active('claude-hooks')).toStrictEqual({ hash: hashOf(FRESH_TOKEN) })
    expect(w.setting()).toMatchObject({ state: 'on-verified', consentOrigin: 'settings' })
    expect(await w.writer.verify('claude-hooks')).toBe('verified')
    // Revertible: a turn-off gives the original bytes back.
    expect(await w.writer.revert('claude-hooks')).toStrictEqual({ ok: true, value: undefined })
    expect(await w.read()).toBe(original)
  })

  it('[S14.10] an entry that already names the bound port is not written again', async () => {
    const w = await portWorld()
    await w.seed(fixture('foreign-only.settings'))
    await w.writer.install('claude-hooks', HOOK_TOKEN, 'settings', hashOf(HOOK_TOKEN))
    const installed = await w.read()

    expect(await w.writer.followIngressPort('claude-hooks', fresh)).toBe('current')

    expect(await w.read()).toBe(installed)
    expect(await w.backups()).toHaveLength(1)
    expect(w.tokens.active('claude-hooks')).toStrictEqual({ hash: hashOf(HOOK_TOKEN) })
  })

  it('[S14.10, ADR-016] with the integration off nothing is written, not even over an old-app entry', async () => {
    const w = await portWorld()
    const original = fixture('foreign-and-old-app.settings')
    await w.seed(original)
    w.port.now = NEW_PORT

    expect(await w.writer.followIngressPort('claude-hooks', fresh)).toBe('not-on')

    expect(await w.read()).toBe(original)
    expect(await w.backups()).toStrictEqual([])
    expect(w.tokens.active('claude-hooks')).toBeNull()
    expect(w.setting().state).toBe('off')
  })

  it('[S14.10, S14.08] an on-unverified integration is not followed: only turning it on again writes (S14.09)', async () => {
    const w = await portWorld()
    await w.seed(fixture('foreign-only.settings'))
    await w.writer.install('claude-hooks', HOOK_TOKEN, 'settings', hashOf(HOOK_TOKEN))
    w.settings.save({
      id: 'claude-hooks',
      state: 'on-unverified',
      consentOrigin: 'settings',
      changedAt: 1_760_000_000_001 as Instant
    })
    const installed = await w.read()
    w.port.now = NEW_PORT

    expect(await w.writer.followIngressPort('claude-hooks', fresh)).toBe('not-on')

    expect(await w.read()).toBe(installed)
    expect(w.tokens.active('claude-hooks')).toStrictEqual({ hash: hashOf(HOOK_TOKEN) })
  })

  it("[S14.10, ADR-016] the rewrite replaces DwarfAI's own entry only: an old-app entry beside it stays as it was", async () => {
    const w = await portWorld()
    await w.seed(fixture('foreign-only.settings'))
    await w.writer.install('claude-hooks', HOOK_TOKEN, 'settings', hashOf(HOOK_TOKEN))
    // The old app, run again by the person, put its entry back beside DwarfAI's own.
    const legacy = commandsOf(fixture('foreign-and-old-app.settings')).find(isLegacyHookCommand)
    expect(legacy).toBeTypeOf('string')
    const settings = JSON.parse((await w.read()) ?? '{}') as Settings
    settings.hooks?.['Stop']?.push({ matcher: '', hooks: [{ type: 'command', command: legacy }] })
    await w.seed(`${JSON.stringify(settings, null, 2)}\n`)
    w.port.now = NEW_PORT

    expect(await w.writer.followIngressPort('claude-hooks', fresh)).toBe('rewritten')

    const written = await w.read()
    expect(commandsOf(written).filter(isLegacyHookCommand)).toStrictEqual([legacy])
    expect(commandsOf(written)).toContain(commandFor(NEW_PORT, FRESH_TOKEN))
    expect(commandsOf(written)).not.toContain(commandFor(INGRESS_PORT, HOOK_TOKEN))
  })

  it('[S14.10, ADR-016] a rewrite the disk refuses changes nothing: the entry, the token and the integration stay as they were', async () => {
    const w = await portWorld()
    await w.seed(fixture('foreign-only.settings'))
    await w.writer.install('claude-hooks', HOOK_TOKEN, 'settings', hashOf(HOOK_TOKEN))
    const installed = await w.read()
    w.port.now = NEW_PORT
    w.fs.failWrites(w.path, 'no-space', 1)

    expect(await w.writer.followIngressPort('claude-hooks', fresh)).toBe('failed')

    expect(await w.read()).toBe(installed)
    expect(w.tokens.active('claude-hooks')).toStrictEqual({ hash: hashOf(HOOK_TOKEN) })
    expect(w.setting()).toMatchObject({ state: 'on-verified', consentOrigin: 'settings' })
    expect(w.log.byEvent('config.write').at(-1)).toMatchObject({
      level: 'warn',
      outcome: 'failed',
      subsystem: 'claude-hooks',
      msg: 'settings'
    })
  })
})
