// The config writer engine with the real `claude-hooks` target (ISSUE-220) over a FileSystem the
// caller supplies (FakeFs, or NodeFs over a per-test `mkdtemp` directory) and a migrated database,
// plus the hand-written `settings.json` fixtures of `../__fixtures__/`. Never imported by
// production code (R14).
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { FakeClock } from '../../../../../../kernel/fakes/FakeClock'
import { RecordingDiagnosticsLog } from '../../../../../../kernel/fakes/RecordingDiagnosticsLog'
import { SequenceIdGenerator } from '../../../../../../kernel/fakes/SequenceIdGenerator'
import type { Scheduler } from '../../../../../../kernel/ports/scheduler'
import type { SqliteDatabase } from '../../../../../../kernel/ports/sqliteDatabase'
import type { FileSystemSubject } from '../../../../../../kernel/testing/fileSystem.contract'
import { SqliteTransactionRunner } from '../../../../../../platform/sqlite/SqliteTransactionRunner'
import type { ChannelToken, ExternalConfigWriter } from '../../../../ports/externalConfigWriter'
import { ScriptedToolFs } from '../../../../testing/ScriptedToolFs'
import { SqliteConfigWriteLedger } from '../../../sqlite/SqliteConfigWriteLedger'
import { SqliteIntegrationSettingStore } from '../../../sqlite/SqliteIntegrationSettingStore'
import { ConfigWriterEngine } from '../../configWriterEngine'
import { ClaudeHooksConfigWriter } from '../ClaudeHooksConfigWriter'

/** A `claudeHookToken` as ChannelTokenStore issues it: 32 bytes, lower-case hex (ADR-016 item 1). */
export const HOOK_TOKEN = 'f00d'.repeat(16) as ChannelToken
/** The persisted ingress port the fixtures were written with. */
export const INGRESS_PORT = 45123

const FIXTURES = new URL('../__fixtures__/', import.meta.url)

/** A hand-written `settings.json` fixture, as its exact text. */
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

export async function claudeHooksWorld(
  storage: FileSystemSubject,
  db: SqliteDatabase,
  platform: NodeJS.Platform = 'linux'
) {
  const fs = new ScriptedToolFs(storage.fs)
  const dir = storage.pathOf('.claude')
  const path = storage.pathOf('.claude', 'settings.json')
  // Claude Code's own folder exists (it is installed); the settings file may not.
  await storage.seed(storage.pathOf('.claude', 'CLAUDE.md'), 'kept')
  const log = new RecordingDiagnosticsLog()
  const settings = new SqliteIntegrationSettingStore({ db })
  const writer = new ConfigWriterEngine({
    fs,
    transactions: new SqliteTransactionRunner(db),
    ledger: new SqliteConfigWriteLedger({ db }),
    settings,
    clock: new FakeClock(1_760_000_000_000),
    ids: new SequenceIdGenerator(),
    scheduler: immediateScheduler,
    log,
    targets: [new ClaudeHooksConfigWriter({ path, platform, ingressPort: () => INGRESS_PORT })]
  })
  const read = async (at = path): Promise<string | null> => {
    const bytes = await storage.fs.readFile(at)
    return bytes.ok ? decoder.decode(bytes.value) : null
  }
  return {
    writer,
    fs,
    log,
    path,
    seed: (text: string) => storage.seed(path, text),
    read,
    /** The backups beside `settings.json`, oldest name first, with their text. */
    backups: async (): Promise<Array<{ path: string; text: string | null }>> => {
      const listed = await storage.fs.listDirWithSizes(dir)
      if (!listed.ok) return []
      const names = listed.value
        .map((entry) => entry.name)
        .filter((name) => name.startsWith('settings.json.dwarfai-bak-'))
        .sort()
      return Promise.all(
        names.map(async (name) => {
          const at = storage.pathOf('.claude', name)
          return { path: at, text: await read(at) }
        })
      )
    },
    setting: () => settings.get('claude-hooks')
  }
}

/**
 * The port-level contract drives every target with opaque test tokens (`tok-1`); this target
 * refuses any token that is not lower-case hex before it renders (ADR-016 item 1, `TOKEN_PATTERN`).
 * The subject hands the engine a hex token derived from each one, so the contract runs unchanged.
 */
export function withHexTokens(writer: ExternalConfigWriter): ExternalConfigWriter {
  const hex = (token: ChannelToken): ChannelToken =>
    createHash('sha256').update(token).digest('hex') as ChannelToken
  return {
    install: (target, token, origin) => writer.install(target, hex(token), origin),
    verify: (target) => writer.verify(target),
    revert: (target) => writer.revert(target),
    findLegacy: (target) => writer.findLegacy(target)
  }
}
