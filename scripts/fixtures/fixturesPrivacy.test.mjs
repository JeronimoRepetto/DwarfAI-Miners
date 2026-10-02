import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkCommittedFixtures } from './lib/committedFixtures.mjs'

/**
 * L7 static test over the committed `fixtures/` tree (17 §1.4, §5.2): what git tracks, not what
 * happens to lie on this disk, because only a committed file can leak. Each check is first shown
 * to bite on a synthetic tree, then run on the real one.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')

/** Every tracked file under `fixtures/`, as `{ path, text }`; binary files are skipped. */
function committedFixtures() {
  const listed = execFileSync('git', ['ls-files', '-z', '--', 'fixtures'], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: false
  })
  return listed
    .split('\0')
    .filter((file) => file !== '')
    .map((file) => ({ path: file, buffer: readFileSync(path.join(repoRoot, file)) }))
    .filter(({ buffer }) => !buffer.includes(0))
    .map(({ path: file, buffer }) => ({ path: file, text: buffer.toString('utf8') }))
}

const meta = (overrides = {}) =>
  JSON.stringify({
    providerVersion: '2.1.14',
    capturedAt: '2026-09-30T00:00:00.000Z',
    capturedBy: 'maintainer',
    os: 'linux',
    scrubbed: true,
    capabilities: {},
    ...overrides
  })

const rules = (files) => checkCommittedFixtures(files).map(({ file, rule }) => `${file} ${rule}`)

describe('committed fixtures privacy (17 §1.4)', () => {
  it('[ADR-008] every meta.json under fixtures has scrubbed true and a role as capturedBy, and no raw capture is committed', () => {
    expect(
      rules([
        { path: 'fixtures/canary/acp/1.0.0/meta.json', text: meta() },
        { path: 'fixtures/canary/acp/1.1.0/meta.json', text: meta({ scrubbed: false }) },
        { path: 'fixtures/canary/acp/1.2.0/meta.json', text: meta({ capturedBy: 'canary.user' }) },
        { path: 'fixtures/canary/acp/1.3.0/meta.json', text: '{' },
        { path: 'fixtures/canary/acp/1.0.0/simple-turn.raw.jsonl', text: '{}\n' }
      ])
    ).toEqual([
      'fixtures/canary/acp/1.0.0/simple-turn.raw.jsonl raw-capture',
      'fixtures/canary/acp/1.1.0/meta.json scrubbed',
      'fixtures/canary/acp/1.2.0/meta.json captured-by-role',
      'fixtures/canary/acp/1.3.0/meta.json meta-json'
    ])

    const violations = checkCommittedFixtures(committedFixtures()).filter(
      ({ rule }) => rule !== 'secret'
    )
    expect(violations).toEqual([])
  })

  it('[ADR-026] no committed fixture matches a secret pattern', () => {
    expect(
      rules([
        { path: 'fixtures/canary/acp/1.0.0/a.jsonl', text: `{"key":"sk-${'a1B2'.repeat(6)}"}\n` },
        {
          path: 'fixtures/canary/acp/1.0.0/b.jsonl',
          text: `{"token":"${'d4e5f6a7'.repeat(8)}"}\n`
        },
        { path: 'fixtures/canary/acp/1.0.0/c.jsonl', text: '{"h":"Bearer abc.def"}\n' },
        { path: 'fixtures/canary/acp/1.0.0/d.jsonl', text: '{"h":"Bearer [redacted]"}\n' },
        // Outside the provider folders: a migration checksum is not a recorded token.
        { path: 'fixtures/db/cut-1.sql', text: `'${'66f0966f'.repeat(8)}'\n` }
      ])
    ).toEqual([
      'fixtures/canary/acp/1.0.0/a.jsonl secret',
      'fixtures/canary/acp/1.0.0/b.jsonl secret',
      'fixtures/canary/acp/1.0.0/c.jsonl secret'
    ])

    const violations = checkCommittedFixtures(committedFixtures()).filter(
      ({ rule }) => rule === 'secret'
    )
    expect(violations).toEqual([])
  })
})
