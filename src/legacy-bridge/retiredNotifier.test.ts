// layer: L7 (the static bridge check)
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The cut-1 notifier retirement (ISSUE-125; 21 §2 cut 1 "Retired at the end"; ADR-018 items 1, 7): today's notifier
 * (`notifyDecision` → Electron `Notification`) is no longer composed by the bridges whatever the route table, so the
 * Host's attention policy is the only way to an OS notification. The `notifications/*` files stay until cut 5.
 */
const BRIDGES = resolve(import.meta.dirname)

/** Every production file under src/legacy-bridge (a test may still read a legacy module to prove a behaviour). */
function productionFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(folder, entry.name)
    if (entry.isDirectory()) return productionFiles(path)
    return /\.ts$/.test(entry.name) && !/\.(test|contract)\.ts$/.test(entry.name) ? [path] : []
  })
}

describe('cut-1 notifier retirement (21 §2 cut 1)', () => {
  it('[ADR-018] no file under src/legacy-bridge constructs the legacy notifyDecision fold or an Electron Notification', () => {
    const files = productionFiles(BRIDGES)
    expect(files.length).toBeGreaterThan(0)
    const constructors = files.flatMap((path) => {
      const source = readFileSync(path, 'utf8')
      const name = path
        .slice(BRIDGES.length + 1)
        .split('\\')
        .join('/')
      return [
        /from '(\.\.\/)+main\/notifications\/(notifier|notifyDecision|electronNotifications)'/.test(
          source
        )
          ? [`${name} imports today's notifier`]
          : [],
        /\bnew\s+Notification\b/.test(source) ? [`${name} constructs a Notification`] : []
      ].flat()
    })
    expect(constructors).toEqual([])
  })
  // AMENDED for ISSUE-243 (was: '[ADR-018] a legacy board change that would have notified before produces no OS
  // notification', today's fold over two boards against the pushes `LegacyRuntimeRoute` composed): the route and today's
  // runtime left the tree (21 §2 cut 5), so no legacy board change exists to reach a notification.
})
