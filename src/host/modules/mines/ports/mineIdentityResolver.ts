// Mines driven port (05 §3.1, 16 §4.1 row `MineIdentityResolver`), by ADR-030 item 3's name and
// shape. Stable: it decides which mine a session's cwd belongs to (the worktree fold, INV-03).
// Filesystem only, never the git binary (18 T-34); anything unreadable answers the cwd's own mine
// and never throws; answers are cached 30 s per cwd (ADR-030 item 4). Adapter: FsGitRepoInspector.
import type { DwarfWorkplace } from '../domain/worktreeFold'

export interface MineIdentityResolver {
  // stable; decides the mine
  resolve(cwd: string): Promise<{ mineKey: string; workplace?: DwarfWorkplace }>
}
