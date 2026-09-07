import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NodeFs } from '../../adapters/fsLike'
import { loadConfig } from '../../config/config'
import { AntigravityProvider } from './antigravityProvider'

/**
 * Opt-in real-machine checks (`RUN_INTEGRATION=1 pnpm test`) per the project's
 * "integration tests opt-in" convention — these touch the real filesystem and
 * the real Antigravity store, so they are excluded from the default
 * deterministic run.
 *
 * They exist because this provider reads a PRIVATE format with no
 * compatibility promise (docs/provider-formats.md §3.1). The unit tests pin
 * the parse against sanitized captures of CLI 1.1.26 and will keep passing
 * forever; this is the one place that can notice the day a newer CLI writes
 * something else. It asserts SHAPE rather than content — a machine with no
 * Antigravity installed is a legitimate result, and the numbers it prints are
 * this machine's and are not expectations.
 */
describe.skipIf(process.env.RUN_INTEGRATION !== '1')(
  'AntigravityProvider real-machine checks',
  () => {
    it('reports what the provider detects right now against the real store', async () => {
      // The machine's own settings rather than the defaults: a real-machine
      // check should honour a real install, and it is how a maintainer widens
      // ANTIGRAVITY_STALE_LOCK_WINDOW_S to look at a conversation that has
      // been quiet for days.
      const config = loadConfig(process.env).providers.antigravity
      const provider = new AntigravityProvider({
        fs: new NodeFs(),
        storeRoot: join(homedir(), '.gemini', 'antigravity-cli'),
        busyWindowS: config.busyWindowS,
        lockGraceS: config.lockGraceS,
        staleLockWindowS: config.staleLockWindowS
      })

      const snapshots = await provider.scan()
      console.log(
        '[integration] real Antigravity scan result:',
        JSON.stringify(
          snapshots.map((snapshot) => ({
            sessionId: snapshot.sessionId,
            status: snapshot.status,
            updatedAt: new Date(snapshot.updatedAt).toISOString(),
            // The cwd is this machine's filesystem and stays out of the log
            // (docs/privacy.md, #59) — its depth is enough to see it resolved.
            cwdSegments: snapshot.cwd.split(/[\\/]+/).length,
            dwarfs: snapshot.dwarfs.map((dwarf) => ({
              id: dwarf.id,
              role: dwarf.role,
              status: dwarf.status,
              hasLastMessage: dwarf.lastMessage !== undefined
            }))
          })),
          null,
          2
        )
      )

      for (const snapshot of snapshots) {
        expect(snapshot.provider).toBe('antigravity')
        expect(snapshot.cwd).not.toBe('')
        // The invariant, asserted against real data rather than a fixture: a
        // session is never reported blocked, because this store proves no block.
        expect(snapshot.status).not.toBe('waiting')
        for (const dwarf of snapshot.dwarfs) {
          expect(dwarf.id).toBe(`antigravity:${snapshot.sessionId}`)
          expect(dwarf.tokensObserved).toBeUndefined()
          expect(dwarf.waitingReason).toBeUndefined()
          expect(dwarf.pid).toBeUndefined()
        }
      }
    })

    it('reads a real conversation both ways round, redacted', async () => {
      // The machine's own settings rather than the defaults: a real-machine
      // check should honour a real install, and it is how a maintainer widens
      // ANTIGRAVITY_STALE_LOCK_WINDOW_S to look at a conversation that has
      // been quiet for days.
      const config = loadConfig(process.env).providers.antigravity
      const provider = new AntigravityProvider({
        fs: new NodeFs(),
        storeRoot: join(homedir(), '.gemini', 'antigravity-cli'),
        busyWindowS: config.busyWindowS,
        lockGraceS: config.lockGraceS,
        staleLockWindowS: config.staleLockWindowS
      })

      const [snapshot] = await provider.scan()
      if (snapshot === undefined) {
        console.log('[integration] no live Antigravity conversation to read')
        return
      }
      const feed = await provider.feed(`antigravity:${snapshot.sessionId}`, 12)
      console.log(
        '[integration] real feed shape:',
        JSON.stringify(feed?.map((message) => ({ role: message.role, chars: message.text.length })))
      )
      for (const message of feed ?? []) {
        expect(['user', 'assistant']).toContain(message.role)
        expect(message.text).not.toBe('')
        // The envelope must never reach a reader: it is the CLI's own
        // bookkeeping, not what a person typed.
        expect(message.text).not.toContain('<USER_REQUEST>')
        expect(message.text).not.toContain('<ADDITIONAL_METADATA>')
      }
    })
  }
)
