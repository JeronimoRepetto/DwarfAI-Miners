// The config writer engine with the real `opencode-plugin` target (ISSUE-227) over a FileSystem the
// caller supplies (FakeFs, or NodeFs over a per-test `mkdtemp` directory) and a migrated database,
// plus the hand-written plugin-folder fixtures of `../__fixtures__/`. Never imported by production
// code (R14).
//
// The fixtures are kept as `.plugin` files so the repository's TypeScript, lint and format passes
// never take them for source; the world seeds them into the plugin folder under their real names.
import { readFileSync } from 'node:fs'
import { FakeClock } from '../../../../../../kernel/fakes/FakeClock'
import { RecordingDiagnosticsLog } from '../../../../../../kernel/fakes/RecordingDiagnosticsLog'
import { SequenceIdGenerator } from '../../../../../../kernel/fakes/SequenceIdGenerator'
import type { Scheduler } from '../../../../../../kernel/ports/scheduler'
import type { SqliteDatabase } from '../../../../../../kernel/ports/sqliteDatabase'
import type { FileSystemSubject } from '../../../../../../kernel/testing/fileSystem.contract'
import { SqliteTransactionRunner } from '../../../../../../platform/sqlite/SqliteTransactionRunner'
import type { ChannelToken } from '../../../../ports/externalConfigWriter'
import { ScriptedToolFs } from '../../../../testing/ScriptedToolFs'
import { SqliteChannelTokenStore } from '../../../sqlite/SqliteChannelTokenStore'
import { SqliteConfigWriteLedger } from '../../../sqlite/SqliteConfigWriteLedger'
import { SqliteIntegrationSettingStore } from '../../../sqlite/SqliteIntegrationSettingStore'
import { ConfigWriterEngine } from '../../configWriterEngine'
import {
  OPENCODE_PLUGIN_FILE_NAME,
  OpenCodePluginConfigWriter
} from '../OpenCodePluginConfigWriter'

/** An `openCodePluginToken` as ChannelTokenStore issues it: 32 bytes, lower-case hex (ADR-016 item 1). */
export const PLUGIN_TOKEN = 'f00d'.repeat(16) as ChannelToken
/** The persisted ingress port the owned fixture was written with. */
export const INGRESS_PORT = 45123
/** `app_meta.install_id` of this installation (10 §app_meta): a UUIDv7. */
export const INSTALL_ID = '0192f3a4-5b6c-7d8e-9f01-23456789abcd'
/** A person's own plugin beside DwarfAI's, under its own name. */
export const FOREIGN_PLUGIN_NAME = 'notify-on-idle.ts'

const FIXTURES = new URL('../__fixtures__/', import.meta.url)

/** A hand-written plugin-folder fixture, as its exact text. */
export function fixture(name: string): string {
  return readFileSync(new URL(name, FIXTURES), 'utf8')
}

/** Scheduled retries run at once: no real timer in an L3 test (17 §2.2). */
const immediateScheduler: Scheduler = {
  after(_ms, task) {
    queueMicrotask(task)
    return { cancel: () => undefined }
  }
}

const decoder = new TextDecoder()

export async function openCodePluginWorld(
  storage: FileSystemSubject,
  db: SqliteDatabase,
  options: { ingressPort?: () => number } = {}
) {
  const fs = new ScriptedToolFs(storage.fs)
  // OpenCode's global plugin folder exists (OpenCode is installed); DwarfAI's file may not.
  const at = (name: string): string => storage.pathOf('.config', 'opencode', 'plugin', name)
  const dir = storage.pathOf('.config', 'opencode', 'plugin')
  const made = await storage.fs.makeDir(dir)
  if (!made.ok) throw new Error(`the plugin folder could not be made: ${made.error}`)
  const path = at(OPENCODE_PLUGIN_FILE_NAME)
  const log = new RecordingDiagnosticsLog()
  const settings = new SqliteIntegrationSettingStore({ db })
  const ids = new SequenceIdGenerator()
  const writer = new ConfigWriterEngine({
    fs,
    transactions: new SqliteTransactionRunner(db),
    ledger: new SqliteConfigWriteLedger({ db }),
    settings,
    tokens: new SqliteChannelTokenStore({ db, ids }),
    clock: new FakeClock(1_760_000_000_000),
    ids,
    scheduler: immediateScheduler,
    log,
    targets: [
      new OpenCodePluginConfigWriter({
        path,
        installId: INSTALL_ID,
        ingressPort: options.ingressPort ?? (() => INGRESS_PORT)
      })
    ]
  })
  const read = async (file = path): Promise<string | null> => {
    const bytes = await storage.fs.readFile(file)
    return bytes.ok ? decoder.decode(bytes.value) : null
  }
  /** Every file of the plugin folder, by name, with its text. */
  const folder = async (): Promise<Record<string, string | null>> => {
    const listed = await storage.fs.listDirWithSizes(dir)
    if (!listed.ok) return {}
    const names = listed.value.map((entry) => entry.name).sort()
    const texts = await Promise.all(names.map((name) => read(at(name))))
    return Object.fromEntries(names.map((name, index) => [name, texts[index] ?? null]))
  }
  return {
    writer,
    fs,
    log,
    db,
    dir,
    path,
    /** Puts `text` into the plugin folder: DwarfAI's file by default, or the named one. */
    seed: (text: string, name = OPENCODE_PLUGIN_FILE_NAME) => storage.seed(at(name), text),
    read,
    folder,
    /** The backups beside DwarfAI's file, oldest name first, with their text. */
    backups: async (): Promise<string[]> => {
      const files = await folder()
      return Object.keys(files)
        .filter((name) => name.startsWith(`${OPENCODE_PLUGIN_FILE_NAME}.dwarfai-bak-`))
        .map((name) => files[name] ?? '')
    },
    rows: () =>
      db
        .all(
          'SELECT kind, owned_marker, consent_origin, verified_at, reverted_at FROM config_writes'
        )
        .map((row) => ({ ...row })),
    setting: () => settings.get('opencode-permissions')
  }
}
