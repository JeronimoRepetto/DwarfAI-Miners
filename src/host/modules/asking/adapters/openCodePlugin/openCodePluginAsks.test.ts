// layer: L2
// L2 (17 §1.2): the OpenCode plugin asks (ADR-011 item 7; ADR-016 item 4; 08 §4 "the caller
// resolves SessionRef → dwarfId"): a plugin report becomes one broker `open` on the `http`
// channel, with the address its answer will go to, over a recording broker, a session lookup the
// test scripts, the `FakeScheduler` and a recording log.
import { describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../../../kernel/domain/errors'
import { FakeClock } from '../../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../../../kernel/fakes/RecordingDiagnosticsLog'
import type { DwarfId } from '../../../../kernel/domain/values'
import type { AskInput } from '../../../suppliers'
import type { AskRecord } from '../../domain/ask'
import {
  OPENCODE_REPORT_RETRY_MS,
  OpenCodePluginAsks,
  type OpenCodePermissionReport,
  type OpenCodePluginSession
} from './openCodePluginAsks'

const DWARF = '00000000-0000-7000-8000-0000000229a1' as DwarfId
const SESSION: OpenCodePluginSession = { dwarfId: DWARF, directory: '/home/j/mine' }

const REPORT: OpenCodePermissionReport = {
  sessionId: 'ses-1',
  requestId: 'per-1',
  permission: 'bash',
  patterns: ['git status', 'git diff'],
  serverOrigin: 'http://127.0.0.1:4096'
}

function world(options: { refuse?: Error } = {}) {
  const clock = new FakeClock(1_790_000_000_000)
  const scheduler = new FakeScheduler(clock)
  const log = new RecordingDiagnosticsLog()
  const sessions = new Map<string, OpenCodePluginSession>()
  const opened: Array<{ dwarfId: string; input: AskInput }> = []
  const asks = new OpenCodePluginAsks({
    sessionOf: (providerSessionId) => sessions.get(providerSessionId) ?? null,
    asks: {
      open: (dwarfId, input) => {
        if (options.refuse !== undefined) throw options.refuse
        opened.push({ dwarfId, input })
        return {} as AskRecord
      }
    },
    redact: (text) => text.replace('secret', '[redacted]'),
    scheduler,
    log
  })
  return { clock, log, sessions, opened, asks }
}

describe('OpenCodePluginAsks (ADR-011 item 7; ADR-016 item 4)', () => {
  it('[C-27, ADR-011] a permission report of a known session opens one permission ask on the http channel and records where its answer goes', () => {
    const w = world()
    w.sessions.set('ses-1', SESSION)

    w.asks.report(REPORT)

    expect(w.opened).toStrictEqual([
      {
        dwarfId: DWARF,
        input: {
          kind: 'permission',
          providerRequestId: 'per-1',
          channel: 'http',
          payload: { toolName: 'bash', requestText: 'bash: git status, git diff' },
          options: { hasAllowOnce: true, hasRejectOnce: true }
        }
      }
    ])
    expect(w.asks.targetOf(DWARF, 'per-1')).toStrictEqual({
      serverOrigin: 'http://127.0.0.1:4096',
      directory: '/home/j/mine'
    })
    expect(w.asks.targetOf(DWARF, 'per-2')).toBeNull()
  })

  it('[ADR-007] the card line is one redacted line', () => {
    const w = world()
    w.sessions.set('ses-1', SESSION)

    w.asks.report({ ...REPORT, patterns: ['echo secret\nrm -rf /'] })

    expect(w.opened[0]?.input.payload).toStrictEqual({
      toolName: 'bash',
      requestText: 'bash: echo [redacted]'
    })
  })

  it('[ADR-011] a report of a session observation has not matched yet opens its ask once the session is known, within the retry window', () => {
    const w = world()

    w.asks.report(REPORT)
    expect(w.opened).toStrictEqual([])
    w.clock.advance(OPENCODE_REPORT_RETRY_MS[0] ?? 0)
    expect(w.opened).toStrictEqual([])

    w.sessions.set('ses-1', SESSION)
    w.clock.advance(OPENCODE_REPORT_RETRY_MS[1] ?? 0)

    expect(w.opened.map((open) => open.input.providerRequestId)).toStrictEqual(['per-1'])
    expect(w.asks.targetOf(DWARF, 'per-1')).not.toBeNull()
  })

  it('[ADR-011] a report whose session never becomes known opens nothing and is dropped with one record', () => {
    const w = world()

    w.asks.report(REPORT)
    for (const delay of OPENCODE_REPORT_RETRY_MS) w.clock.advance(delay)

    expect(w.opened).toStrictEqual([])
    expect(w.log.byEvent('asking.plugin-evidence.unmatched')).toStrictEqual([
      {
        level: 'warn',
        event: 'asking.plugin-evidence.unmatched',
        subsystem: 'asking',
        provider: 'opencode'
      }
    ])
  })

  it('[C-27, ADR-011] a report the broker refuses (an observed session while the gate is closed) opens nothing and keeps no address', () => {
    const w = world({ refuse: new HostInvariantError('not an ask') })
    w.sessions.set('ses-1', SESSION)

    w.asks.report(REPORT)

    expect(w.asks.targetOf(DWARF, 'per-1')).toBeNull()
    expect(w.log.byEvent('asking.plugin-evidence.refused')).toStrictEqual([
      {
        level: 'warn',
        event: 'asking.plugin-evidence.refused',
        subsystem: 'asking',
        provider: 'opencode',
        dwarfId: DWARF
      }
    ])
  })
})
