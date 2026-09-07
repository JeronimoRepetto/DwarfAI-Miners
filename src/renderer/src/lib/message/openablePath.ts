import type { FeedActivity } from '../../types'

/**
 * Which activity kinds name a FILE this panel may offer to open (#279) — a
 * path, never a command or a search pattern. `screens/mine.md`'s amendment:
 * only `Edited <path>` and `Read <path>` lines become clickable; `Ran
 * <command>` and `Searched <pattern>` stay exactly the plain text #240 drew.
 */
const OPENABLE_ACTIVITY_KINDS: ReadonlySet<FeedActivity['kind']> = new Set(['edit', 'read'])

/**
 * Whether one row's activity is a path this panel may offer to open — the
 * one decision both panel components branch on, so `run` and `search` cannot
 * drift into "openable" in one panel and not the other.
 */
export function isOpenablePath(activity: FeedActivity | undefined): boolean {
  return activity !== undefined && OPENABLE_ACTIVITY_KINDS.has(activity.kind)
}
