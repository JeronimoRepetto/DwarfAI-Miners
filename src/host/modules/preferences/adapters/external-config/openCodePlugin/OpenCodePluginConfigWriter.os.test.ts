// L8 OS lane (17 §1.8; ADR-016 items 6–7): the `opencode-plugin` target writes DwarfAI's plugin file
// into a real temp OpenCode config folder on the running OS's disk through the kernel `NodeFs` — the
// temp-and-rename write, the backup beside the file, the delete on revert and the byte comparisons
// on Windows, macOS and Linux. Runs only in `pnpm test:os`. The OS lane has no template database,
// so this file migrates its own.
//
// TC-227-01 (install then revert add and remove only DwarfAI's headed file), TC-227-03 (the old
// app's file replaced after its backup).
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import type { FileSystemSubject } from '../../../../../kernel/testing/fileSystem.contract'
import { NodeFs } from '../../../../../platform/fs/NodeFs'
import { NodeSqliteDatabase } from '../../../../../platform/sqlite/NodeSqliteDatabase'
import { buildTemplateDb } from '../../../../../platform/sqlite/testing/templateDb.globalSetup'
import { hashOf } from '../../../testing/inMemoryChannelTokens'
import { OPENCODE_PLUGIN_FILE_NAME } from './OpenCodePluginConfigWriter'
import {
  fixture,
  FOREIGN_PLUGIN_NAME,
  openCodePluginWorld,
  PLUGIN_TOKEN
} from './testing/openCodePluginWorld'

let template: { path: string; dir: string }

beforeAll(() => {
  template = buildTemplateDb()
})

afterAll(() => {
  rmSync(template.dir, { recursive: true, force: true })
})

function disk(): { storage: FileSystemSubject; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-opencode-plugin-os-'))
  onTestFinished(() => rmSync(root, { recursive: true, force: true }))
  const storage: FileSystemSubject = {
    fs: new NodeFs(),
    pathOf: (...segments) => join(root, ...segments),
    seed: async (path, content) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
    }
  }
  return { storage, root }
}

function database(root: string): NodeSqliteDatabase {
  const path = join(root, 'dwarfai.db')
  writeFileSync(path, readFileSync(template.path))
  const db = NodeSqliteDatabase.open(path)
  onTestFinished(() => db.close())
  return db
}

describe('OpenCodePluginConfigWriter on this OS', () => {
  it('[ADR-016] on each OS the plugin file round-trips install and revert in a temp config folder', async () => {
    for (const legacy of [false, true]) {
      const { storage, root } = disk()
      const w = await openCodePluginWorld(storage, database(root))
      const foreign = Buffer.from(fixture('foreign-plugin.plugin'), 'utf8')
      writeFileSync(join(w.dir, FOREIGN_PLUGIN_NAME), foreign)
      if (legacy) await w.seed(fixture('old-app.plugin'))
      const before = readdirSync(w.dir).sort()

      const installed = await w.writer.install(
        'opencode-plugin',
        PLUGIN_TOKEN,
        'settings',
        hashOf(PLUGIN_TOKEN)
      )

      expect(installed.ok && installed.value.verified).toBe(true)
      expect(await w.writer.verify('opencode-plugin')).toBe('verified')
      expect(readFileSync(w.path, 'utf8')).toBe(fixture('dwarfai-owned.plugin'))
      const backupPath = installed.ok ? installed.value.backupPath : null
      if (legacy) {
        expect(dirname(backupPath ?? '')).toBe(w.dir)
        expect(readFileSync(backupPath ?? '', 'utf8')).toBe(fixture('old-app.plugin'))
      } else {
        expect(backupPath).toBeNull()
      }

      expect(await w.writer.revert('opencode-plugin')).toStrictEqual({ ok: true, value: undefined })

      // Only DwarfAI's file went: the person's plugin is byte-identical, no temp file is left,
      // and the one backup (of the old app's file) stays beside it.
      expect(readFileSync(join(w.dir, FOREIGN_PLUGIN_NAME)).equals(foreign)).toBe(true)
      const expected = before.filter((name) => name !== OPENCODE_PLUGIN_FILE_NAME)
      if (backupPath !== null) expected.push(backupPath.slice(w.dir.length + 1))
      expect(readdirSync(w.dir).sort()).toStrictEqual(expected.sort())
    }
  })
})
