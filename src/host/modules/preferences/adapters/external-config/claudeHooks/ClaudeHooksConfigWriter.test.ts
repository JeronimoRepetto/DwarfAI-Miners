import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { HostInvariantError } from '../../../../../kernel/domain/errors'
import { FakeFs } from '../../../../../kernel/fakes/FakeFs'
import type { FileSystemSubject } from '../../../../../kernel/testing/fileSystem.contract'
import { NodeFs } from '../../../../../platform/fs/NodeFs'
import { openTemplateCopy } from '../../../../../platform/sqlite/testing/templateDb'
import type { ChannelToken } from '../../../ports/externalConfigWriter'
import { runExternalConfigWriterContract } from '../../../testing/externalConfigWriter.contract'
import { buildHookCommand, INSTALLED_CLAUDE_HOOK_EVENTS, isLegacyHookCommand } from './hookCommand'
import {
  claudeHooksWorld,
  fixture,
  HOOK_TOKEN,
  INGRESS_PORT,
  withHexTokens
} from './testing/claudeHooksWorld'

// L3 (17 §1.3; 16 §7.6): the `claude-hooks` target through the config writer engine, over FakeFs
// and over NodeFs in a per-test `mkdtemp` directory, against the hand-written `settings.json`
// fixtures of `__fixtures__/` (empty, foreign-only, foreign + old-app entry, malformed, and the
// CRLF variants).

function memory(): FileSystemSubject {
  const fs = new FakeFs()
  return {
    fs,
    pathOf: (...segments) => ['/home/j', ...segments].join('/'),
    seed: async (path, content) => fs.addFile(path, content)
  }
}

function disk(): FileSystemSubject {
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-claude-hooks-'))
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

const OUR_COMMAND = buildHookCommand({ port: INGRESS_PORT, token: HOOK_TOKEN, platform: 'linux' })

interface Handler {
  type?: unknown
  command?: unknown
  url?: unknown
  timeout?: unknown
}
type Settings = { hooks?: Record<string, Array<{ matcher?: unknown; hooks: Handler[] }>> } & Record<
  string,
  unknown
>

/** Every hook handler of the file, with the event it sits under. */
function handlers(text: string | null): Array<{ event: string; handler: Handler }> {
  const settings = JSON.parse(text ?? '{}') as Settings
  return Object.entries(settings.hooks ?? {}).flatMap(([event, groups]) =>
    groups.flatMap((group) => group.hooks.map((handler) => ({ event, handler })))
  )
}

const commandsOf = (text: string | null): unknown[] =>
  handlers(text).map(({ handler }) => handler.command)

const ours = (text: string | null) =>
  handlers(text).filter(({ handler }) => handler.command === OUR_COMMAND)

function cases(storage: () => FileSystemSubject): void {
  const world = () => claudeHooksWorld(storage(), openTemplateCopy().db)

  runExternalConfigWriterContract(async () => {
    const w = await world()
    return {
      writer: withHexTokens(w.writer),
      target: 'claude-hooks',
      lock: (locked) => w.fs.lock(w.path, locked),
      plantLegacy: () => w.seed(fixture('foreign-and-old-app.settings'))
    }
  })

  it("[ADR-016, C-20] install over a settings.json with foreign hooks adds only DwarfAI's entry and keeps every foreign byte identical", async () => {
    for (const name of ['foreign-only.settings', 'foreign-only-crlf.settings']) {
      const w = await world()
      const original = fixture(name)
      await w.seed(original)

      const installed = await w.writer.install('claude-hooks', HOOK_TOKEN, 'settings')

      expect(installed.ok && installed.value.verified).toBe(true)
      const written = await w.read()
      // Every original line is still there, byte for byte (an insertion only ever adds text).
      for (const line of original.split(/\r?\n/)) expect(written).toContain(line)
      // Only DwarfAI's entry was added: one handler per hooked event, nothing else changed.
      expect(
        ours(written)
          .map(({ event }) => event)
          .sort()
      ).toStrictEqual([...INSTALLED_CLAUDE_HOOK_EVENTS].sort())
      expect(commandsOf(written).filter((command) => command !== OUR_COMMAND)).toStrictEqual(
        commandsOf(original)
      )
      const outsideHooks = (text: string): Settings => {
        const settings = JSON.parse(text) as Settings
        delete settings.hooks
        return settings
      }
      expect(outsideHooks(written ?? '')).toStrictEqual(outsideHooks(original))
      expect(written?.includes('\r\n')).toBe(original.includes('\r\n'))
      if (original.includes('\r\n')) expect(written).not.toMatch(/[^\r]\n/)
      // One backup, of the file as it was.
      expect((await w.backups()).map((backup) => backup.text)).toStrictEqual([original])
    }
  })

  it('[ADR-016, C-20] install into an empty settings.json writes one command hook per hooked event in the documented hooks shape', async () => {
    const w = await world()
    await w.seed(fixture('empty.settings'))

    await w.writer.install('claude-hooks', HOOK_TOKEN, 'settings')

    expect(await w.read()).toBe(fixture('empty.installed.settings'))
  })

  it('[ADR-016] SessionStart is installed as a command hook, never an http hook', async () => {
    const w = await world()
    await w.writer.install('claude-hooks', HOOK_TOKEN, 'first-run')

    const sessionStart = handlers(await w.read()).filter(({ event }) => event === 'SessionStart')
    expect(sessionStart).toStrictEqual([
      { event: 'SessionStart', handler: { type: 'command', command: OUR_COMMAND, timeout: 5 } }
    ])
    expect(handlers(await w.read()).every(({ handler }) => handler.type === 'command')).toBe(true)
  })

  it("[ADR-016] revert removes only DwarfAI's entry and the file equals the original bytes", async () => {
    for (const name of ['empty.settings', 'foreign-only.settings', 'foreign-only-crlf.settings']) {
      const w = await world()
      const original = fixture(name)
      await w.seed(original)
      await w.writer.install('claude-hooks', HOOK_TOKEN, 'settings')
      // A token rotation rewrites DwarfAI's own entry in place of the old one.
      await w.writer.revert('claude-hooks')
      await w.writer.install('claude-hooks', 'beef'.repeat(16) as ChannelToken, 'settings')

      expect(await w.writer.revert('claude-hooks')).toStrictEqual({ ok: true, value: undefined })

      expect(await w.read()).toBe(original)
    }
    // A settings.json DwarfAI created is left as an empty settings object: whether one was there
    // before is not on record, and a file of the person's is never deleted.
    const created = await world()
    await created.writer.install('claude-hooks', HOOK_TOKEN, 'settings')
    expect(await created.read()).toBe(fixture('empty.installed.settings'))
    await created.writer.revert('claude-hooks')
    expect(await created.read()).toBe('{}\n')
    expect(await created.writer.verify('claude-hooks')).toBe('absent')
  })

  describe('T-46 old-app entries (18 §4.5)', () => {
    it("[ADR-016] findLegacy is true for the old app's hook entry with no active config_writes row, and install replaces it with DwarfAI's own entry after one backup", async () => {
      for (const crlf of ['', '-crlf']) {
        const w = await world()
        const original = fixture(`foreign-and-old-app${crlf}.settings`)
        await w.seed(original)

        expect(await w.writer.findLegacy('claude-hooks')).toBe(true)
        // Never adopted: the old entry is not DwarfAI's verified write.
        expect(await w.writer.verify('claude-hooks')).toBe('absent')

        const installed = await w.writer.install('claude-hooks', HOOK_TOKEN, 'first-run')

        expect(installed.ok).toBe(true)
        const written = await w.read()
        expect(commandsOf(written).some(isLegacyHookCommand)).toBe(false)
        expect(
          ours(written)
            .map(({ event }) => event)
            .sort()
        ).toStrictEqual([...INSTALLED_CLAUDE_HOOK_EVENTS].sort())
        expect(commandsOf(written).filter((command) => command !== OUR_COMMAND)).toStrictEqual(
          commandsOf(original).filter((command) => !isLegacyHookCommand(command))
        )
        expect((await w.backups()).map((backup) => backup.text)).toStrictEqual([original])
        expect(await w.writer.findLegacy('claude-hooks')).toBe(false)
        // Never kept as it was: reverting DwarfAI's entry leaves no old entry behind either.
        await w.writer.revert('claude-hooks')
        expect(await w.read()).toBe(fixture(`foreign-and-old-app.reverted${crlf}.settings`))
      }
    })

    it('[ADR-016] revert of an old-app entry removes it and keeps foreign bytes identical', async () => {
      for (const crlf of ['', '-crlf']) {
        const w = await world()
        const original = fixture(`foreign-and-old-app${crlf}.settings`)
        await w.seed(original)

        expect(await w.writer.revert('claude-hooks')).toStrictEqual({ ok: true, value: undefined })

        expect(await w.read()).toBe(fixture(`foreign-and-old-app.reverted${crlf}.settings`))
        expect((await w.backups()).map((backup) => backup.text)).toStrictEqual([original])
        expect(await w.writer.findLegacy('claude-hooks')).toBe(false)
      }
    })
  })

  it('[FM-127] a malformed settings.json is never written', async () => {
    for (const malformed of [
      fixture('malformed.settings'),
      '',
      '[]\n',
      '{"hooks": {}} trailing\n',
      '{"hooks": {}, "hooks": {"Stop": []}}\n'
    ]) {
      const w = await world()
      await w.seed(malformed)

      expect(await w.writer.install('claude-hooks', HOOK_TOKEN, 'settings')).toStrictEqual({
        ok: false,
        error: 'io'
      })
      expect(await w.writer.revert('claude-hooks')).toStrictEqual({ ok: false, error: 'io' })

      expect(await w.read()).toBe(malformed)
      expect(w.fs.writes).toStrictEqual([])
      expect(await w.backups()).toStrictEqual([])
      expect(w.setting().state).toBe('off')
    }
  })

  it('[ADR-016] a hooks value DwarfAI cannot merge into holds the slot: install returns foreign-entry-conflict and writes nothing', async () => {
    for (const foreign of ['{"hooks": "elsewhere"}\n', '{"hooks": {"Stop": {"matcher": ""}}}\n']) {
      const w = await world()
      await w.seed(foreign)

      expect(await w.writer.install('claude-hooks', HOOK_TOKEN, 'settings')).toStrictEqual({
        ok: false,
        error: 'foreign-entry-conflict'
      })
      expect(await w.read()).toBe(foreign)
      expect(w.fs.writes).toStrictEqual([])
    }
  })

  it('[ADR-016, C-21] a hook token that is not lower-case hex is refused before rendering and nothing is written', async () => {
    const w = await world()
    const original = fixture('foreign-only.settings')
    await w.seed(original)

    const refused = w.writer.install('claude-hooks', 'tok-1' as ChannelToken, 'settings')

    await expect(refused).rejects.toThrow(HostInvariantError)
    // The refusal never echoes the value it refused.
    await expect(refused).rejects.not.toThrow(/tok-1/)

    expect(await w.read()).toBe(original)
    expect(w.fs.writes).toStrictEqual([])
    expect(await w.backups()).toStrictEqual([])
  })

  it('[NFR-SEC-12] the hook token never appears in a log record', async () => {
    const w = await world()
    await w.seed(fixture('foreign-and-old-app.settings'))

    await w.writer.install('claude-hooks', HOOK_TOKEN, 'first-run')
    await w.writer.install('claude-hooks', HOOK_TOKEN, 'settings')
    await w.writer.revert('claude-hooks')

    expect(w.log.entries.length).toBeGreaterThan(0)
    const logged = JSON.stringify(w.log.entries)
    expect(logged).not.toContain(HOOK_TOKEN)
    expect(logged).not.toContain('0123456789abcdef0123456789abcdef')
    expect(w.log.refused).toStrictEqual([])
  })
}

describe('ClaudeHooksConfigWriter over FakeFs', () => {
  cases(memory)
})

describe('ClaudeHooksConfigWriter over NodeFs', () => {
  cases(disk)
})
