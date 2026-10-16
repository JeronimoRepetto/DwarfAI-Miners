// layer: L5
// L5 (17 §1.5): the real deletion of "Reset metrics" on a real database file (ADR-023 items 1, 4.2;
// 18 §5.5 C-25: `secure_delete`, WAL truncate, `VACUUM`, backups deleted; NFR-PRIV-05). A copy of
// the template database in its own temp directory, seeded with messages whose texts are unique
// markers and with a pre-migration backup beside it holding the same texts; the saga's `db` step
// runs every module step the composition root registers (moduleResetSteps.ts, resetParticipants.ts)
// and its post-commit cleanup (`SqliteResetCleanup`). Afterwards no backup is left, the WAL is
// empty, and the raw bytes of the database file hold none of the marker texts.
//
// TC-233-05.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HostEpoch } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import { InProcessEventBus } from '../../kernel/InProcessEventBus'
import { createAttentionResetStep } from '../../modules/attention'
import {
  createPreferencesResetStep,
  createResetSaga,
  type PreferencesEvent
} from '../../modules/preferences'
import { createModuleResetSteps } from '../../wiring/moduleResetSteps'
import { noOwnedConfigWriter, unavailableSecretStore } from '../../wiring/preferencesWiring'
import { resetParticipants } from '../../wiring/resetParticipants'
import { SqliteResetCleanup } from './resetCleanup'
import { SqliteTransactionRunner } from './SqliteTransactionRunner'
import { openTemplateCopy } from './testing/templateDb'

const T0 = 1_790_000_000_000
const MINE = '00000000-0000-7000-8000-0000000233a1'
const DWARF = {
  live: '00000000-0000-7000-8000-0000000233b1',
  departed: '00000000-0000-7000-8000-0000000233b2'
} as const
/** Texts no other byte of the file could hold by chance. */
const MARKERS = [
  'RESET-MARKER-amber-quartz-7731',
  'RESET-MARKER-basalt-ember-4410',
  'RESET-MARKER-cinder-flint-0952'
] as const

describe('Reset metrics deletes for real (18 §5.5 C-25)', () => {
  it('[ADR-023, C-25, NFR-PRIV-05] after reset no dwarfai.db.bak file exists, the WAL is truncated and a raw scan of the database file finds none of the seeded message texts', async () => {
    const { db, path } = openTemplateCopy()
    const dir = dirname(path)
    const transactions = new SqliteTransactionRunner(db)
    transactions.inTransaction(() => {
      db.run(
        `INSERT INTO mines (id, canonical_path, name, name_norm, state, created_at, last_used_at)
         VALUES (?, '/mine', 'mine', 'mine', 'active', ?, ?)`,
        [MINE, T0, T0]
      )
      for (const [id, departed] of [
        [DWARF.live, false],
        [DWARF.departed, true]
      ] as const) {
        db.run(
          `INSERT INTO dwarfs (id, mine_id, provider_id, provider_session_id, base_name, rank,
             process_state, turn_state, arrived_at, last_activity_at, departed_at, departure_cause)
           VALUES (?, ?, 'claude', ?, 'Durin', 'foreman', ?, 'none-yet', ?, ?, ?, ?)`,
          [
            id,
            MINE,
            `session-${id}`,
            departed ? 'closed' : 'running',
            T0,
            T0,
            departed ? T0 + 1 : null,
            departed ? 'stopped' : null
          ]
        )
      }
      for (const [n, text] of MARKERS.entries()) {
        db.run(
          `INSERT INTO messages (id, dwarf_id, role, text, origin, created_at)
           VALUES (?, ?, 'person', ?, 'dwarfai', ?)`,
          [
            `00000000-0000-7000-8000-0000000233c${n}`,
            n === 0 ? DWARF.departed : DWARF.live,
            text,
            T0 + n
          ]
        )
      }
    })
    // A pre-migration backup of the same conversation (backup.ts names it `<db file>.bak-…`).
    const backup = join(dir, `${basename(path)}.bak-v1-20260601T000000000Z`)
    writeFileSync(backup, MARKERS.join('\n'))

    const clock = new FakeClock(T0 + 86_400_000)
    const ids = new SequenceIdGenerator()
    const modules = createModuleResetSteps({
      db,
      scope: transactions,
      clock,
      mapSites: [],
      random: () => 0
    })
    const participants = resetParticipants({
      preferences: createPreferencesResetStep({ db, clock }),
      modules: modules.steps,
      attention: createAttentionResetStep({ db, scope: transactions }),
      // The install moment is the flow suite's (resetScope.test.ts); R6 keeps the ledger's adapter
      // out of this platform test, and this case reads no install moment.
      ledger: { setInstallMoment: () => undefined },
      clock
    })
    // The real cleanup, observed: the WAL size right after its checkpoint (later steps of the saga
    // write to the WAL again, so the moment of the truncation is the one to read).
    const cleanup = new SqliteResetCleanup({ db, path })
    const walAfterTruncate: number[] = []
    const maintenance = {
      deleteBackups: () => cleanup.deleteBackups(),
      truncateWal: () => {
        cleanup.truncateWal()
        walAfterTruncate.push(statSync(`${path}-wal`).size)
      },
      vacuum: () => cleanup.vacuum()
    }
    const saga = createResetSaga({
      db,
      transactions,
      dbSteps: participants.dbSteps,
      installMoment: participants.installMoment,
      maintenance,
      // No OS secret store: the `secrets` step completes as a no-op (ADR-017 item 5, AMENDMENT-2).
      secrets: unavailableSecretStore,
      externalConfig: noOwnedConfigWriter,
      ui: { progress: () => undefined, resetPreferences: () => Promise.resolve() },
      bus: new InProcessEventBus<PreferencesEvent>({
        transactionScope: transactions,
        onHandlerError: (failure) => {
          throw failure.error
        }
      }),
      clock,
      ids,
      hostEpoch: 'epoch-0233-l5' as HostEpoch,
      log: new RecordingDiagnosticsLog()
    })

    expect(await saga.resetMetrics({ confirmed: 'yes' })).toMatchObject({ outcome: 'reset' })

    expect(existsSync(backup)).toBe(false)
    expect(
      readdirSync(dir).filter((name) => name.startsWith(`${basename(path)}.bak-`))
    ).toStrictEqual([])
    expect(walAfterTruncate).toStrictEqual([0])
    // The connection policy's `secure_delete = FAST` (connectionPolicy.ts; 09 §9).
    expect(Number(db.all('PRAGMA secure_delete')[0]?.['secure_delete'])).toBe(2)
    expect(db.all('SELECT count(*) AS n FROM messages')[0]?.['n']).toBe(0)
    // A raw scan of the database file and of its WAL as they are now.
    for (const file of [path, `${path}-wal`]) {
      const raw = readFileSync(file).toString('latin1')
      for (const text of MARKERS)
        expect(raw.includes(text), `${basename(file)}: ${text}`).toBe(false)
    }
  })
})
