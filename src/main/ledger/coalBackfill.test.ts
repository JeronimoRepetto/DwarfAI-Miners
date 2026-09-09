import { describe, expect, it } from 'vitest'
import { FakeFs } from '../adapters/fakeFs'
import { mineIdForPath } from '../domain/aggregate'
import { COAL_BACKFILL_VERSION, runCoalBackfill, type CoalBackfillOptions } from './coalBackfill'
import type { LedgerFsLike } from './ledgerStore'

const NOW = Date.parse('2026-06-01T12:00:00.000Z')
const LONG_AGO = Date.parse('2026-01-01T10:00:00.000Z')
const MARKER = 'C:\\userData\\coal-backfill-v1.json'
const CLAUDE_ROOT = 'C:/home/.claude'
const CODEX_ROOT = 'C:/home/.codex/sessions'

/** Deterministic marker filesystem, mirroring the store's read/write/rename port. */
function markerFs(
  seed: Record<string, string> = {}
): LedgerFsLike & { files: Map<string, string> } {
  const files = new Map(Object.entries(seed))
  return {
    files,
    async readFile(path) {
      const content = files.get(path)
      if (content === undefined) throw new Error(`ENOENT ${path}`)
      return content
    },
    async writeFile(path, data) {
      files.set(path, data)
    },
    async rename(from, to) {
      const content = files.get(from)
      if (content === undefined) throw new Error(`ENOENT ${from}`)
      files.delete(from)
      files.set(to, content)
    }
  }
}

/** A historical Claude transcript for `cwd` that ended having burned `tokens`. */
function claudeTranscript(cwd: string, tokens: number, at = LONG_AGO): string {
  return [
    JSON.stringify({
      type: 'user',
      message: {},
      timestamp: new Date(at - 1_000).toISOString(),
      cwd
    }),
    JSON.stringify({
      type: 'assistant',
      message: { usage: { output_tokens: tokens } },
      timestamp: new Date(at).toISOString(),
      cwd
    })
  ].join('\n')
}

/** A historical Codex rollout for `cwd` whose running total reached `tokens`. */
function codexRollout(cwd: string, tokens: number, at = LONG_AGO): string {
  return [
    JSON.stringify({
      timestamp: new Date(at - 2_000).toISOString(),
      type: 'session_meta',
      payload: { id: 'thread-1', cwd }
    }),
    JSON.stringify({
      timestamp: new Date(at).toISOString(),
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { total_tokens: tokens } } }
    })
  ].join('\n')
}

interface Harness {
  fs: FakeFs
  marker: ReturnType<typeof markerFs>
  credits: { mineId: string; tokens: number }[]
  run: (overrides?: Partial<CoalBackfillOptions>) => ReturnType<typeof runCoalBackfill>
}

function harness(seedMarker: Record<string, string> = {}): Harness {
  const fs = new FakeFs()
  const marker = markerFs(seedMarker)
  const credits: { mineId: string; tokens: number }[] = []
  return {
    fs,
    marker,
    credits,
    run: (overrides = {}) =>
      runCoalBackfill({
        fs,
        markerFs: marker,
        markerPath: MARKER,
        claudeRoots: [CLAUDE_ROOT],
        codexSessionsRoot: CODEX_ROOT,
        credit: (mineId, tokens) => credits.push({ mineId, tokens }),
        now: () => NOW,
        platform: 'win32',
        ...overrides
      })
  }
}

/** Total coal credited to one project path across the whole run. */
function creditedTo(h: Harness, cwd: string): number {
  const id = mineIdForPath(cwd, 'win32')
  return h.credits.filter((c) => c.mineId === id).reduce((sum, c) => sum + c.tokens, 0)
}

describe('runCoalBackfill — Claude history', () => {
  it('credits a pre-install transcript as coal on its own project', async () => {
    const h = harness()
    h.fs.addFile(
      `${CLAUDE_ROOT}/projects/C--Users-j-Proj/sess-1.jsonl`,
      claudeTranscript('C:\\Users\\j\\Proj', 4_000),
      LONG_AGO
    )

    const result = await h.run()

    expect(creditedTo(h, 'C:\\Users\\j\\Proj')).toBe(4_000)
    expect(result.done).toBe(true)
  })

  it('sums several historical sessions of one project into one mine', async () => {
    const h = harness()
    const dir = `${CLAUDE_ROOT}/projects/C--Users-j-Proj`
    h.fs.addFile(`${dir}/sess-1.jsonl`, claudeTranscript('C:\\Users\\j\\Proj', 1_000), LONG_AGO)
    h.fs.addFile(`${dir}/sess-2.jsonl`, claudeTranscript('C:\\Users\\j\\Proj', 2_500), LONG_AGO)

    await h.run()
    expect(creditedTo(h, 'C:\\Users\\j\\Proj')).toBe(3_500)
  })

  it('credits the mine id live aggregation would give the same project', async () => {
    const h = harness()
    h.fs.addFile(
      `${CLAUDE_ROOT}/projects/whatever-lossy-name/sess-1.jsonl`,
      // The directory name is a lossy encoding; the cwd INSIDE the file rules.
      claudeTranscript('C:\\Users\\j\\Real-Project', 900),
      LONG_AGO
    )
    await h.run()
    expect(h.credits[0]!.mineId).toBe(mineIdForPath('C:\\Users\\j\\Real-Project', 'win32'))
  })

  it('scans every configured Claude root', async () => {
    const h = harness()
    h.fs.addFile(`${CLAUDE_ROOT}/projects/a/s.jsonl`, claudeTranscript('C:\\A', 100), LONG_AGO)
    h.fs.addFile(
      'C:/home/.claude-work/projects/b/s.jsonl',
      claudeTranscript('C:\\B', 200),
      LONG_AGO
    )

    await h.run({ claudeRoots: [CLAUDE_ROOT, 'C:/home/.claude-work'] })

    expect(creditedTo(h, 'C:\\A')).toBe(100)
    expect(creditedTo(h, 'C:\\B')).toBe(200)
  })
})

describe('runCoalBackfill — Codex history', () => {
  it('credits a pre-install rollout as coal', async () => {
    const h = harness()
    h.fs.addFile(
      `${CODEX_ROOT}/2026/01/01/rollout-2026-01-01T10-00-00-abc.jsonl`,
      codexRollout('C:\\Users\\j\\Codexed', 7_000),
      LONG_AGO
    )
    await h.run()
    expect(creditedTo(h, 'C:\\Users\\j\\Codexed')).toBe(7_000)
  })

  it('walks the year/month/day layout across several days', async () => {
    const h = harness()
    h.fs.addFile(`${CODEX_ROOT}/2026/01/01/rollout-a.jsonl`, codexRollout('C:\\P', 100), LONG_AGO)
    h.fs.addFile(`${CODEX_ROOT}/2026/02/14/rollout-b.jsonl`, codexRollout('C:\\P', 250), LONG_AGO)
    await h.run()
    expect(creditedTo(h, 'C:\\P')).toBe(350)
  })

  it('ignores files that are not rollouts', async () => {
    const h = harness()
    h.fs.addFile(`${CODEX_ROOT}/2026/01/01/notes.jsonl`, codexRollout('C:\\P', 999), LONG_AGO)
    await h.run()
    expect(h.credits).toEqual([])
  })

  it('ignores directory names that are not a date layout', async () => {
    const h = harness()
    h.fs.addFile(
      `${CODEX_ROOT}/archive/old/stuff/rollout-a.jsonl`,
      codexRollout('C:\\P', 5),
      LONG_AGO
    )
    await h.run()
    expect(h.credits).toEqual([])
  })
})

describe('runCoalBackfill — the install boundary', () => {
  it('never credits a file written at or after the install moment', async () => {
    // Those tokens belong to live accrual; crediting them here would count
    // the same work twice, once as coal and once as ore.
    const h = harness()
    h.fs.addFile(
      `${CLAUDE_ROOT}/projects/p/live.jsonl`,
      claudeTranscript('C:\\Live', 5_000, NOW + 1_000),
      NOW + 1_000
    )
    await h.run()
    expect(h.credits).toEqual([])
  })

  it('never credits a file whose newest record post-dates the install moment', async () => {
    // An old mtime is not proof: a session that spans the install must not be
    // swallowed whole into history.
    const h = harness()
    h.fs.addFile(
      `${CLAUDE_ROOT}/projects/p/spanning.jsonl`,
      claudeTranscript('C:\\Spanning', 5_000, NOW + 60_000),
      LONG_AGO
    )
    await h.run()
    expect(h.credits).toEqual([])
  })

  it('records the install moment on the first run and reuses it later', async () => {
    const h = harness()
    h.fs.addFile(`${CLAUDE_ROOT}/projects/p/a.jsonl`, claudeTranscript('C:\\A', 10), LONG_AGO)
    await h.run({ maxFiles: 1 })
    const stored = JSON.parse(h.marker.files.get(MARKER)!)
    expect(stored.installedAt).toBe(NOW)

    // A later launch must measure history against the ORIGINAL install moment,
    // not against its own clock, or the boundary would creep forward forever.
    await h.run({ now: () => NOW + 86_400_000 })
    expect(JSON.parse(h.marker.files.get(MARKER)!).installedAt).toBe(NOW)
  })
})

describe('runCoalBackfill — runs once', () => {
  it('marks itself done and credits nothing on the next launch', async () => {
    const h = harness()
    h.fs.addFile(`${CLAUDE_ROOT}/projects/p/a.jsonl`, claudeTranscript('C:\\A', 3_000), LONG_AGO)

    const first = await h.run()
    expect(first.ran).toBe(true)
    expect(creditedTo(h, 'C:\\A')).toBe(3_000)

    h.credits.length = 0
    const second = await h.run()

    expect(second.ran).toBe(false)
    expect(h.credits).toEqual([])
  })

  it('marks itself done even when there is no history at all', async () => {
    const h = harness()
    const result = await h.run()
    expect(result.done).toBe(true)
    expect(JSON.parse(h.marker.files.get(MARKER)!).done).toBe(true)
  })

  it('does not re-read the trees once done', async () => {
    const h = harness()
    h.fs.addFile(`${CLAUDE_ROOT}/projects/p/a.jsonl`, claudeTranscript('C:\\A', 10), LONG_AGO)
    await h.run()

    const reads: string[] = []
    h.fs.onBeforeRead = async (path) => {
      reads.push(path)
    }
    await h.run()
    expect(reads).toEqual([])
  })

  it('treats a corrupt marker as a first run rather than crashing', async () => {
    const h = harness({ [MARKER]: '{ truncated' })
    h.fs.addFile(`${CLAUDE_ROOT}/projects/p/a.jsonl`, claudeTranscript('C:\\A', 42), LONG_AGO)
    await expect(h.run()).resolves.toMatchObject({ ran: true })
    expect(creditedTo(h, 'C:\\A')).toBe(42)
  })

  it('treats a marker from a future version as a first run', async () => {
    const h = harness({
      [MARKER]: JSON.stringify({
        version: COAL_BACKFILL_VERSION + 1,
        installedAt: LONG_AGO,
        credited: [],
        done: true
      })
    })
    h.fs.addFile(`${CLAUDE_ROOT}/projects/p/a.jsonl`, claudeTranscript('C:\\A', 42), LONG_AGO)
    expect((await h.run()).ran).toBe(true)
  })
})

describe('runCoalBackfill — bounded and resumable', () => {
  it('stops at the file budget and reports itself unfinished', async () => {
    const h = harness()
    for (let i = 0; i < 6; i++) {
      h.fs.addFile(
        `${CLAUDE_ROOT}/projects/p${i}/a.jsonl`,
        claudeTranscript(`C:\\P${i}`, 100),
        LONG_AGO
      )
    }

    const result = await h.run({ maxFiles: 2 })

    expect(result.done).toBe(false)
    expect(JSON.parse(h.marker.files.get(MARKER)!).done).toBe(false)
    expect(h.credits.length).toBeLessThan(6)
  })

  it('resumes where it stopped and never credits a project twice', async () => {
    const h = harness()
    for (let i = 0; i < 6; i++) {
      h.fs.addFile(
        `${CLAUDE_ROOT}/projects/p${i}/a.jsonl`,
        claudeTranscript(`C:\\P${i}`, 100),
        LONG_AGO
      )
    }

    // Drain over several bounded runs, exactly as successive launches would.
    for (let attempt = 0; attempt < 10; attempt++) {
      const result = await h.run({ maxFiles: 2 })
      if (result.done) break
    }

    for (let i = 0; i < 6; i++) expect(creditedTo(h, `C:\\P${i}`)).toBe(100)
    expect(h.credits).toHaveLength(6)
    expect(JSON.parse(h.marker.files.get(MARKER)!).done).toBe(true)
  })

  it('stops at the time budget', async () => {
    const h = harness()
    for (let i = 0; i < 6; i++) {
      h.fs.addFile(
        `${CLAUDE_ROOT}/projects/p${i}/a.jsonl`,
        claudeTranscript(`C:\\P${i}`, 100),
        LONG_AGO
      )
    }
    // A clock that jumps a second per reading exhausts any real budget fast.
    let tick = 0
    const result = await h.run({ now: () => NOW + tick++ * 1_000, maxDurationMs: 2_000 })
    expect(result.done).toBe(false)
  })

  it('always finishes at least one project, so a tight budget still progresses', async () => {
    // A run that completes no unit would mark nothing credited and the scan
    // could never finish, however many times the app was launched.
    const h = harness()
    h.fs.addFile(`${CLAUDE_ROOT}/projects/p0/a.jsonl`, claudeTranscript('C:\\P0', 100), LONG_AGO)
    h.fs.addFile(`${CLAUDE_ROOT}/projects/p1/a.jsonl`, claudeTranscript('C:\\P1', 100), LONG_AGO)

    await h.run({ maxFiles: 0, maxDurationMs: 0 })
    expect(h.credits).toHaveLength(1)
  })

  it('caps how many files it reads inside one enormous project directory', async () => {
    const h = harness()
    for (let i = 0; i < 20; i++) {
      h.fs.addFile(
        `${CLAUDE_ROOT}/projects/huge/s${i}.jsonl`,
        claudeTranscript('C:\\Huge', 100),
        LONG_AGO
      )
    }
    await h.run({ maxFilesPerDir: 5 })
    expect(creditedTo(h, 'C:\\Huge')).toBe(500)
  })

  it('forgets the credited list once the scan is finished, keeping the marker small', async () => {
    const h = harness()
    h.fs.addFile(`${CLAUDE_ROOT}/projects/p/a.jsonl`, claudeTranscript('C:\\A', 10), LONG_AGO)
    await h.run()
    expect(JSON.parse(h.marker.files.get(MARKER)!).credited).toEqual([])
  })

  it('writes the marker through a temp file and leaves no stray behind', async () => {
    const h = harness()
    await h.run()
    expect([...h.marker.files.keys()]).toEqual([MARKER])
  })
})

describe('runCoalBackfill — failure tolerance', () => {
  it('keeps going when one transcript cannot be read', async () => {
    const h = harness()
    h.fs.addFile(`${CLAUDE_ROOT}/projects/bad/a.jsonl`, claudeTranscript('C:\\Bad', 100), LONG_AGO)
    h.fs.addFile(
      `${CLAUDE_ROOT}/projects/good/a.jsonl`,
      claudeTranscript('C:\\Good', 300),
      LONG_AGO
    )
    h.fs.onBeforeRead = async (path) => {
      if (path.includes('bad')) throw new Error('EACCES')
    }

    await h.run()
    expect(creditedTo(h, 'C:\\Good')).toBe(300)
  })

  it('resolves without throwing when the marker cannot be written', async () => {
    // A backfill that cannot record itself must not take the app down with it.
    const h = harness()
    h.marker.writeFile = async () => {
      throw new Error('EACCES')
    }
    h.fs.addFile(`${CLAUDE_ROOT}/projects/p/a.jsonl`, claudeTranscript('C:\\A', 10), LONG_AGO)
    await expect(h.run()).resolves.toBeDefined()
  })

  it('credits nothing when neither tree exists', async () => {
    const h = harness()
    const result = await h.run({ claudeRoots: ['C:/nope'], codexSessionsRoot: 'C:/also-nope' })
    expect(result.done).toBe(true)
    expect(h.credits).toEqual([])
  })
})

/**
 * Historical coal is credited by transcript cwd and live ore by mine id, so
 * both have to agree about which folder is the project (#348). A worktree's
 * history that landed under its own mine id would never appear beside the live
 * mine and would silently vanish from the per-mine view.
 */
describe('runCoalBackfill — worktrees (#348)', () => {
  const ROOT = 'C:\\Code\\Anvil'
  const FORGE = 'C:\\Code\\Anvil-worktrees\\forge'

  function withRepo(h: Harness): void {
    h.fs.addFile('C:/Code/Anvil/.git/HEAD', 'ref: refs/heads/main\n')
    h.fs.addFile(
      'C:/Code/Anvil-worktrees/forge/.git',
      'gitdir: C:/Code/Anvil/.git/worktrees/forge\n'
    )
    h.fs.addFile('C:/Code/Anvil/.git/worktrees/forge/commondir', '../..\n')
    h.fs.addFile('C:/Code/Anvil/.git/worktrees/forge/HEAD', 'ref: refs/heads/feat/forge\n')
  }

  it('credits a worktree s history to the project, under the live mine s id', async () => {
    const h = harness()
    withRepo(h)
    h.fs.addFile(
      `${CLAUDE_ROOT}/projects/C--Code-Anvil-worktrees-forge/sess-1.jsonl`,
      claudeTranscript(FORGE, 4_000),
      LONG_AGO
    )

    await h.run()

    expect(creditedTo(h, ROOT)).toBe(4_000)
    expect(creditedTo(h, FORGE)).toBe(0)
  })

  it('sums a project s own history and its worktrees into one mine', async () => {
    const h = harness()
    withRepo(h)
    h.fs.addFile(
      `${CLAUDE_ROOT}/projects/C--Code-Anvil/sess-1.jsonl`,
      claudeTranscript(ROOT, 1_000),
      LONG_AGO
    )
    h.fs.addFile(
      `${CLAUDE_ROOT}/projects/C--Code-Anvil-worktrees-forge/sess-2.jsonl`,
      claudeTranscript(FORGE, 2_500),
      LONG_AGO
    )

    await h.run()

    // One mine, one count. Nothing was converted and nothing crossed a
    // material; only which mine the tokens belong to changed.
    expect(creditedTo(h, ROOT)).toBe(3_500)
  })
})
