// layer: L2
// L2 (17 §1.2): the OpenCode plugin's asking open route as the Host composes it (ADR-011 item 7;
// ADR-016 items 1, 4; 08 §4): the integration gate on an observed OpenCode session's capabilities,
// and an accepted plugin report resolved to its dwarf and folder through observation's index.
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import type { DwarfId, IntegrationState, ProviderId } from '../../kernel/domain/values'
import type { AskCapabilities, AskRecord } from '../../modules/asking'
import type { ObservedSession } from '../../modules/observation'
import type { AskInput } from '../../modules/suppliers'
import { wireOpenCodePluginAsking } from './asking'

const OPENCODE = 'opencode' as ProviderId
const DWARF = '00000000-0000-7000-8000-0000000229b1' as DwarfId

/** OpenCode's observed declaration (observation's OpenCode adapter): no answer path. */
const DECLARED: AskCapabilities = {
  permission: 'none',
  question: 'none',
  observedPermission: 'none',
  observedQuestion: 'none'
}

function world() {
  let state: IntegrationState = 'off'
  const clock = new FakeClock(1_790_000_000_000)
  const opened: Array<{ dwarfId: string; input: AskInput }> = []
  const identities: unknown[] = []
  const wired = wireOpenCodePluginAsking({
    providerId: OPENCODE,
    sessions: {
      byIdentity: (identity) => {
        identities.push(identity)
        return identity.providerSessionId === 'ses-1'
          ? ({ dwarfId: DWARF, cwd: '/home/j/mine' } as ObservedSession)
          : null
      }
    },
    asks: {
      open: (dwarfId, input) => {
        opened.push({ dwarfId, input })
        return {} as AskRecord
      }
    },
    preferences: {
      queries: { integrationState: () => state },
      channelTokens: { active: () => null }
    },
    observation: { nudge: () => undefined },
    secrets: { read: () => Promise.resolve(null) },
    post: () => Promise.resolve({ status: 200, text: () => Promise.resolve('true') }),
    scheduler: new FakeScheduler(clock),
    redact: (text) => text,
    log: new RecordingDiagnosticsLog()
  })
  return {
    wired,
    opened,
    identities,
    setState: (next: IntegrationState) => {
      state = next
    }
  }
}

describe('the OpenCode plugin asking open route (ADR-011 item 7)', () => {
  it('[C-27, ADR-011] an observed OpenCode session reads an interactive, detected permission only while opencode-permissions is on-verified', () => {
    const w = world()

    for (const state of ['off', 'on-unverified'] as const) {
      w.setState(state)
      expect(w.wired.observedCapabilities(OPENCODE, DECLARED)).toStrictEqual(DECLARED)
    }
    w.setState('on-verified')
    expect(w.wired.observedCapabilities(OPENCODE, DECLARED)).toStrictEqual({
      permission: 'interactive',
      question: 'none',
      observedPermission: 'detected',
      observedQuestion: 'none'
    })
    // Another provider's session is never raised by the OpenCode plugin.
    expect(w.wired.observedCapabilities('codex' as ProviderId, DECLARED)).toStrictEqual(DECLARED)
  })

  it('[ADR-016] a permission report is resolved through the OpenCode identity to its dwarf and opens on the http channel; a reply report opens nothing', () => {
    const w = world()

    w.wired.evidence.accept({
      kind: 'permission.replied',
      sessionId: 'ses-1',
      requestId: 'per-1'
    })
    expect(w.opened).toStrictEqual([])

    w.wired.evidence.accept({
      kind: 'permission.asked',
      sessionId: 'ses-1',
      requestId: 'per-1',
      permission: 'edit',
      patterns: ['a.txt'],
      serverOrigin: 'http://127.0.0.1:4096'
    })

    expect(w.identities).toStrictEqual([{ providerId: OPENCODE, providerSessionId: 'ses-1' }])
    expect(w.opened.map(({ dwarfId, input }) => [dwarfId, input.channel])).toStrictEqual([
      [DWARF, 'http']
    ])
  })
})
