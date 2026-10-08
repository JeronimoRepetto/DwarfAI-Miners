// The ExternalConfigWriter conformance suites (16 §7.6; 17 §1.3). Never imported by production
// code (R14).
//
// - `runExternalConfigWriterContract`: what any ExternalConfigWriter shows through its port. It
//   runs on `FakeExternalConfigWriter` and on the config writer engine, so the double callers test
//   against behaves like the real writer.
// - `runConfigWriterEngineContract`: the file-level rules of ADR-016 items 6–7 and 16 §7.2–§7.5
//   (foreign bytes, one backup per enable, the re-read, the read-back, the ledger, the boot
//   settlement, locks, malformed files, old-app entries, one call per target at a time). It drives
//   the engine with the synthetic target over a FileSystem the caller supplies: FakeFs, and NodeFs
//   over a per-test `mkdtemp` directory.
import { describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../../kernel/domain/errors'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { RecordingDiagnosticsLog } from '../../../kernel/fakes/RecordingDiagnosticsLog'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { Scheduler } from '../../../kernel/ports/scheduler'
import type { FileSystemSubject } from '../../../kernel/testing/fileSystem.contract'
import { SqliteTransactionRunner } from '../../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../../platform/sqlite/testing/templateDb'
import { ConfigWriterEngine } from '../adapters/external-config/configWriterEngine'
import { SqliteConfigWriteLedger } from '../adapters/sqlite/SqliteConfigWriteLedger'
import { SqliteIntegrationSettingStore } from '../adapters/sqlite/SqliteIntegrationSettingStore'
import type {
  ChannelToken,
  ConfigTarget,
  ExternalConfigWriter
} from '../ports/externalConfigWriter'
import { ScriptedToolFs, SimulatedCrash } from './ScriptedToolFs'
import {
  syntheticConfigTarget,
  syntheticEntry,
  syntheticLegacyEntry
} from './syntheticConfigTarget'

const TOKEN = 'tok-1' as ChannelToken
const TOKEN_2 = 'tok-2' as ChannelToken

// ---------------------------------------------------------------------------------------------
// Port-level contract
// ---------------------------------------------------------------------------------------------

export interface ExternalConfigWriterSubject {
  writer: ExternalConfigWriter
  /** The target every case drives. */
  target: ConfigTarget
  /** The target's file is held open by its tool (`true`) or released (`false`). */
  lock(locked: boolean): void | Promise<void>
  /** The old app's entry is put into the target's file (16 §7.1 legacy probe). */
  plantLegacy(): void | Promise<void>
}

export function runExternalConfigWriterContract(
  makeSubject: () => ExternalConfigWriterSubject | Promise<ExternalConfigWriterSubject>
): void {
  describe('ExternalConfigWriter contract', () => {
    it('[S14.02, S14.06] install then verify reads verified, and revert then verify reads absent', async () => {
      const { writer, target } = await makeSubject()
      expect(await writer.verify(target)).toBe('absent')

      const installed = await writer.install(target, TOKEN, 'settings')
      expect(installed.ok && installed.value.verified).toBe(true)
      expect(await writer.verify(target)).toBe('verified')

      expect(await writer.revert(target)).toStrictEqual({ ok: true, value: undefined })
      expect(await writer.verify(target)).toBe('absent')
    })

    it('[ADR-016] a second install of an installed target succeeds, and revert of a target never installed succeeds', async () => {
      const first = await makeSubject()
      await first.writer.install(first.target, TOKEN, 'settings')
      const again = await first.writer.install(first.target, TOKEN_2, 'settings')
      expect(again.ok).toBe(true)
      expect(await first.writer.verify(first.target)).toBe('verified')

      const fresh = await makeSubject()
      expect(await fresh.writer.revert(fresh.target)).toStrictEqual({ ok: true, value: undefined })
      expect(await fresh.writer.verify(fresh.target)).toBe('absent')
    })

    it('[S14.07, FM-125] a locked target makes revert return locked and the entry stays verified', async () => {
      const { writer, target, lock } = await makeSubject()
      await writer.install(target, TOKEN, 'settings')

      await lock(true)
      expect(await writer.revert(target)).toStrictEqual({ ok: false, error: 'locked' })
      expect(await writer.verify(target)).toBe('verified')

      await lock(false)
      expect(await writer.revert(target)).toStrictEqual({ ok: true, value: undefined })
    })

    it('[S41.02, ADR-016] findLegacy reports an old-app entry, which install replaces and revert removes', async () => {
      const replaced = await makeSubject()
      expect(await replaced.writer.findLegacy(replaced.target)).toBe(false)
      await replaced.plantLegacy()
      expect(await replaced.writer.findLegacy(replaced.target)).toBe(true)
      // Never adopted: the old entry is not DwarfAI's verified write.
      expect(await replaced.writer.verify(replaced.target)).toBe('absent')
      await replaced.writer.install(replaced.target, TOKEN, 'first-run')
      expect(await replaced.writer.findLegacy(replaced.target)).toBe(false)

      const removed = await makeSubject()
      await removed.plantLegacy()
      expect(await removed.writer.revert(removed.target)).toStrictEqual({
        ok: true,
        value: undefined
      })
      expect(await removed.writer.findLegacy(removed.target)).toBe(false)
    })
  })
}

// ---------------------------------------------------------------------------------------------
// Engine contract (file level)
// ---------------------------------------------------------------------------------------------

/** Scheduled retries run at once: no real timer in an L3 test (17 §2.2). */
const immediateScheduler: Scheduler = {
  after(_ms, task) {
    queueMicrotask(task)
    return { cancel: () => undefined }
  }
}

const decoder = new TextDecoder()
const START = 1_760_000_000_000

/** The engine, its database, its file system and the synthetic targets of one case. */
export async function engineWorld(storage: FileSystemSubject) {
  const fs = new ScriptedToolFs(storage.fs)
  const dir = storage.pathOf('tool')
  const path = storage.pathOf('tool', 'config.ini')
  const hooksPath = storage.pathOf('tool', 'hooks.ini')
  await storage.seed(storage.pathOf('tool', 'unrelated.txt'), 'kept')
  const { db } = openTemplateCopy()
  const transactions = new SqliteTransactionRunner(db)
  const clock = new FakeClock(START)
  const ids = new SequenceIdGenerator()
  const log = new RecordingDiagnosticsLog()
  const settings = new SqliteIntegrationSettingStore({ db })
  const boot = (): ConfigWriterEngine =>
    new ConfigWriterEngine({
      fs,
      transactions,
      ledger: new SqliteConfigWriteLedger({ db }),
      settings: new SqliteIntegrationSettingStore({ db }),
      clock,
      ids,
      scheduler: immediateScheduler,
      log,
      targets: [
        syntheticConfigTarget('opencode-plugin', path),
        syntheticConfigTarget('claude-hooks', hooksPath)
      ]
    })
  const read = async (at = path): Promise<string | null> => {
    const bytes = await storage.fs.readFile(at)
    return bytes.ok ? decoder.decode(bytes.value) : null
  }
  const siblings = async (
    prefix: string
  ): Promise<Array<{ path: string; text: string | null }>> => {
    const listed = await storage.fs.listDirWithSizes(dir)
    if (!listed.ok) return []
    const names = listed.value
      .map((entry) => entry.name)
      .filter((name) => name.startsWith(prefix))
      .sort()
    return Promise.all(
      names.map(async (name) => {
        const at = storage.pathOf('tool', name)
        return { path: at, text: await read(at) }
      })
    )
  }
  return {
    fs,
    db,
    clock,
    log,
    path,
    hooksPath,
    writer: boot(),
    /** A new engine over the same database and disk: the Host after a restart. */
    boot,
    seed: (text: string, at = path) => storage.seed(at, text),
    read,
    /** The backups of `config.ini`, by path, oldest name first, with their text. */
    backups: () => siblings('config.ini.dwarfai-bak-'),
    /** The pre-write snapshots of `config.ini` (owner amendment J), with their text. */
    snapshots: () => siblings('config.ini.dwarfai-prewrite-'),
    rows: () =>
      db
        .all(
          `SELECT kind, target_path, owned_marker, backup_path, consent_origin, written_at,
                  verified_at, reverted_at
           FROM config_writes ORDER BY written_at, id`
        )
        .map((row) => ({ ...row })),
    setting: () => settings.get('opencode-permissions')
  }
}

export function runConfigWriterEngineContract(
  makeStorage: () => FileSystemSubject | Promise<FileSystemSubject>
): void {
  const world = async () => engineWorld(await makeStorage())

  describe('config writer engine contract', () => {
    it('[ADR-016, C-20, INV-111, NFR-SEC-10] install keeps every foreign byte identical and writes exactly one backup per enable', async () => {
      const w = await world()
      const original = '# tool settings\r\ntheme=dark\r\nlast=1'
      const edited = `${original}\r\nadded=by-tool`
      await w.seed(original)
      // The tool edits the file once during the write: the enable restarts, still one backup.
      w.fs.toolEditsBeforeRead(w.path, [2], (text) => `${text}\r\nadded=by-tool`)

      const installed = await w.writer.install('opencode-plugin', TOKEN, 'settings')

      expect(await w.read()).toBe(`${edited}\n${syntheticEntry(TOKEN)}`)
      const backups = await w.backups()
      expect(backups).toHaveLength(1)
      expect(backups[0]?.text).toBe(original)
      expect(installed).toStrictEqual({
        ok: true,
        value: { verified: true, backupPath: backups[0]?.path }
      })

      expect(await w.writer.revert('opencode-plugin')).toStrictEqual({ ok: true, value: undefined })
      expect(await w.read()).toBe(edited)

      // A second enable, at the same instant, takes its own backup and never overwrites the first.
      await w.writer.install('opencode-plugin', TOKEN, 'settings')
      const after = await w.backups()
      expect(after).toHaveLength(2)
      expect(after.find((backup) => backup.path === backups[0]?.path)?.text).toBe(original)
      expect(after.map((backup) => backup.text)).toContain(edited)
    })

    it('[ADR-016] a file DwarfAI did not create is never overwritten and install returns foreign-entry-conflict', async () => {
      const w = await world()
      const foreign = 'dwarfai.hook=written-by-someone-else\nx=1\n'
      await w.seed(foreign)

      expect(await w.writer.install('opencode-plugin', TOKEN, 'settings')).toStrictEqual({
        ok: false,
        error: 'foreign-entry-conflict'
      })
      expect(await w.read()).toBe(foreign)
      expect(w.fs.writes).toStrictEqual([])
      expect(w.rows()).toStrictEqual([])
      expect(w.setting().state).toBe('off')
    })

    it('[S14.03, S14.04] a file changed during the write restarts once, then gives up with concurrent-modification and the integration off', async () => {
      const w = await world()
      await w.seed('x=1\n')
      w.fs.toolEditsBeforeRead(w.path, [2, 4], (text) => `${text}y=2\n`)

      expect(await w.writer.install('opencode-plugin', TOKEN, 'settings')).toStrictEqual({
        ok: false,
        error: 'concurrent-modification'
      })
      // Only the tool's own bytes: DwarfAI's entry never landed.
      expect(await w.read()).toBe('x=1\ny=2\ny=2\n')
      expect(w.rows()).toStrictEqual([])
      expect(w.setting().state).toBe('off')
      expect(w.log.entries).toContainEqual(
        expect.objectContaining({
          event: 'config.write',
          outcome: 'failed',
          causeClass: 'concurrent-modification'
        })
      )
    })

    it('[S14.02, ADR-016] install resolves verified only after the read-back and records the consent origin in config_writes', async () => {
      const w = await world()
      await w.seed('x=1\n')

      const installed = await w.writer.install('opencode-plugin', TOKEN, 'first-run')

      expect(installed.ok && installed.value.verified).toBe(true)
      const backupPath = installed.ok ? installed.value.backupPath : null
      expect(w.rows()).toStrictEqual([
        {
          kind: 'opencode-plugin',
          target_path: w.path,
          owned_marker: 'dwarfai.hook=dwarfai-managed:',
          backup_path: backupPath,
          consent_origin: 'first-run',
          written_at: START,
          verified_at: START,
          reverted_at: null
        }
      ])
      expect(w.setting()).toStrictEqual({
        id: 'opencode-permissions',
        state: 'on-verified',
        consentOrigin: 'first-run',
        changedAt: START
      })
      expect(w.log.entries).toContainEqual(
        expect.objectContaining({ event: 'config.write', outcome: 'ok', msg: 'first-run' })
      )
      expect(w.log.refused).toStrictEqual([])

      // A read-back that does not show the write fails the enable: the tool dropped the entry.
      const dropped = await world()
      await dropped.seed('x=1\n')
      dropped.fs.toolEditsBeforeRead(dropped.path, [3], () => 'x=1\n')
      expect(await dropped.writer.install('opencode-plugin', TOKEN, 'settings')).toStrictEqual({
        ok: false,
        error: 'io'
      })
      expect(dropped.rows()).toStrictEqual([])
      expect(dropped.setting().state).toBe('off')
    })

    it("[S14.06, C-20] revert removes exactly DwarfAI's entries, keeps foreign bytes identical and sets reverted_at", async () => {
      const w = await world()
      await w.seed('a=1\nb=2\n')
      await w.writer.install('opencode-plugin', TOKEN, 'settings')
      // The tool keeps editing its file after the enable.
      w.clock.advance(5_000)
      await w.fs.writeFileAtomic(w.path, `${(await w.read()) ?? ''}c=3\n`)

      expect(await w.writer.revert('opencode-plugin')).toStrictEqual({ ok: true, value: undefined })

      expect(await w.read()).toBe(`a=1\nb=2\nc=3\n`)
      expect(w.rows()).toMatchObject([{ verified_at: START, reverted_at: START + 5_000 }])
      expect(w.setting()).toStrictEqual({
        id: 'opencode-permissions',
        state: 'off',
        changedAt: START + 5_000
      })
      expect(await w.backups()).toHaveLength(1)
      expect(await w.writer.verify('opencode-plugin')).toBe('absent')
    })

    it('[S14.07, FM-125, CH-07] a locked file makes revert return locked and changes nothing', async () => {
      const w = await world()
      await w.seed('a=1\n')
      await w.writer.install('opencode-plugin', TOKEN, 'settings')
      const written = await w.read()
      w.fs.lock(w.path)

      expect(await w.writer.revert('opencode-plugin')).toStrictEqual({
        ok: false,
        error: 'locked'
      })
      expect(await w.read()).toBe(written)
      expect(w.rows()).toMatchObject([{ reverted_at: null }])
      expect(w.setting().state).toBe('on-verified')
      expect(w.log.entries).toContainEqual(
        expect.objectContaining({ event: 'config.revert', outcome: 'failed', causeClass: 'locked' })
      )
    })

    it('[FM-020, S14.11, CH-11] a crash between Tx A and Tx B is settled at boot: verified → on-verified, else reverted → off', async () => {
      // The Host dies right after the file landed: Tx A's row is there, Tx B never ran.
      const landed = await world()
      await landed.seed('x=1\n')
      landed.fs.crashAt(landed.path, 'after-write')
      await expect(landed.writer.install('opencode-plugin', TOKEN, 'add-panel')).rejects.toThrow(
        SimulatedCrash
      )
      expect(landed.rows()).toMatchObject([{ verified_at: null, reverted_at: null }])
      expect(landed.setting().state).toBe('off')

      landed.clock.advance(60_000)
      await landed.boot().settleUnverified()

      expect(landed.rows()).toMatchObject([{ verified_at: START + 60_000, reverted_at: null }])
      expect(landed.setting()).toMatchObject({ state: 'on-verified', consentOrigin: 'add-panel' })
      expect(await landed.read()).toBe(`x=1\n${syntheticEntry(TOKEN)}\n`)

      // The Host dies while the file is written: the atomic write left the original intact.
      const lost = await world()
      await lost.seed('x=1\n')
      lost.fs.crashAt(lost.path, 'before-write')
      await expect(lost.writer.install('opencode-plugin', TOKEN, 'settings')).rejects.toThrow(
        SimulatedCrash
      )
      expect(await lost.read()).toBe('x=1\n')

      lost.clock.advance(60_000)
      await lost.boot().settleUnverified()

      expect(lost.rows()).toMatchObject([{ verified_at: null, reverted_at: START + 60_000 }])
      expect(lost.setting().state).toBe('off')
      expect(await lost.read()).toBe('x=1\n')
    })

    it('[FM-127] a malformed target file is left untouched and install fails', async () => {
      const w = await world()
      const malformed = 'x=1\nthis is not a setting\n'
      await w.seed(malformed)

      expect(await w.writer.install('opencode-plugin', TOKEN, 'settings')).toStrictEqual({
        ok: false,
        error: 'io'
      })
      expect(await w.read()).toBe(malformed)
      expect(await w.backups()).toStrictEqual([])
      expect(w.rows()).toStrictEqual([])
      expect(w.setting().state).toBe('off')
    })

    it('[ADR-016] install on an on-verified target is a no-op and revert of an absent entry succeeds', async () => {
      const w = await world()
      await w.seed('x=1\n')
      const first = await w.writer.install('opencode-plugin', TOKEN, 'settings')
      const writes = w.fs.writes.length
      const rows = w.rows()
      const file = await w.read()

      expect(await w.writer.install('opencode-plugin', TOKEN_2, 'settings')).toStrictEqual(first)
      expect(w.fs.writes).toHaveLength(writes)
      expect(w.rows()).toStrictEqual(rows)
      expect(await w.read()).toBe(file)

      const absent = await world()
      await absent.seed('x=1\n')
      expect(await absent.writer.revert('opencode-plugin')).toStrictEqual({
        ok: true,
        value: undefined
      })
      expect(await absent.read()).toBe('x=1\n')
      expect(absent.fs.writes).toStrictEqual([])

      const missing = await world()
      expect(await missing.writer.revert('opencode-plugin')).toStrictEqual({
        ok: true,
        value: undefined
      })
      expect(await missing.read()).toBeNull()
    })

    it('[ADR-016, S41.02] an old-app entry is never adopted: it is not verified, the boot leaves it alone, and install replaces it after the backup', async () => {
      const w = await world()
      const original = `a=1\n${syntheticLegacyEntry('old-token')}\nb=2\n`
      await w.seed(original)

      expect(await w.writer.findLegacy('opencode-plugin')).toBe(true)
      expect(await w.writer.verify('opencode-plugin')).toBe('absent')
      await w.boot().settleUnverified()
      expect(w.setting().state).toBe('off')
      expect(await w.read()).toBe(original)

      await w.writer.install('opencode-plugin', TOKEN, 'first-run')

      expect(await w.read()).toBe(`a=1\n${syntheticEntry(TOKEN)}\nb=2\n`)
      expect((await w.backups()).map((backup) => backup.text)).toStrictEqual([original])
      expect(await w.writer.findLegacy('opencode-plugin')).toBe(false)
    })

    it('[S14.12, ADR-016] reverting an old-app entry backs the file up and removes it, foreign bytes identical', async () => {
      const w = await world()
      const original = `a=1\n${syntheticLegacyEntry('old-token')}\nb=2\n`
      await w.seed(original)

      expect(await w.writer.revert('opencode-plugin')).toStrictEqual({ ok: true, value: undefined })

      expect(await w.read()).toBe('a=1\nb=2\n')
      expect((await w.backups()).map((backup) => backup.text)).toStrictEqual([original])
      expect(w.rows()).toStrictEqual([])
      expect(w.setting().state).toBe('off')
    })

    it('[CH-07] a sharing violation on the write is retried and the write lands', async () => {
      const w = await world()
      await w.seed('x=1\n')
      w.fs.failWrites(w.path, 'busy', 1)

      const installed = await w.writer.install('opencode-plugin', TOKEN, 'settings')

      expect(installed.ok).toBe(true)
      expect(await w.read()).toBe(`x=1\n${syntheticEntry(TOKEN)}\n`)
    })

    it('[ADR-016, C-20] calls on one target are serialized: a revert asked during an install runs after it', async () => {
      const w = await world()
      await w.seed('x=1\n')

      const install = w.writer.install('opencode-plugin', TOKEN, 'settings')
      const revert = w.writer.revert('opencode-plugin')
      expect((await install).ok).toBe(true)
      expect(await revert).toStrictEqual({ ok: true, value: undefined })

      expect(await w.read()).toBe('x=1\n')
      expect(w.rows()).toMatchObject([{ verified_at: START, reverted_at: START }])
      expect(w.setting().state).toBe('off')
    })

    it('[ADR-016, CH-07] a sharing violation that outlasts the retries falls back to an in-place write behind a snapshot, removed once verified', async () => {
      const w = await world()
      await w.seed('x=1\n')
      w.fs.refuseRenames(w.path)

      const installed = await w.writer.install('opencode-plugin', TOKEN, 'settings')

      expect(installed.ok && installed.value.verified).toBe(true)
      expect(await w.read()).toBe(`x=1\n${syntheticEntry(TOKEN)}\n`)
      // In place only after the atomic write and its two retries...
      const onTarget = w.fs.attempts.filter((a) => a.path === w.path).map((a) => a.kind)
      expect(onTarget).toStrictEqual(['atomic', 'atomic', 'atomic', 'in-place'])
      // ...and only once the snapshot of the bytes it replaces is on disk.
      const snapshotAt = w.fs.writes.findIndex((path) => path.includes('.dwarfai-prewrite-'))
      expect(snapshotAt).toBeGreaterThanOrEqual(0)
      expect(snapshotAt).toBeLessThan(w.fs.writes.indexOf(w.path))
      expect(await w.snapshots()).toStrictEqual([])
      expect(await w.backups()).toHaveLength(1)
      expect(w.setting().state).toBe('on-verified')
    })

    it('[FM-020, S14.11, CH-11] a crash part-way through the in-place write is restored at boot from the fresh snapshot, byte for byte, and the integration is off', async () => {
      const w = await world()
      const original = 'theme=dark\r\nlast=1\r\n'
      const edited = `${original}added=by-tool\r\n`
      await w.seed(original)
      // The tool edits the file after the per-enable backup was taken: that backup is stale.
      w.fs.toolEditsBeforeRead(w.path, [2], (text) => `${text}added=by-tool\r\n`)
      w.fs.refuseRenames(w.path)
      w.fs.crashPartWayInPlace(w.path, 7)

      await expect(w.writer.install('opencode-plugin', TOKEN, 'settings')).rejects.toThrow(
        SimulatedCrash
      )
      expect(await w.read()).toBe(edited.slice(0, 7))
      expect((await w.backups()).map((backup) => backup.text)).toStrictEqual([original])

      w.clock.advance(60_000)
      await w.boot().settleUnverified()

      expect(await w.read()).toBe(edited)
      expect(await w.snapshots()).toStrictEqual([])
      expect(w.rows()).toMatchObject([{ verified_at: null, reverted_at: START + 60_000 }])
      expect(w.setting().state).toBe('off')
      expect(w.log.entries).toContainEqual(
        expect.objectContaining({
          event: 'config.write',
          outcome: 'degraded',
          causeClass: 'partial-write-restored'
        })
      )
      // ADR-026: the recovery is logged without a byte of the file.
      expect(JSON.stringify(w.log.entries)).not.toContain('theme')
      expect(w.log.refused).toStrictEqual([])
    })

    it('[S14.01] claude-hooks refuses the add-panel consent origin before anything is recorded or written', async () => {
      const w = await world()
      await w.seed('x=1\n', w.hooksPath)

      await expect(w.writer.install('claude-hooks', TOKEN, 'add-panel')).rejects.toThrow(
        HostInvariantError
      )
      expect(w.rows()).toStrictEqual([])
      expect(w.fs.writes).toStrictEqual([])
      expect(await w.read(w.hooksPath)).toBe('x=1\n')
    })
  })
}
