import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NodeFs } from '../../adapters/fsLike'
import { isCodexProcessRunning } from '../../adapters/processProbe'
import { NodeSqlite } from '../../adapters/sqliteLike'
import { defaultConfig } from '../../config'
import { CodexProvider } from './codexProvider'

/**
 * Opt-in real-machine checks (RUN_INTEGRATION=1 pnpm test) per the project's
 * "integration tests opt-in" convention — these touch the real filesystem
 * and the real Codex sessions root, so they are excluded from the default
 * deterministic `pnpm test` run.
 */
describe.skipIf(process.env.RUN_INTEGRATION !== '1')('CodexProvider real-machine checks', () => {
  it('reports what the provider detects right now against the real ~/.codex', async () => {
    const config = defaultConfig()
    const provider = new CodexProvider({
      fs: new NodeFs(),
      sessionsRoot: join(homedir(), '.codex', 'sessions'),
      livenessWindowS: config.codexLivenessWindowS,
      scanDays: config.codexScanDays,
      idleRetentionS: config.codexIdleRetentionS,
      heartbeatWindowS: config.codexHeartbeatWindowS,
      sqlite: new NodeSqlite(),
      stateDbPath: join(homedir(), '.codex', 'state_5.sqlite'),
      logsDbPath: join(homedir(), '.codex', 'logs_2.sqlite')
    })

    const snapshots = await provider.scan()
    console.log('[integration] isCodexProcessRunning():', await isCodexProcessRunning())
    console.log(
      '[integration] real ~/.codex scan result:',
      JSON.stringify(
        snapshots.map((s) => ({
          sessionId: s.sessionId,
          cwd: s.cwd,
          status: s.status,
          updatedAt: new Date(s.updatedAt).toISOString(),
          dwarfs: s.dwarfs.map((d) => ({
            id: d.id,
            role: d.role,
            status: d.status,
            model: d.model,
            effort: d.effort,
            tokensUsed: d.tokensUsed
          }))
        })),
        null,
        2
      )
    )
    // Real-machine invariants on whatever this scan actually found — an empty
    // result (no active Codex session right now) is a legitimate outcome, so
    // this only checks the shape of what comes back, not that anything does.
    for (const snapshot of snapshots) {
      expect(snapshot.provider).toBe('codex')
      expect(snapshot.sessionId.length).toBeGreaterThan(0)
      expect(['busy', 'idle']).toContain(snapshot.status)
      expect(Array.isArray(snapshot.dwarfs)).toBe(true)
      // busy <=> exactly one dwarf (the main session thread); idle <=> none.
      expect(snapshot.dwarfs).toHaveLength(snapshot.status === 'busy' ? 1 : 0)
      expect(snapshot.updatedAt).toBeLessThanOrEqual(Date.now())
      for (const dwarf of snapshot.dwarfs) {
        expect(dwarf.id).toBe(`codex:${snapshot.sessionId}`)
        expect(dwarf.status).toBe('working')
      }
    }
  })

  it('reads the real Codex registry read-only through node:sqlite', async () => {
    // Guards the whole premise of issue #1's fix: node:sqlite must be able to
    // open Codex's live WAL databases with no native dependency.
    const db = await new NodeSqlite().openReadOnly(join(homedir(), '.codex', 'state_5.sqlite'))
    if (db === null) {
      console.log('[integration] no state_5.sqlite on this machine — registry discovery disabled')
      return
    }
    try {
      const rows = db.all('SELECT count(*) AS n FROM threads')
      console.log('[integration] state_5.sqlite threads row count:', JSON.stringify(rows))
      expect(rows).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  describe('synthetic large-turn rollout (bug: task_started pushed out of a small tail read)', () => {
    let scratchRoot: string

    beforeAll(async () => {
      scratchRoot = await mkdtemp(join(tmpdir(), 'agent-name-codex-scratch-'))
    })

    afterAll(async () => {
      await rm(scratchRoot, { recursive: true, force: true })
    })

    it('shows a busy mine with a working dwarf once written to CODEX_SESSIONS_ROOT', async () => {
      // session_meta + turn_context shape captured from an actual rollout on
      // this machine (2026-08-29, agent-name project) — trimmed of the long
      // base_instructions/developer_instructions text (irrelevant to parsing)
      // but keeping every field name the parser reads. The provider below
      // gets no `now` override, so it resolves "today" from the real clock —
      // every date here is computed relative to that same real `now` instead
      // of a fixed calendar date, so this stays valid regardless of when the
      // suite actually runs.
      const now = new Date()
      const isoNow = now.toISOString()
      const isoSlightlyLater = new Date(now.getTime() + 2_000).toISOString()
      const isoLater = new Date(now.getTime() + 30_000).toISOString()
      const year = String(now.getFullYear())
      const month = String(now.getMonth() + 1).padStart(2, '0')
      const day = String(now.getDate()).padStart(2, '0')
      const hour = String(now.getHours()).padStart(2, '0')
      const minute = String(now.getMinutes()).padStart(2, '0')
      const second = String(now.getSeconds()).padStart(2, '0')

      const realSessionMeta = JSON.stringify({
        timestamp: isoNow,
        type: 'session_meta',
        payload: {
          session_id: '01a04d79-real-0000-0000-000000000000',
          id: '01a04d79-real-0000-0000-000000000000',
          cwd: 'C:\\Users\\jeron\\Desktop\\AI-Tools\\agent-name',
          originator: 'codex-tui',
          cli_version: '0.150.1',
          source: 'cli',
          model_provider: 'openai'
        }
      })
      const realTurnContext = JSON.stringify({
        timestamp: isoSlightlyLater,
        type: 'turn_context',
        payload: {
          turn_id: 'still-open-turn',
          cwd: 'C:\\Users\\jeron\\Desktop\\AI-Tools\\agent-name',
          model: 'gpt-5.6-sol',
          effort: 'high',
          summary: 'auto'
        }
      })
      const taskStarted = JSON.stringify({
        timestamp: isoSlightlyLater,
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'still-open-turn' }
      })
      // A large in-progress body (tool output/reasoning) with NO task_complete
      // yet — reproduces the real observed gap (347,167 bytes on this
      // machine) between task_started and its eventual task_complete.
      const largeBody = JSON.stringify({
        timestamp: isoLater,
        type: 'response_item',
        payload: { type: 'reasoning', encrypted_content: 'x'.repeat(300_000) }
      })

      const dir = join(scratchRoot, year, month, day)
      await mkdir(dir, { recursive: true })
      const file = join(
        dir,
        `rollout-${year}-${month}-${day}T${hour}-${minute}-${second}-01a04d79-real-0000-0000-000000000000.jsonl`
      )
      await writeFile(
        file,
        [realSessionMeta, realTurnContext, taskStarted, largeBody].join('\n') + '\n',
        'utf8'
      )

      const config = defaultConfig()
      const provider = new CodexProvider({
        fs: new NodeFs(),
        sessionsRoot: scratchRoot,
        livenessWindowS: config.codexLivenessWindowS,
        scanDays: config.codexScanDays,
        idleRetentionS: config.codexIdleRetentionS
      })
      const snapshots = await provider.scan()
      console.log(
        '[integration] synthetic large-turn scan result:',
        JSON.stringify(snapshots, null, 2)
      )

      expect(snapshots).toHaveLength(1)
      expect(snapshots[0]).toMatchObject({
        cwd: 'C:\\Users\\jeron\\Desktop\\AI-Tools\\agent-name',
        status: 'busy'
      })
      expect(snapshots[0]!.dwarfs).toHaveLength(1)
      expect(snapshots[0]!.dwarfs[0]).toMatchObject({ status: 'working', model: 'gpt-5.6-sol' })
    })
  })
})
