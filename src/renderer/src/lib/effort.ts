import type { DwarfProvider } from '../types'

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

/** Normalize a raw effort value for display, per provider. Pure and TDD'd. */
export function describeEffort(provider: DwarfProvider, effort: string | undefined): string {
  if (effort === undefined) return 'unknown'
  if (provider === 'claude') return CLAUDE_EFFORT_LABELS[effort] ?? effort
  return effort
}
