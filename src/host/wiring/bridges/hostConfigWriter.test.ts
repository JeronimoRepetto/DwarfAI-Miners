// layer: L2
// The Host's config writer as host/main.ts composes it for cut 2 (16 §7.1; ADR-016 items 3, 6; 21 §1
// item 4, §2 cut 2): the Claude hooks target goes to the config writer engine, only once the hook
// ingress has a persisted port to point the entry at; the OpenCode plugin target is verified and
// reverted through its writer when host/main.ts composes one (ISSUE-233, the Reset saga's
// `external-config` step), and never written here (the legacy installer still enables it).
//
// TC-233-02 (the bridge half).
import { describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../kernel/domain/errors'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import type { ChannelToken, ExternalConfigWriter } from '../../modules/preferences'
import {
  claudeHookEntryFollower,
  enablableInstalledTools,
  hostConfigWriter,
  persistedIngressPort
} from './hostConfigWriter'

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

  // AMENDED for ISSUE-228 (was: install refused while the legacy installer enabled the plugin): the Host is the
  // plugin file's writer from ISSUE-228 on (bridge header); B-M14 has no routed caller before the step-4a switch
  // (ISSUE-235), so there is still one writer per release (21 §1 item 4). The legacy probe joins with ISSUE-232.
  // AMENDED for ISSUE-235 (was: the legacy probe refused): the step-4a switch routes A-52/A-53 to the Host and switches
  // today's plugin installer off, so the boot legacy check includes the `opencode-plugin` target (21 §2 cut 4a;
  // AMENDMENT-9, OQ-70; 07 S41.02).
  it('[ADR-023, S13.03, INV-112] with the OpenCode plugin writer composed, its verify, revert, install and legacy probe reach it unchanged', async () => {
    const claudeHooks = recordingEngine()
    const openCodePlugin = recordingEngine()
    const writer = hostConfigWriter({
      claudeHooks,
      openCodePlugin,
      ingressPort: { read: () => 41_234 },
      log: new RecordingDiagnosticsLog()
    })

    // The Reset saga's `external-config` step and the boot re-verification (16 §7.3, §7.4).
    expect(await writer.revert('opencode-plugin')).toStrictEqual({ ok: false, error: 'locked' })
    expect(await writer.verify('opencode-plugin')).toBe('verified')
    // The enable (ISSUE-228) reaches the writer with the persisted port; the first-run legacy probe
    // joins with ISSUE-232.
    expect(await writer.install('opencode-plugin', TOKEN, 'add-panel', HASH)).toStrictEqual({
      ok: true,
      value: { verified: true, backupPath: '/b' }
    })
    expect(await writer.findLegacy('opencode-plugin')).toBe(true)
    expect(openCodePlugin.calls).toStrictEqual([
      ['revert', 'opencode-plugin'],
      ['verify', 'opencode-plugin'],
      ['install', 'opencode-plugin', TOKEN, 'add-panel', HASH],
      ['findLegacy', 'opencode-plugin']
    ])
    expect(claudeHooks.calls).toStrictEqual([])
  })

  // ADDED for ISSUE-228: the plugin reports to the hook ingress (ADR-016 item 3), so its enable needs the
  // persisted port exactly as the Claude hook entry does.
  it('[ADR-016, NFR-SEC-12] with no ingress port persisted, enabling OpenCode permission requests writes nothing, issues no token and fails with io', async () => {
    const claudeHooks = recordingEngine()
    const openCodePlugin = recordingEngine()
    const log = new RecordingDiagnosticsLog()
    const writer = hostConfigWriter({
      claudeHooks,
      openCodePlugin,
      ingressPort: { read: () => null },
      log
    })

    expect(await writer.install('opencode-plugin', TOKEN, 'add-panel', HASH)).toStrictEqual({
      ok: false,
      error: 'io'
    })
    expect(openCodePlugin.calls).toStrictEqual([])
    expect(claudeHooks.calls).toStrictEqual([])
    expect(log.entries).toContainEqual(
      expect.objectContaining({
        event: 'config.write',
        subsystem: 'opencode-plugin',
        outcome: 'failed',
        causeClass: 'ingress-port-unset',
        msg: 'add-panel'
      })
    )
    expect(JSON.stringify(log.entries)).not.toContain(TOKEN)
    expect(JSON.stringify(log.entries)).not.toContain(HASH)
    // Turning it off and the boot check need no port.
    await writer.revert('opencode-plugin')
    await writer.verify('opencode-plugin')
    expect(openCodePlugin.calls.map((call) => call[0])).toStrictEqual(['revert', 'verify'])
  })

  it('[ADR-016] the hook entry is rendered with the persisted ingress port, and never without one', () => {
    let stored: number | null = 41_234
    const port = persistedIngressPort({ read: () => stored })
    expect(port()).toBe(41_234)

    stored = null
    expect(() => port()).toThrow(HostInvariantError)
  })

  // AMENDED for ISSUE-235 (was: OpenCode never offered): from the step-4a switch the first-run step offers OpenCode
  // when it is installed (21 §2 cut 4a; OQ-68), on the same persisted-port condition as Claude Code, since the plugin
  // reports to the same hook ingress (ADR-016 item 3).
  it('[S41.09, BR-19, ADR-016] the first-run step is offered only the installed tools whose integration this Host can turn on now: each once the ingress port is persisted', () => {
    let port: number | null = null
    const tools = enablableInstalledTools(
      { installed: () => ['claude-hooks', 'opencode-permissions'] },
      { read: () => port }
    )

    expect(tools.installed()).toStrictEqual([])
    port = 41_234
    expect(tools.installed()).toStrictEqual(['claude-hooks', 'opencode-permissions'])
    expect(
      enablableInstalledTools({ installed: () => [] }, { read: () => 41_234 }).installed()
    ).toStrictEqual([])
  })
})

describe("the Host's own Claude hook entry following the ingress port (07 S14.10)", () => {
  /** The engine's rewrite as the bridge sees it: every call recorded with the credential it was handed. */
  function followingEngine() {
    const calls: Array<{ target: string; token: string; tokenSha256: string }> = []
    return {
      calls,
      followIngressPort: (
        target: 'claude-hooks',
        credential: () => { token: ChannelToken; tokenSha256: string }
      ) => {
        calls.push({ target, ...credential() })
        return Promise.resolve('rewritten')
      }
    }
  }
  const mint = () => ({ value: TOKEN, sha256: HASH })

  it("[S14.10, ADR-016] the Host's Claude hook entry follows the ingress port with a freshly minted token", async () => {
    const engine = followingEngine()

    await claudeHookEntryFollower({ engine, rolledBack: false, mintCredential: mint })()

    expect(engine.calls).toStrictEqual([
      { target: 'claude-hooks', token: TOKEN, tokenSha256: HASH }
    ])
  })

  it("[S14.10, ADR-016] a cut-2 rollback build never rewrites the hook entry: today's installer is its one writer there", async () => {
    const engine = followingEngine()

    await claudeHookEntryFollower({ engine, rolledBack: true, mintCredential: mint })()

    expect(engine.calls).toStrictEqual([])
  })
})
