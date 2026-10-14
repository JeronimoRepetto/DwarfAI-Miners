// layer: L2
// L2 (17 §1.2): today's Claude hook half as `LegacyRuntimeRoute` composes it on either side of the cut-2 switch (21 §2
// cut 2 "Switched off in legacy"; §1 item 4; §4 row "Claude hook entry"; TC-141-06). With the switch on (the cut-1
// table, or a cut-2 rollback build) today's `HookChannel` is built, so its `restore()` reinstalls the person's opted-in
// Claude hooks, and the shared listener's Claude events reach today's runtime (its observed-Claude permission registry
// and keystroke path). With it off (the cut-2 table) neither happens: no Claude hook entry of today's installer is
// written or restored, and a call from an old-app entry finds no Claude route. The OpenCode plugin's push reaches
// today's runtime either way (its writer moves in 4a). Doubles: a recording `HookChannel` factory and recording sinks.
import { describe, expect, it } from 'vitest'
import type { HookEvent } from '../main/hooks/hookPayload'
import { legacyClaudeHookComposition } from './legacyClaudeHooksSwitch'

const EVENT: HookEvent = {
  provider: 'claude',
  event: 'Notification',
  sessionId: 'session-1',
  notificationType: 'permission_prompt'
}

function world(claudeHooks: boolean) {
  const noted: HookEvent[] = []
  const built: string[] = []
  const claude = legacyClaudeHookComposition(claudeHooks, {
    onHookEvent: (event) => void noted.push(event),
    hookChannel: () => {
      built.push('HookChannel')
      return { restore: () => Promise.resolve(null) }
    }
  })
  return { claude, noted, built }
}

describe('legacy Claude hook switch (21 §2 cut 2)', () => {
  it('[ADR-016, ADR-001] with A-40 and A-41 on their cut-2 routes today’s Claude hook channel is not built and its listener drops Claude events', () => {
    const { claude, noted, built } = world(false)
    expect(claude.hooks).toBeNull()
    expect(built).toEqual([])
    claude.onEvent(EVENT)
    expect(noted).toEqual([])
  })

  it('[ADR-016, ADR-001] with A-40 and A-41 on their cut-1 routes today’s Claude hook channel is built and its listener’s Claude events reach today’s runtime', () => {
    const { claude, noted, built } = world(true)
    expect(claude.hooks).not.toBeNull()
    expect(built).toEqual(['HookChannel'])
    claude.onEvent(EVENT)
    expect(noted).toEqual([EVENT])
  })
})
