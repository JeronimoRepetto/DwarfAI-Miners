import { describe, expect, it } from 'vitest'
import { FAIL_CLOSED_CAPABILITIES, type ProviderCapabilities } from '../domain/capabilities'
import type {
  CatalogRecord,
  PermissionModeCatalog,
  PermissionModeSpec,
  ProviderProfile
} from '../domain/profile'
import type { InstalledProvider } from '../ports/providerDriver'
import { StubCliProcessControl } from '../testing/StubCliProcessControl'
import { catalogueMachine, settle } from '../testing/catalogueMachine'
import { PROBE_TIMEOUT_MS } from './probe'

const INTERACTIVE: ProviderCapabilities = {
  launch: true,
  observe: true,
  sendTurn: true,
  interrupt: true,
  permission: 'interactive',
  question: 'form',
  answeredElsewhere: true,
  staleAnswerSafe: true,
  resume: 'load',
  adopt: false,
  turnEnd: 'reliable',
  reactionEvidence: 'turn-id',
  subagents: 'events',
  usage: { fidelity: 2, rateLimits: true },
  mcpInjection: 'ticket-file',
  console: 'log',
  earlyFailure: 'handshake',
  installDetection: 'user-binary',
  observedPermission: 'none',
  observedQuestion: 'none'
}

const spec = (id: string, needs: PermissionModeSpec['needs']): PermissionModeSpec => ({
  id,
  label: `Label of ${id}`,
  needs,
  providerArgs: {}
})
const MODES: PermissionModeCatalog = {
  specs: [
    spec('ask-first', 'interactive'),
    spec('accept-edits', 'policy-only'),
    spec('plan-only', 'policy-only'),
    spec('read-only', 'policy-only')
  ],
  denyPolicyVerified: false
}

function record(
  id: string,
  profile: Partial<ProviderProfile> = {},
  ceiling: ProviderCapabilities = INTERACTIVE
): CatalogRecord {
  return {
    profile: {
      id,
      label: `Label of ${id}`,
      binaries: [`${id}-cli`],
      models: [],
      efforts: [],
      permissionModes: [],
      drivers: ['acp'],
      publicLaunch: 'enabled',
      ...profile
    },
    ceiling,
    modes: MODES
  }
}

const ALPHA = record('alpha', {
  models: [
    { id: 'alpha-large', label: 'Large', efforts: ['low', 'high'], isDefault: true },
    { id: 'alpha-small', label: 'Small', efforts: [] }
  ],
  efforts: ['low', 'medium', 'high'],
  permissionModes: ['ask-first', 'accept-edits', 'plan-only']
})
const BRAVO = record('bravo', {
  models: [{ id: 'bravo-only', label: 'Only', efforts: ['fast'] }],
  efforts: ['fast', 'deep'],
  permissionModes: ['ask-first', 'read-only']
})

/** The help text of a CLI, with or without the flag a driver needs (15 §2.3). */
const HELP_WITH_FLAG = 'Usage: cli [options]\n  --permission-prompt-tool <tool>\n  --print\n'
const HELP_WITHOUT_FLAG = 'Usage: cli [options]\n  --print\n'

/** Runs the CLI's own `--help` through ProcessControl, as a real driver's probe does. */
async function readHelp(pc: StubCliProcessControl, install: InstalledProvider): Promise<string> {
  const run = pc.spawn({
    executable: install.binaryPath,
    args: ['--help'],
    cwd: '/',
    env: {},
    processGroup: 'own',
    stdio: 'pipe'
  })
  let out = ''
  run.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')))
  await run.exited
  return out
}

describe('SupplierCatalogueQueries entry and capabilities (ISSUE-147)', () => {
  it("[US-LAUNCH-001.AC04, US-LAUNCH-001.AC07] entry of a supplier lists only that supplier's own models, efforts and permission modes, each list in catalog order", async () => {
    // Bravo's driver measures policy-only permission: its own list keeps only what it honours.
    const m = catalogueMachine([ALPHA, BRAVO], {
      probe: (r) => async () =>
        r === BRAVO ? { ...r.ceiling, permission: 'policy-only' } : structuredClone(r.ceiling)
    })
    m.install('alpha-cli')
    m.install('bravo-cli')
    await m.ids()

    expect(m.catalogue.entry('alpha')).toMatchObject({
      providerId: 'alpha',
      models: ['alpha-large', 'alpha-small'],
      efforts: ['low', 'medium', 'high'],
      permissionModes: ['ask-first', 'accept-edits', 'plan-only'],
      answerChannel: 'available'
    })
    expect(m.catalogue.entry('bravo')).toMatchObject({
      providerId: 'bravo',
      models: ['bravo-only'],
      efforts: ['fast', 'deep'],
      permissionModes: ['read-only'],
      answerChannel: 'available'
    })
  })

  it('[C-27, US-LAUNCH-001.AC11, INV-42] a gated supplier offers no Ask first and says gated-off until its integration is on-verified, re-derived on every call', async () => {
    const gated = record('gated', {
      permissionModes: ['ask-first', 'accept-edits'],
      answerChannelGate: 'opencode-permissions'
    })
    const m = catalogueMachine([gated])
    m.install('gated-cli')
    await m.ids()

    for (const state of ['off', 'on-unverified'] as const) {
      m.gate.set('opencode-permissions', state)
      expect(m.catalogue.capabilities('gated')).toMatchObject({
        permission: 'none',
        question: 'none',
        launch: true
      })
      expect(m.catalogue.entry('gated')).toMatchObject({
        answerChannel: 'gated-off',
        gatingIntegration: 'opencode-permissions',
        permissionModes: []
      })
    }

    m.gate.set('opencode-permissions', 'on-verified') // no new probe, no new detection
    expect(m.catalogue.capabilities('gated')).toEqual(INTERACTIVE)
    expect(m.catalogue.entry('gated')).toMatchObject({
      answerChannel: 'available',
      permissionModes: ['ask-first', 'accept-edits']
    })
  })

  it('[NFR-OBS-04, FM-134] a changed CLI version is re-probed and recorded with version and date', async () => {
    const m = catalogueMachine([ALPHA])
    m.install('alpha-cli', { version: '1.0.0', mtimeMs: 1_000 })
    m.clock.advance(60_000)
    await m.ids()

    const first = m.clock.now()
    expect(m.driver('alpha', 'acp').probed.map((i) => i.version)).toEqual(['1.0.0'])
    expect(m.store.latest('alpha')).toEqual({ version: '1.0.0', caps: INTERACTIVE, at: first })

    await m.ids() // nothing changed: no new probe, no new record
    expect(m.driver('alpha', 'acp').probed).toHaveLength(1)

    m.clock.advance(60_000)
    m.install('alpha-cli', { version: '1.1.0', mtimeMs: 2_000 }) // the person upgraded the CLI
    await m.ids()

    expect(m.driver('alpha', 'acp').probed.map((i) => i.version)).toEqual(['1.0.0', '1.1.0'])
    expect(m.store.latest('alpha')).toEqual({
      version: '1.1.0',
      caps: INTERACTIVE,
      at: m.clock.now()
    })
    expect(m.store.versions('alpha').sort()).toEqual(['1.0.0', '1.1.0'])
    expect(m.bus.published.map((e) => [e.type, e.payload.providerVersion, e.at])).toEqual([
      ['ProviderCapabilitiesRecorded', '1.0.0', first],
      ['ProviderCapabilitiesRecorded', '1.1.0', m.clock.now()]
    ])

    m.install('alpha-cli', { version: '1.1.0', mtimeMs: 3_000 }) // same version, new mtime
    await m.ids()
    expect(m.driver('alpha', 'acp').probed).toHaveLength(3)
  })

  it("[FM-083, C-26] a help output without the needed flag sets that driver's launch false and leaves the next driver of the profile offered", async () => {
    const pc = new StubCliProcessControl()
    let help = HELP_WITH_FLAG
    pc.script((s) => (s.args[0] === '--help' ? { stdout: help } : undefined))
    const twoDrivers = record('twin', {
      drivers: ['stream-json', 'acp'],
      permissionModes: ['ask-first', 'accept-edits']
    })
    const m = catalogueMachine([twoDrivers], {
      probe: (r, transport) =>
        transport === 'stream-json'
          ? async (install) =>
              (await readHelp(pc, install)).includes('--permission-prompt-tool')
                ? structuredClone(r.ceiling)
                : { ...structuredClone(r.ceiling), launch: false }
          : async () => ({ ...structuredClone(r.ceiling), permission: 'policy-only' })
    })
    m.install('twin-cli', { version: '2.0.0', mtimeMs: 1_000 })

    expect(await m.ids()).toEqual(['twin'])
    expect(m.catalogue.capabilities('twin').permission).toBe('interactive') // first driver
    expect(m.catalogue.entry('twin')?.permissionModes).toEqual(['ask-first', 'accept-edits'])

    help = HELP_WITHOUT_FLAG // the next version dropped the flag
    m.install('twin-cli', { version: '2.1.0', mtimeMs: 2_000 })

    expect(await m.ids()).toEqual(['twin']) // still offered, through the next driver
    expect(m.catalogue.capabilities('twin')).toMatchObject({
      launch: true,
      permission: 'policy-only'
    })
    expect(m.catalogue.entry('twin')?.permissionModes).toEqual(['accept-edits'])
    expect(m.store.latest('twin')).toMatchObject({ version: '2.1.0' })
    expect(m.store.latest('twin')?.caps.permission).toBe('policy-only')

    // With the next driver gone as well, the provider is no longer offered (ADR-009 D6).
    m.driver('twin', 'acp').probeScript = async () => ({ ...INTERACTIVE, launch: false })
    m.install('twin-cli', { version: '2.2.0', mtimeMs: 3_000 })
    expect(await m.ids()).toEqual([])
    expect(m.catalogue.capabilities('twin').launch).toBe(false)
  })

  it('[ADR-009] a probe never starts a session and never reads a credential path', async () => {
    const pc = new StubCliProcessControl()
    pc.script((s) => (s.args[0] === '--help' ? { stdout: HELP_WITH_FLAG } : undefined))
    const m = catalogueMachine([ALPHA, BRAVO], {
      probe: (r) => async (install) => {
        await readHelp(pc, install)
        return structuredClone(r.ceiling)
      }
    })
    m.install('alpha-cli')
    m.install('bravo-cli', { version: '3.0.0' })

    expect(await m.ids()).toEqual(['alpha', 'bravo'])

    // Probing ran each CLI's own --help and nothing else: no launch, no other program, no
    // other argument.
    expect(m.driver('alpha', 'acp').launches).toEqual([])
    expect(m.driver('bravo', 'acp').launches).toEqual([])
    expect(pc.spawns.map((s) => [s.executable, ...s.args])).toEqual([
      ['/opt/tools/alpha-cli', '--help'],
      ['/opt/tools/bravo-cli', '--help']
    ])
    // The only file-system access is a stat of each resolved CLI: no credential store, no
    // token file, no read at all (ADR-008 item 2).
    expect(m.fsCalls.every((call) => call.method === 'stat')).toBe(true)
    expect(new Set(m.fsCalls.map((call) => call.path))).toEqual(
      new Set(['/opt/tools/alpha-cli', '/opt/tools/bravo-cli'])
    )
  })

  it('[C-26, INV-44] a probe that does not answer within PROBE_TIMEOUT_MS, or that breaks and throws, leaves that driver at its fail-closed values', async () => {
    const m = catalogueMachine([ALPHA, BRAVO], {
      probe: (r) => (r.profile.id === 'alpha' ? () => 'hang' : () => 'throw')
    })
    m.install('alpha-cli')
    m.install('bravo-cli')

    let listed: string[] | null = null
    void m.ids().then((ids) => (listed = ids))
    await settle()
    m.clock.advance(PROBE_TIMEOUT_MS)
    await settle()

    expect(listed).toEqual([])
    for (const id of ['alpha', 'bravo']) {
      expect(m.catalogue.capabilities(id)).toEqual(FAIL_CLOSED_CAPABILITIES)
      expect(m.store.latest(id)?.caps).toEqual(FAIL_CLOSED_CAPABILITIES)
    }
  })

  it('[ADR-009] a quarantined or missing CLI is never probed and its capabilities fail closed', async () => {
    const m = catalogueMachine([ALPHA, BRAVO])
    m.install('alpha-cli', { quarantined: true })

    expect(await m.ids()).toEqual([])
    expect(m.driver('alpha', 'acp').probed).toEqual([])
    expect(m.driver('bravo', 'acp').probed).toEqual([])
    expect(m.catalogue.capabilities('alpha')).toEqual(FAIL_CLOSED_CAPABILITIES)
    expect(m.store.latest('alpha')).toBeNull()
    expect(m.bus.published).toEqual([])
  })
})
