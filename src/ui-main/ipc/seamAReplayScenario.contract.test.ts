// layer: L6
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHANNELS, type ChannelKey } from '@dwarfai/contracts'
// AMENDED for ISSUE-123 (was: the release table `ROUTES` / `ROUTES_RELEASE`): the replay is cut 0's exit evidence (21 §2
// cut 0 "Exit criteria"), so it covers the cut-0 table as it shipped, whatever the release.
import { ROUTES as RELEASE_ROUTES } from './routes'
import { CUT_0_TABLE } from './testing/cut0Routes'

const ROUTES = CUT_0_TABLE.routes
const ROUTES_RELEASE = CUT_0_TABLE.release

/**
 * The legacy seam-A replay's scenario covers the table it proves (21 §2 note 1; TC-056-02): every row the cut-0 table
 * serves `legacy` is called (or, for a push, listened to) through its own `window.api` member, so the replay of
 * `e2e/cut-0/seam-a-replay.e2e.ts` compares every legacy row and nothing else.
 */
const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..')

interface Scenario {
  calls: Array<{ channel: string; member: string }>
  pushes: Array<{ channel: string; member: string }>
}
const scenario = JSON.parse(
  readFileSync(
    resolve(REPO_ROOT, 'fixtures/ipc/seam-a-replay', ROUTES_RELEASE, 'scenario.json'),
    'utf8'
  )
) as Scenario

/** Each registry row's `window.api` member, as the generated preload documents it (`/** A-nn · \`wire\` · …`). */
function preloadMembers(): Map<string, string> {
  const preload = readFileSync(resolve(REPO_ROOT, 'src/preload/index.ts'), 'utf8')
  const members = new Map<string, string>()
  for (const match of preload.matchAll(/\/\*\* [^·\n]+ · `([^`]+)` · [^\n]*\*\/\n\s+(\w+)/g)) {
    members.set(match[1] ?? '', match[2] ?? '')
  }
  return members
}

describe('the legacy seam-A replay scenario (21 §2 note 1)', () => {
  it('[ADR-001] the replay scenario calls every row the cut-0 table serves legacy, each through its own preload member', () => {
    const legacy = ROUTES.filter((route) => route.owner === 'legacy').map((route) => route.channel)
    const called = new Set([...scenario.calls, ...scenario.pushes].map((entry) => entry.channel))
    expect([...legacy].sort()).toEqual([...called].sort())

    // A-44 is spoken on its today wire `panel:openMine`; every other row on its registry key.
    const members = preloadMembers()
    const todayWire: Partial<Record<ChannelKey, string>> = {
      'presence:visibleMines': 'panel:openMine'
    }
    // AMENDED for ISSUE-123 (was: every entry): the generated preload is the release's, so only a row the release still
    // speaks with today's shape is looked up in it; a row a later cut moved spoke its cut-0 member in the cut-0 build.
    const spokenToday = new Set(
      RELEASE_ROUTES.filter((route) => route.shape === 'today').map((route) => route.channel)
    )
    for (const entry of [...scenario.calls, ...scenario.pushes]) {
      const key = entry.channel as ChannelKey
      expect(CHANNELS[key], entry.channel).toBeDefined()
      if (!spokenToday.has(key)) continue
      expect(members.get(todayWire[key] ?? key), entry.channel).toBe(entry.member)
    }
    // A push row is listened to, never called; every other row is called.
    for (const push of scenario.pushes) {
      expect(CHANNELS[push.channel as ChannelKey].kind, push.channel).toBe('push')
    }
    for (const call of scenario.calls) {
      expect(CHANNELS[call.channel as ChannelKey].kind, call.channel).not.toBe('push')
    }
  })
})
