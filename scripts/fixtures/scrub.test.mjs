import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkFixturesLayout } from '../checks/fixtures-layout.mjs'
import { runScrub } from './scrub.mjs'

/**
 * L7 tests of `scrub.mjs` (17 §1.4 recording steps 4–5). Each case writes a synthetic raw capture
 * into its own `mkdtemp` fixtures tree and scrubs it there; the real filesystem is the subject.
 * Every personal value is synthetic (`canary.user` on `canary-host`).
 */

const IDENTITY = { home: 'C:\\Users\\canary.user', user: 'canary.user', host: 'canary-host' }
const REPO_ROOT = 'C:\\Users\\canary.user\\AppData\\Local\\Temp\\dwarfai-rec-1'
const SK_KEY = `sk-${'a1B2'.repeat(6)}`

let tempRoots = []

afterEach(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true })
  tempRoots = []
})

/** A fixtures tree holding one raw capture of `simple-turn`; returns the case folder and raw paths. */
function rawCapture() {
  const root = mkdtempSync(path.join(tmpdir(), 'fixtures-scrub-'))
  tempRoots.push(root)
  for (const folder of ['bin', 'db', 'ipc/capabilities']) {
    mkdirSync(path.join(root, folder), { recursive: true })
    writeFileSync(path.join(root, folder, '.gitkeep'), '')
  }
  const folder = path.join(root, 'canary', 'stream-json', '2.1.14')
  mkdirSync(folder, { recursive: true })
  const write = (name, text) => {
    writeFileSync(path.join(folder, name), text)
    return path.join(folder, name)
  }
  const session = '7c1e2a40-55aa-4c3b-9d10-aabbccddeeff'
  const lines = (records) => records.map((record) => JSON.stringify(record)).join('\n') + '\n'
  const paths = [
    write(
      'simple-turn.raw.jsonl',
      lines([
        { type: 'system', session_id: session, cwd: REPO_ROOT, home: IDENTITY.home },
        {
          type: 'result',
          session_id: session,
          text: `canary.user@example.com on canary-host, key ${SK_KEY}`,
          headers: { authorization: 'Bearer canaryBearer.0123' }
        }
      ])
    ),
    write(
      'simple-turn.raw.sent.jsonl',
      lines([{ type: 'user', session_id: session, prompt: 'Say hello' }])
    ),
    write(
      'simple-turn.raw.meta.json',
      JSON.stringify({
        provider: 'canary',
        driver: 'stream-json',
        providerVersion: '2.1.14',
        os: 'win32',
        capturedAt: '2026-09-30',
        capabilities: { launch: true },
        repoRoot: REPO_ROOT
      })
    )
  ]
  return { root, folder, paths }
}

const listing = (folder) => readdirSync(folder).sort()

describe('scrub.mjs (17 §1.4)', () => {
  it('[ADR-008, ADR-026] writes the scrubbed case, its variants and meta.json with none of the maintainer values, then deletes the raw capture', () => {
    const { root, folder, paths } = rawCapture()

    const exitCode = runScrub(paths, { identity: IDENTITY, log: () => {} })

    expect(exitCode).toBe(0)
    expect(listing(folder)).toEqual([
      'meta.json',
      'simple-turn-crlf.jsonl',
      'simple-turn-sent-crlf.jsonl',
      'simple-turn-sent-with-extra.jsonl',
      'simple-turn-sent.jsonl',
      'simple-turn-with-extra.jsonl',
      'simple-turn.jsonl'
    ])
    const all = listing(folder)
      .map((name) => readFileSync(path.join(folder, name), 'utf8'))
      .join('\n')
    for (const value of ['canary.user', 'canary-host', 'example.com', SK_KEY, 'canaryBearer']) {
      expect(all).not.toContain(value)
    }
    expect(JSON.parse(readFileSync(path.join(folder, 'meta.json'), 'utf8'))).toEqual({
      providerVersion: '2.1.14',
      capturedAt: '2026-09-30T00:00:00.000Z',
      capturedBy: 'maintainer',
      os: 'win32',
      scrubbed: true,
      capabilities: { launch: true }
    })
    const withExtra = readFileSync(path.join(folder, 'simple-turn-with-extra.jsonl'), 'utf8')
    const [first] = withExtra
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line))
    expect(first.dwarfaiUnknownField).toBe('extra')
    // The written folder is a valid fixture set (17 §1.4 layout, checked by the layout check).
    expect(checkFixturesLayout(root)).toEqual([])
  })

  it('[ADR-008, ADR-026] exits non-zero and writes nothing when a personal value or a secret survives', () => {
    const { folder, paths } = rawCapture()
    const before = listing(folder)
    const logged = []

    const exitCode = runScrub(paths, {
      identity: IDENTITY,
      scrubSet: (documents) => documents,
      log: (line) => logged.push(line)
    })

    expect(exitCode).toBe(1)
    expect(listing(folder)).toEqual(before)
    expect(logged.join('\n')).toMatch(/simple-turn\.jsonl:2: secret survived/)
    // The report names the rule and the line, never the value.
    expect(logged.join('\n')).not.toContain(SK_KEY)
    expect(existsSync(path.join(folder, 'meta.json'))).toBe(false)
  })
})
