// The template database (17 §1.5 "Speed"; 09 §6.5 "Template DB"; HO-24): once per `vitest` run,
// before any test file, an empty temp file is migrated to head by the Host's own runner and its
// path is provided to the workers as `templateDbPath`. Tests copy it (`templateDb.ts`) instead of
// migrating. Rebuilt on every run, so it is never stale; removed when the run ends. Registered in
// `vitest.config.ts`. Never imported by production code (R14).
//
// The template is migrated at a fixed instant with sequential ids (17 §5.3 determinism), and its
// WAL is checkpointed into the main file before it is closed, so a copy of the one file is the
// whole database.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestProject } from 'vitest/node'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { RecordingDiagnosticsLog } from '../../../kernel/fakes/RecordingDiagnosticsLog'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import { migrationsFor } from '../migrations/index'
import { openHostDb } from '../migrations/runner'
import { FIXTURE_EPOCH } from './fixtureDump'

declare module 'vitest' {
  export interface ProvidedContext {
    /** The migrated template database of this run (`templateDb.globalSetup.ts`). */
    templateDbPath: string
  }
}

/** Migrate an empty file in a new temp directory; returns the file's path and the directory. */
export function buildTemplateDb(): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dwarfai-template-'))
  const path = join(dir, 'template.db')
  const clock = new FakeClock(FIXTURE_EPOCH)
  const log = new RecordingDiagnosticsLog()
  const opened = openHostDb(path, {
    buildKind: 'test',
    releaseDataDir: join(dir, 'release-data'),
    appVersion: 'template-db',
    clock,
    log,
    migrations: migrationsFor({ clock, ids: new SequenceIdGenerator() })
  })
  if (!opened.ok) {
    rmSync(dir, { recursive: true, force: true })
    throw new Error(`the runner refused the template's empty file: ${opened.error}`)
  }
  try {
    opened.value.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } finally {
    opened.value.db.close()
  }
  return { path, dir }
}

export default function setup(project: TestProject): () => void {
  const { path, dir } = buildTemplateDb()
  project.provide('templateDbPath', path)
  return () => {
    rmSync(dir, { recursive: true, force: true })
  }
}
