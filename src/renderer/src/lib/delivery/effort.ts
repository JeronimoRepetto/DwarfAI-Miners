import type { DwarfObserver } from '../../types'

/**
 * Display labels for Claude Code's closed set of named effort levels. Codex's
 * reasoning_effort values (and anything a future provider reports) have no
 * shared vocabulary to translate into yet, so they pass through unchanged.
 */
const CLAUDE_EFFORT_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max'
}

/**
 * Normalize a raw effort value for display, per observer. Pure and TDD'd.
 *
 * Takes the OBSERVER rather than a provider (#194) because every dwarf on the
 * board carries one, and a dwarf this panel is holding itself has no effort at
 * all — nothing reports one for a process with no transcript. It therefore
 * answers 'unknown' through the same absent-effort arm every other observer
 * does, rather than needing a case of its own.
 */
export function describeEffort(provider: DwarfObserver, effort: string | undefined): string {
  if (effort === undefined) return 'unknown'
  if (provider === 'claude') return CLAUDE_EFFORT_LABELS[effort] ?? effort
  return effort
}
