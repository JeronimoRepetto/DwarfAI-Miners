import { describe, expect, it } from 'vitest'
import { dumpSeededFixture } from '../../src/host/platform/sqlite/testing/fixtureDump.ts'
import { localIdentity } from './dump-fixture.mjs'

// L5 (17 §1.4 "Redaction (scrub rules)", §1.5; ADR-008): a ladder rung is committed text, read by
// reviewers and scanned by the privacy guard, so the dump replaces every home path, user name,
// host name and e-mail address before it is written. The seeded values here are the real ones of
// the machine running the test (what `dump-fixture.mjs` scrubs by default) plus a synthetic
// identity; neither is ever written to a tracked file.

const SYNTHETIC = {
  home: 'C:\\Users\\canary.user',
  user: 'canary.user',
  host: 'canary-host'
}
const MINE = '00000000-0000-7000-8000-0000000000f1'
const DWARF = '00000000-0000-7000-8000-0000000000d1'

function quote(text) {
  return `'${text.replaceAll("'", "''")}'`
}

describe('dump-fixture scrubbing (17 §1.4)', () => {
  it('[ADR-008] a dump never contains a home path, a user name or an e-mail', () => {
    const local = localIdentity()
    const homes = [local.home, SYNTHETIC.home, '/home/other.person', '/Users/someone.else']
    const users = [local.user, SYNTHETIC.user]
    const email = 'canary.user@example.com'
    const message = `${users.join(' and ')} (${email}) asked on ${local.host} and ${SYNTHETIC.host}`
    const seed = {
      release: 'scrub-check',
      version: 1,
      statements: [
        `INSERT INTO mines (id, canonical_path, name, name_norm, state, created_at, last_used_at)
         VALUES ('${MINE}', ${quote(`${homes[0]}/repo`)}, 'repo', 'repo', 'active', 0, 0)`,
        `INSERT INTO dwarfs (id, mine_id, provider_id, provider_session_id, base_name, rank,
           process_state, turn_state, arrived_at, last_activity_at, workplace_path)
         VALUES ('${DWARF}', '${MINE}', 'claude', 's-1', 'Dwarf', 'foreman', 'running',
           'none-yet', 0, 0, ${quote(`${homes[1]}\\repo\\.worktrees\\a`)})`,
        `INSERT INTO messages (id, dwarf_id, source_key, role, text, origin, created_at)
         VALUES ('00000000-0000-7000-8000-0000000000a1', '${DWARF}', 'k-1', 'dwarf',
           ${quote(`${message} in ${homes[2]}/x and ${homes[3]}/y`)}, 'transcript', 0)`
      ]
    }

    const dump = dumpSeededFixture(seed, { identities: [local, SYNTHETIC] })
    // The rows are what can carry a person's data; the schema text is the migration's own (and a
    // one-letter account name would match it anywhere).
    const text = dump
      .split('\n')
      .filter((line) => line.startsWith('INSERT INTO'))
      .join('\n')
      .toLowerCase()

    for (const value of [...homes, ...users, local.host, SYNTHETIC.host, email]) {
      expect(text.includes(value.toLowerCase()), `the dump contains ${JSON.stringify(value)}`).toBe(
        false
      )
      expect(text.includes(value.replaceAll('\\', '/').toLowerCase())).toBe(false)
    }
    expect(text).toContain('<home>/repo')
    expect(text).toContain('<email>')
  })
})
