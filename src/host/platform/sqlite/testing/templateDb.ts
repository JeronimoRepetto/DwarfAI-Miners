// A test's own copy of the run's template database (17 §1.5 "Speed"; 09 §6.5 "Template DB";
// 17 §5.3 "per-test temp copies, no shared paths"). The template is migrated once per `vitest`
// run by `templateDb.globalSetup.ts`; each call here copies it into a new `mkdtemp` directory,
// which is removed when the calling test finishes (its `onTestFinished` hook, the per-test form
// of `afterEach`). Call it inside a test or a `beforeEach`. Never imported by production code
// (R14).
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inject, onTestFinished } from 'vitest'
import type { SqliteDatabase } from '../../../kernel/ports/sqliteDatabase'
import { NodeSqliteDatabase, type NodeSqliteOptions } from '../NodeSqliteDatabase'

export interface TemplateCopy {
  /** The copy's database file, alone in its temp directory. */
  path: string
  /** The Host's writer on the copy (09 §8.1 policy), closed when the test finishes. */
  db: SqliteDatabase
}

function templatePath(): string {
  const path = inject('templateDbPath')
  if (typeof path !== 'string' || path === '') {
    throw new Error(
      'no template database in this run: register src/host/platform/sqlite/testing/templateDb.globalSetup.ts as a globalSetup of the vitest config'
    )
  }
  return path
}

function copyInto(dir: string): string {
  const path = join(dir, 'dwarfai.db')
  copyFileSync(templatePath(), path)
  return path
}

/** Copy the template into a new temp directory removed when the test finishes; returns the copy. */
export function copyTemplateDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dwarfai-db-'))
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  return copyInto(dir)
}

/** Copy the template and open the Host's writer on it; both are cleaned up when the test ends. */
export function openTemplateCopy(options: NodeSqliteOptions = {}): TemplateCopy {
  const dir = mkdtempSync(join(tmpdir(), 'dwarfai-db-'))
  let db: NodeSqliteDatabase | null = null
  // One hook, so the connection is closed before its directory is removed (Windows keeps an open
  // file from being deleted).
  onTestFinished(() => {
    db?.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const path = copyInto(dir)
  db = NodeSqliteDatabase.open(path, options)
  return { path, db }
}
