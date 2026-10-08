// L8 OS lane (17 §1.8; ADR-016 items 6–7): the `claude-hooks` target writes a real temp
// `settings.json` on the running OS's disk through the kernel `NodeFs` — the temp-and-rename write,
// the backup beside the file and the byte comparisons on Windows, macOS and Linux. Runs only in
// `pnpm test:os`. The OS lane has no template database, so this file migrates its own.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import type { FileSystemSubject } from '../../../../../kernel/testing/fileSystem.contract'
import { NodeFs } from '../../../../../platform/fs/NodeFs'
import { NodeSqliteDatabase } from '../../../../../platform/sqlite/NodeSqliteDatabase'
import { buildTemplateDb } from '../../../../../platform/sqlite/testing/templateDb.globalSetup'
import { claudeHooksWorld, fixture, HOOK_TOKEN } from './testing/claudeHooksWorld'

let template: { path: string; dir: string }

beforeAll(() => {
  template = buildTemplateDb()
})

afterAll(() => {
  rmSync(template.dir, { recursive: true, force: true })
})

function disk(): { storage: FileSystemSubject; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-claude-hooks-os-'))
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

describe('ClaudeHooksConfigWriter on this OS', () => {
  it('[ADR-016] on each OS a temp settings.json round-trips install and revert byte-identical, with the backup beside it', async () => {
    for (const name of ['foreign-and-old-app.reverted.settings', 'foreign-only-crlf.settings']) {
      const { storage, root } = disk()
      const w = await claudeHooksWorld(storage, database(root))
      const original = readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url))
      expect(original.toString('utf8')).toBe(fixture(name))
      await w.seed(original.toString('utf8'))

      const installed = await w.writer.install('claude-hooks', HOOK_TOKEN, 'settings')

      expect(installed.ok && installed.value.verified).toBe(true)
      expect(await w.writer.verify('claude-hooks')).toBe('verified')
      const backupPath = installed.ok ? installed.value.backupPath : null
      expect(backupPath).not.toBeNull()
      expect(dirname(backupPath ?? '')).toBe(dirname(w.path))
      expect(readFileSync(backupPath ?? '').equals(original)).toBe(true)

      expect(await w.writer.revert('claude-hooks')).toStrictEqual({ ok: true, value: undefined })

      expect(readFileSync(w.path).equals(original)).toBe(true)
      // Nothing else is left beside it: no temp file, only the one backup.
      expect(readdirSync(dirname(w.path)).sort()).toStrictEqual(
        ['CLAUDE.md', 'settings.json', backupPath?.slice(dirname(w.path).length + 1)].sort()
      )
    }
  })
})
