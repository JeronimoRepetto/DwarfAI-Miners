// `MinesCommands.resolveForSession` (05 §3.1, §4; 16 §4.1; 06 INV-02, INV-04, INV-07, INV-08,
// INV-39; 07 S3.01…S3.03, S3.19, S3.20; AMENDMENT-2, SC-AR-01): the mine of an observed or
// launched session's cwd. Routed from `SessionObserved` / `SubagentObserved` / `DwarfLaunched`
// (later: ISSUE-093); `firstMessage` is the event's own flag, and a launch always passes `true`.
//
// - The cwd resolves through `MineIdentityResolver` (the worktree fold, INV-03), before the
//   transaction, then the mine is found by its `MinePath` inside it (INV-02).
// - An unknown folder becomes a mine only on the session's first message (INV-04): `unrecorded`,
//   `MineCreated{observed}` (S3.01), or the main tree's mine for a linked worktree,
//   `MineCreated{worktree-fold}` (S3.02). With `firstMessage = false` it answers `{ waiting: true }`
//   and writes nothing (INV-39): no mine, no marker, no dwarf.
// - A removed mine is rediscovered with its id and ledger (S3.19 → `unrecorded`, S3.20 → `active`;
//   `MineReattached{rediscovery}`, INV-07). Whether the session was ended by the terminator
//   (S3.22) is crew's `EndedAgentLedger` question, and this signature carries no identity: it is
//   never asked here (later: ISSUE-093 routes it).
// - A live mine gains the arrival: its recency is refreshed and its id answered. An `unenterable`
//   mine answers its reason and gains no dwarf (INV-08). `checkFolder` for a known mine lands with
//   the folder check (later: ISSUE-085).
// - A created or reattached mine is handed to `remeasure` (ISSUE-065). Events after commit.
import type { FolderPath } from '../../../kernel/domain/values'
import { mineIdOf, openMine, transition, type Mine, type MineStep } from '../domain/mine'
import type { MinePath } from '../domain/minePath'
import {
  mineOf,
  nameOfFolder,
  publishCreated,
  publishReattached,
  type MineCommandDeps,
  type MinesCommands
} from './declare'

type Resolution = Awaited<ReturnType<MinesCommands['resolveForSession']>>

interface Settled {
  readonly answer: Resolution
  readonly mine?: Mine
  readonly created?: boolean
  readonly reattached?: boolean
}

/** `resolveForSession` over `deps`. */
export function createResolveForSession(
  deps: MineCommandDeps
): Pick<MinesCommands, 'resolveForSession'> {
  return {
    async resolveForSession(path, firstMessage) {
      const { mineKey, workplace } = await deps.resolver.resolve(path)
      const key = mineKey as MinePath
      const inLinkedWorktree = workplace !== undefined
      const now = deps.clock.now()
      const name = nameOfFolder(deps, key)
      const settled = deps.transactions.inTransaction((): Settled => {
        const existing = deps.repository.byPath(key as string as FolderPath)
        if (existing === null) {
          if (!firstMessage) return { answer: { waiting: true } }
          const mine = mineOf(
            openMine(
              {
                cause: inLinkedWorktree ? 'worktree-fold' : 'first-message',
                birth: { id: mineIdOf(deps.ids.uuidv7()), path: key, name }
              },
              now
            )
          )
          deps.repository.save(mine)
          return { answer: { mineId: mine.id, created: true }, mine, created: true }
        }
        if (existing.state === 'unenterable') {
          return { answer: { unenterable: existing.unenterableReason ?? '' } }
        }
        const step: MineStep = transition(
          existing,
          { type: 'session-observed', inLinkedWorktree, endedByTerminator: false },
          now
        )
        const mine = mineOf(step)
        deps.repository.save(mine)
        const reattached = step.transition === 'S3.19' || step.transition === 'S3.20'
        return { answer: { mineId: mine.id, created: false }, mine, reattached }
      })
      if (settled.mine !== undefined) {
        if (settled.created === true) {
          publishCreated(deps, settled.mine, inLinkedWorktree ? 'worktree-fold' : 'observed')
        }
        if (settled.reattached === true) publishReattached(deps, settled.mine.id, 'rediscovery')
        if (settled.created === true || settled.reattached === true) {
          deps.remeasure(settled.mine.id)
        }
      }
      return settled.answer
    }
  }
}
