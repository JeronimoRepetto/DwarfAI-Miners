import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { opencodeDbPath, opencodeWalPath } from './store'

/*
 * Issue #444. `opencode.db` [V, docs/opencode-format.md] is the single source
 * this provider reads; these two paths are the only ones it ever builds.
 * Asserted through node:path.join (pathPortability.test.ts:8-15 idiom) so the
 * same expectation holds whichever host runs the suite.
 */

describe('opencodeDbPath / opencodeWalPath', () => {
  it('builds opencode.db under a POSIX root', () => {
    const root = '/home/j/.local/share/opencode'
    expect(opencodeDbPath(root)).toBe(join(root, 'opencode.db'))
  })

  it('builds opencode.db under a Windows root', () => {
    const root = 'C:\\Users\\j\\.local\\share\\opencode'
    expect(opencodeDbPath(root)).toBe(join(root, 'opencode.db'))
  })

  it('builds opencode.db-wal beside opencode.db, from a POSIX root', () => {
    const root = '/home/j/.local/share/opencode'
    expect(opencodeWalPath(root)).toBe(join(root, 'opencode.db-wal'))
  })

  it('builds opencode.db-wal beside opencode.db, from a Windows root', () => {
    const root = 'C:\\Users\\j\\.local\\share\\opencode'
    expect(opencodeWalPath(root)).toBe(join(root, 'opencode.db-wal'))
  })
})
