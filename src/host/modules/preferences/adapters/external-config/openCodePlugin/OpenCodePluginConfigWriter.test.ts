// L3 (17 §1.3; 16 §7.6): the `opencode-plugin` target through the config writer engine, over FakeFs
// and over NodeFs in a per-test `mkdtemp` directory, against the hand-written plugin-folder
// fixtures of `__fixtures__/` (a person's own plugin, a file under DwarfAI's name DwarfAI did not
// create, another installation's file, the old app's plugin file, and DwarfAI's own file); the
// empty plugin folder is the world's starting state.
//
// TC-227-01 (only DwarfAI's headed file is added and removed), TC-227-02 (a non-owned file with
// DwarfAI's name: foreign-entry-conflict), TC-227-03 (the old app's file: found, then replaced or
// removed, never kept as consented), TC-227-04 (the token only inside the file).
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
import { hashOf } from '../../../testing/inMemoryChannelTokens'
import { withHexTokens } from '../claudeHooks/testing/claudeHooksWorld'
import { OPENCODE_PLUGIN_FILE_NAME } from './OpenCodePluginConfigWriter'
import {
  fixture,
  FOREIGN_PLUGIN_NAME,
  INGRESS_PORT,
  INSTALL_ID,
  openCodePluginWorld,
  PLUGIN_TOKEN
} from './testing/openCodePluginWorld'

function memory(): FileSystemSubject {
  const fs = new FakeFs()
  return {
    fs,
    pathOf: (...segments) => ['/home/j', ...segments].join('/'),
    seed: async (path, content) => fs.addFile(path, content)
  }
}

function disk(): FileSystemSubject {
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-opencode-plugin-'))
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

const crlf = (text: string): string => text.replace(/\n/g, '\r\n')

function cases(storage: () => FileSystemSubject): void {
  const world = (options?: { ingressPort?: () => number }) =>
    openCodePluginWorld(storage(), openTemplateCopy().db, options)

  runExternalConfigWriterContract(async () => {
    const w = await world()
    return {
      writer: withHexTokens(w.writer),
      target: 'opencode-plugin',
      lock: (locked) => w.fs.lock(w.path, locked),
      plantLegacy: () => w.seed(fixture('old-app.plugin'))
    }
  })

  it("[ADR-016, C-20] install writes DwarfAI's headed plugin file, leaves every other plugin byte-identical and records the consent origin", async () => {
    for (const origin of ['settings', 'add-panel', 'first-run'] as const) {
      const w = await world()
      const foreign = fixture('foreign-plugin.plugin')
      await w.seed(foreign, FOREIGN_PLUGIN_NAME)

      const installed = await w.writer.install(
        'opencode-plugin',
        PLUGIN_TOKEN,
        origin,
        hashOf(PLUGIN_TOKEN)
      )

      expect(installed).toStrictEqual({ ok: true, value: { verified: true, backupPath: null } })
      expect(await w.folder()).toStrictEqual({
        [FOREIGN_PLUGIN_NAME]: foreign,
        [OPENCODE_PLUGIN_FILE_NAME]: fixture('dwarfai-owned.plugin')
      })
      expect(w.rows()).toMatchObject([
        {
          kind: 'opencode-plugin',
          owned_marker: `// dwarfai-managed ${INSTALL_ID}`,
          consent_origin: origin,
          reverted_at: null
        }
      ])
      expect(w.setting()).toMatchObject({ state: 'on-verified', consentOrigin: origin })
    }
  })

  it("[ADR-016] a file with DwarfAI's name that DwarfAI did not create is never overwritten: foreign-entry-conflict", async () => {
    for (const name of ['foreign-same-name.plugin', 'other-install.plugin']) {
      for (const text of [fixture(name), crlf(fixture(name))]) {
        const w = await world()
        await w.seed(text)

        expect(
          await w.writer.install('opencode-plugin', PLUGIN_TOKEN, 'settings', hashOf(PLUGIN_TOKEN))
        ).toStrictEqual({ ok: false, error: 'foreign-entry-conflict' })
        // Not DwarfAI's: neither verified, nor taken for the old app's, nor removed on revert.
        expect(await w.writer.verify('opencode-plugin')).toBe('mismatch')
        expect(await w.writer.findLegacy('opencode-plugin')).toBe(false)
        expect(await w.writer.revert('opencode-plugin')).toStrictEqual({
          ok: true,
          value: undefined
        })

        expect(await w.read()).toBe(text)
        expect(w.fs.writes).toStrictEqual([])
        expect(await w.backups()).toStrictEqual([])
        expect(w.rows()).toStrictEqual([])
        expect(w.setting().state).toBe('off')
      }
    }
    // An empty file under DwarfAI's name is not DwarfAI's either.
    const empty = await world()
    await empty.seed('')
    expect(
      await empty.writer.install('opencode-plugin', PLUGIN_TOKEN, 'settings', hashOf(PLUGIN_TOKEN))
    ).toStrictEqual({ ok: false, error: 'foreign-entry-conflict' })
    expect(await empty.read()).toBe('')
  })

  it("[ADR-016] revert removes only DwarfAI's own file", async () => {
    const w = await world()
    const foreign = fixture('foreign-plugin.plugin')
    await w.seed(foreign, FOREIGN_PLUGIN_NAME)
    const before = await w.folder()
    await w.writer.install('opencode-plugin', PLUGIN_TOKEN, 'settings', hashOf(PLUGIN_TOKEN))
    // A token rotation rewrites DwarfAI's own file in place of the old one, after its backup.
    await w.writer.revert('opencode-plugin')
    const rotated = 'beef'.repeat(16) as ChannelToken
    await w.writer.install('opencode-plugin', rotated, 'settings', hashOf(rotated))
    expect(await w.read()).toContain(`const PUSH_TOKEN = '${rotated}'`)

    expect(await w.writer.revert('opencode-plugin')).toStrictEqual({ ok: true, value: undefined })

    expect(await w.read()).toBeNull()
    expect(await w.folder()).toStrictEqual(before)
    expect(w.rows()).toMatchObject([
      { reverted_at: expect.any(Number) },
      { reverted_at: expect.any(Number) }
    ])
    expect(w.setting().state).toBe('off')
    expect(await w.writer.verify('opencode-plugin')).toBe('absent')
  })

  describe('T-46 old-app entries (18 §4.5)', () => {
    it("[ADR-016] findLegacy is true for the old app's plugin file with no active config_writes row; install replaces it after a backup; revert removes it", async () => {
      for (const original of [fixture('old-app.plugin'), crlf(fixture('old-app.plugin'))]) {
        const w = await world()
        await w.seed(original)

        expect(await w.writer.findLegacy('opencode-plugin')).toBe(true)
        // Never adopted: the old file is not DwarfAI's verified write, and the boot leaves it alone.
        expect(await w.writer.verify('opencode-plugin')).toBe('absent')
        await w.writer.settleUnverified()
        expect(await w.read()).toBe(original)

        const installed = await w.writer.install(
          'opencode-plugin',
          PLUGIN_TOKEN,
          'first-run',
          hashOf(PLUGIN_TOKEN)
        )

        expect(installed.ok && installed.value.verified).toBe(true)
        expect(await w.read()).toBe(fixture('dwarfai-owned.plugin'))
        expect(await w.backups()).toStrictEqual([original])
        expect(await w.writer.findLegacy('opencode-plugin')).toBe(false)
        // Never kept as it was: reverting DwarfAI's file leaves no old file behind either.
        expect(await w.writer.revert('opencode-plugin')).toStrictEqual({
          ok: true,
          value: undefined
        })
        expect(await w.read()).toBeNull()

        // Declined on the first-run step: the old file is backed up, then removed.
        const declined = await world()
        await declined.seed(original)
        await declined.seed(fixture('foreign-plugin.plugin'), FOREIGN_PLUGIN_NAME)
        expect(await declined.writer.revert('opencode-plugin')).toStrictEqual({
          ok: true,
          value: undefined
        })
        expect(await declined.read()).toBeNull()
        expect(await declined.backups()).toStrictEqual([original])
        expect((await declined.folder())[FOREIGN_PLUGIN_NAME]).toBe(
          fixture('foreign-plugin.plugin')
        )
        expect(declined.rows()).toStrictEqual([])
        expect(await declined.writer.findLegacy('opencode-plugin')).toBe(false)
      }
    })

    it("[ADR-016] a file headed like the old app's that no longer has its shape is foreign: never replaced or removed", async () => {
      const w = await world()
      const edited = fixture('old-app.plugin').replace(/^const PUSH_TOKEN = .*$/m, '')
      await w.seed(edited)

      expect(await w.writer.findLegacy('opencode-plugin')).toBe(false)
      expect(
        await w.writer.install('opencode-plugin', PLUGIN_TOKEN, 'first-run', hashOf(PLUGIN_TOKEN))
      ).toStrictEqual({ ok: false, error: 'foreign-entry-conflict' })
      expect(await w.writer.revert('opencode-plugin')).toStrictEqual({ ok: true, value: undefined })
      expect(await w.read()).toBe(edited)
    })
  })

  it('[ADR-011] install resolves verified only after the file was read back equal', async () => {
    // Reads of DwarfAI's file during an enable: 1 the parse, 2 the re-read, 3 the read-back.
    const w = await world()
    let readBack: string | null = null
    w.fs.toolEditsBeforeRead(w.path, [3], (text) => {
      readBack = text
      return text
    })
    const installed = await w.writer.install(
      'opencode-plugin',
      PLUGIN_TOKEN,
      'add-panel',
      hashOf(PLUGIN_TOKEN)
    )
    expect(readBack).toBe(fixture('dwarfai-owned.plugin'))
    expect(installed.ok && installed.value.verified).toBe(true)
    expect(w.setting().state).toBe('on-verified')

    // OpenCode (or anything) changes the file between the write and the read-back: not verified.
    const dropped = await world()
    dropped.fs.toolEditsBeforeRead(dropped.path, [3], (text) =>
      text.replace(/PUSH_TOKEN = '/, "PUSH_TOKEN = 'x")
    )
    expect(
      await dropped.writer.install(
        'opencode-plugin',
        PLUGIN_TOKEN,
        'add-panel',
        hashOf(PLUGIN_TOKEN)
      )
    ).toStrictEqual({ ok: false, error: 'io' })
    expect(dropped.rows()).toStrictEqual([])
    expect(dropped.setting().state).toBe('off')
  })

  it("[S14.11, ADR-016] DwarfAI's own file holding a token that is no longer the active one is a mismatch, never verified", async () => {
    const w = await world()
    await w.writer.install('opencode-plugin', PLUGIN_TOKEN, 'settings', hashOf(PLUGIN_TOKEN))
    await w.seed(fixture('dwarfai-owned.plugin').replace(PLUGIN_TOKEN, 'cafe'.repeat(16)))

    expect(await w.writer.verify('opencode-plugin')).toBe('mismatch')
  })

  it("[S14.10, ADR-016] an ingress port change rewrites DwarfAI's own file onto the new port", async () => {
    let port = INGRESS_PORT
    const w = await world({ ingressPort: () => port })
    await w.writer.install('opencode-plugin', PLUGIN_TOKEN, 'settings', hashOf(PLUGIN_TOKEN))
    const fresh = 'beef'.repeat(16) as ChannelToken
    const credential = () => ({ token: fresh, tokenSha256: hashOf(fresh) })

    expect(await w.writer.followIngressPort('opencode-plugin', credential)).toBe('current')

    port = 45999
    expect(await w.writer.followIngressPort('opencode-plugin', credential)).toBe('rewritten')
    expect(await w.read()).toBe(
      fixture('dwarfai-owned.plugin')
        .replace(`127.0.0.1:${INGRESS_PORT}/`, '127.0.0.1:45999/')
        .replace(PLUGIN_TOKEN, fresh)
    )
    expect(await w.writer.verify('opencode-plugin')).toBe('verified')
  })

  it('[ADR-016, C-21] a plugin token that is not lower-case hex is refused before rendering and nothing is written', async () => {
    for (const bad of ['tok-1', "f00d'+x+'", 'F00D'.repeat(16)]) {
      const w = await world()

      const refused = w.writer.install(
        'opencode-plugin',
        bad as ChannelToken,
        'settings',
        hashOf(bad as ChannelToken)
      )

      await expect(refused).rejects.toThrow(HostInvariantError)
      // The refusal never echoes the value it refused.
      await expect(refused).rejects.not.toThrow(bad)
      expect(await w.read()).toBeNull()
      expect(w.fs.writes).toStrictEqual([])
    }
  })

  it('[NFR-SEC-12] the plugin token never appears in a log record', async () => {
    const w = await world()
    await w.seed(fixture('old-app.plugin'))

    await w.writer.install('opencode-plugin', PLUGIN_TOKEN, 'first-run', hashOf(PLUGIN_TOKEN))
    await w.writer.install('opencode-plugin', PLUGIN_TOKEN, 'settings', hashOf(PLUGIN_TOKEN))
    await w.writer.revert('opencode-plugin')
    // A refused install logs too: each enable issues its own token (owner amendment M).
    const next = 'beef'.repeat(16) as ChannelToken
    await w.seed(fixture('foreign-same-name.plugin'))
    await w.writer.install('opencode-plugin', next, 'settings', hashOf(next))

    expect(w.log.entries.length).toBeGreaterThan(0)
    const logged = JSON.stringify(w.log.entries)
    expect(logged).not.toContain(PLUGIN_TOKEN)
    expect(logged).not.toContain(next)
    // Nor the old app's token, nor any byte of a plugin file.
    expect(logged).not.toContain('01d0aaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(logged).not.toContain('PUSH_')
    expect(w.log.refused).toStrictEqual([])
  })
}

describe('OpenCodePluginConfigWriter over FakeFs', () => {
  cases(memory)
})

describe('OpenCodePluginConfigWriter over NodeFs', () => {
  cases(disk)
})
