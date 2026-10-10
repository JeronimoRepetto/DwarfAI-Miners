// layer: L2
// The Host's config writer as host/main.ts composes it for cut 2 (16 §7.1; ADR-016 items 3, 6; 21 §1
// item 4, §2 cut 2): the Claude hooks target goes to the config writer engine, only once the hook
// ingress has a persisted port to point the entry at; the OpenCode plugin target has no writer in
// this Host yet (the legacy installer still owns it), so nothing of it is written, verified or
// reverted here.
import { describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../kernel/domain/errors'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import type { ChannelToken, ExternalConfigWriter } from '../../modules/preferences'
import { enablableInstalledTools, hostConfigWriter, persistedIngressPort } from './hostConfigWriter'

const TOKEN = 'a'.repeat(64) as ChannelToken
const HASH = 'b'.repeat(64)

/** The engine as the bridge sees it (inline double, R15): every call recorded with its arguments. */
function recordingEngine(): ExternalConfigWriter & { calls: unknown[][] } {
  const calls: unknown[][] = []
  return {
    calls,
    install: (...args) => {
      calls.push(['install', ...args])
      return Promise.resolve({ ok: true, value: { verified: true, backupPath: '/b' } })
    },
    verify: (...args) => {
      calls.push(['verify', ...args])
      return Promise.resolve('verified')
    },
    revert: (...args) => {
      calls.push(['revert', ...args])
      return Promise.resolve({ ok: false, error: 'locked' })
    },
    findLegacy: (...args) => {
      calls.push(['findLegacy', ...args])
      return Promise.resolve(true)
    }
  }
}

describe('the Host config writer of cut 2 (16 §7.1)', () => {
  it('[ADR-016] with the ingress port persisted every Claude hooks call reaches the engine unchanged', async () => {
    const engine = recordingEngine()
    const writer = hostConfigWriter({
      claudeHooks: engine,
      ingressPort: { read: () => 41_234 },
      log: new RecordingDiagnosticsLog()
    })

    expect(await writer.install('claude-hooks', TOKEN, 'first-run', HASH)).toStrictEqual({
      ok: true,
      value: { verified: true, backupPath: '/b' }
    })
    expect(await writer.verify('claude-hooks')).toBe('verified')
    expect(await writer.revert('claude-hooks')).toStrictEqual({ ok: false, error: 'locked' })
    expect(await writer.findLegacy('claude-hooks')).toBe(true)
    expect(engine.calls).toStrictEqual([
      ['install', 'claude-hooks', TOKEN, 'first-run', HASH],
      ['verify', 'claude-hooks'],
      ['revert', 'claude-hooks'],
      ['findLegacy', 'claude-hooks']
    ])
  })

  it('[ADR-016, NFR-SEC-12] with no ingress port persisted, enabling Claude hooks writes nothing, issues no token and fails with io', async () => {
    const engine = recordingEngine()
    const log = new RecordingDiagnosticsLog()
    const writer = hostConfigWriter({ claudeHooks: engine, ingressPort: { read: () => null }, log })

    expect(await writer.install('claude-hooks', TOKEN, 'settings', HASH)).toStrictEqual({
      ok: false,
      error: 'io'
    })
    // The engine is never asked, so no Tx A runs: no config_writes row, no token hash issued.
    expect(engine.calls).toStrictEqual([])
    expect(log.entries).toContainEqual(
      expect.objectContaining({
        event: 'config.write',
        subsystem: 'claude-hooks',
        outcome: 'failed',
        causeClass: 'ingress-port-unset',
        msg: 'settings'
      })
    )
    // Neither the token nor its hash reaches a log record.
    expect(JSON.stringify(log.entries)).not.toContain(TOKEN)
    expect(JSON.stringify(log.entries)).not.toContain(HASH)
    // Turning it off, the boot check and the legacy probe need no port.
    await writer.revert('claude-hooks')
    await writer.verify('claude-hooks')
    await writer.findLegacy('claude-hooks')
    expect(engine.calls.map((call) => call[0])).toStrictEqual(['revert', 'verify', 'findLegacy'])
  })

  it('[ADR-016, S41.02] the OpenCode plugin target is never written by this Host in cut 2: install refused, verify absent, revert a no-op, no legacy probe', async () => {
    const engine = recordingEngine()
    const writer = hostConfigWriter({
      claudeHooks: engine,
      ingressPort: { read: () => 41_234 },
      log: new RecordingDiagnosticsLog()
    })

    expect(await writer.install('opencode-plugin', TOKEN, 'settings', HASH)).toStrictEqual({
      ok: false,
      error: 'io'
    })
    expect(await writer.verify('opencode-plugin')).toBe('absent')
    expect(await writer.revert('opencode-plugin')).toStrictEqual({ ok: true, value: undefined })
    expect(await writer.findLegacy('opencode-plugin')).toBe(false)
    expect(engine.calls).toStrictEqual([])
  })

  it('[ADR-016] the hook entry is rendered with the persisted ingress port, and never without one', () => {
    let stored: number | null = 41_234
    const port = persistedIngressPort({ read: () => stored })
    expect(port()).toBe(41_234)

    stored = null
    expect(() => port()).toThrow(HostInvariantError)
  })

  it('[S41.09, BR-19, ADR-016] the first-run step is offered only the installed tools whose integration this Host can turn on now: Claude Code once the ingress port is persisted, OpenCode never in cut 2', () => {
    let port: number | null = null
    const tools = enablableInstalledTools(
      { installed: () => ['claude-hooks', 'opencode-permissions'] },
      { read: () => port }
    )

    expect(tools.installed()).toStrictEqual([])
    port = 41_234
    expect(tools.installed()).toStrictEqual(['claude-hooks'])
    expect(
      enablableInstalledTools({ installed: () => [] }, { read: () => 41_234 }).installed()
    ).toStrictEqual([])
  })
})
