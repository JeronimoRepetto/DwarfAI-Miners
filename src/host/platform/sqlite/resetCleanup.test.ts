import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SqliteTransactionRunner } from './SqliteTransactionRunner'
import { SqliteResetCleanup } from './resetCleanup'
import { openTemplateCopy } from './testing/templateDb'

// L5 (17 §1.5): the post-commit part of the Reset saga's `db` step (ADR-023 item 4.2; 09 §7.2,
// D-11) over a real database file in its own temp directory.

describe('SqliteResetCleanup', () => {
  it('[S13.01] after the commit the dwarfai.db backups are deleted, the WAL truncated and VACUUM leaves no free page, each one idempotent', () => {
    const { db, path } = openTemplateCopy()
    const dir = dirname(path)
    const name = basename(path)
    const backups = [
      `${name}.bak-v1-20250615T150740000Z`,
      `${name}.bak-v1-20250616T150740000Z`,
      `${name}.bak-v1-20250617T150740000Z.partial`
    ]
    const kept = ['other.db.bak-v1-20250615T150740000Z', `${name}.notes`]
    for (const file of [...backups, ...kept]) writeFileSync(join(dir, file), 'copy')
    // Deleted text in free pages and in the WAL (09 §9 `secure_delete` covers the rest).
    const transactions = new SqliteTransactionRunner(db)
    transactions.inTransaction(() => {
      for (let i = 0; i < 200; i += 1) {
        db.run(
          `INSERT INTO reset_journal (id, epoch, step, started_at, step_at, finished_at)
                VALUES (?, ?, 'done', 1, 1, 1)`,
          [`00000000-0000-7000-8000-${String(i).padStart(12, '0')}`, i + 1]
        )
      }
    })
    transactions.inTransaction(() => db.run('DELETE FROM reset_journal'))
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(0)

    const cleanup = new SqliteResetCleanup({ db, path })
    cleanup.deleteBackups()
    cleanup.truncateWal()
    expect(statSync(`${path}-wal`).size).toBe(0)
    cleanup.vacuum()
    expect(Number(db.all('PRAGMA freelist_count')[0]?.['freelist_count'])).toBe(0)
    // A resumed saga re-runs all three (07 S13.08).
    cleanup.deleteBackups()
    cleanup.truncateWal()
    cleanup.vacuum()

    for (const file of backups) expect(existsSync(join(dir, file)), file).toBe(false)
    for (const file of kept) expect(existsSync(join(dir, file)), file).toBe(true)
    expect(readdirSync(dir).filter((file) => file.startsWith(`${name}.bak-`))).toStrictEqual([])
  })
})
