// Mines driven port (05 §3.1, 16 §4.1 row `GitHeadWatchPort`), by ADR-030 item 3's name and shape.
// Volatile: it drives the worktree chip (AQ-06). Filesystem only, never the git binary (18 T-34);
// the `HEAD` file is re-read when its mtime changes, so a branch switch shows within one poll of a
// watched dwarf (ADR-030 item 4). Adapter: FsGitRepoInspector.

export interface GitHeadWatchPort {
  // volatile; drives the chip
  head(cwd: string): Promise<GitHead>
}

export type GitHead =
  | { kind: 'none' } // not inside a repository
  | { kind: 'branch'; name: string } // e.g. 'feat/ore-ledger'
  | { kind: 'detached'; shortSha: string }
