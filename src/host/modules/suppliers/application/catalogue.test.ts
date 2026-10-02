import { describe, expect, it } from 'vitest'
import { FAIL_CLOSED_CAPABILITIES, type ProviderCapabilities } from '../domain/capabilities'
import { merge, negotiatedFor } from '../domain/mergeCapabilities'
import { answerChannelOf, offeredModes } from '../domain/offeredModes'
import type { CatalogRecord, PermissionModeCatalog, ProviderProfile } from '../domain/profile'
import { catalogueMachine } from '../testing/catalogueMachine'
import type { SupplierEntry } from './catalogue'

/**
 * The catalogue over these records, on a machine where nothing was ever detected (ISSUE-146).
 * Amended for ISSUE-147: built by the shared `catalogueMachine` (the catalogue now also takes
 * probing, the integration gate and a scheduler). Was: the catalogue over detection alone.
 */
function createSupplierCatalogue(deps: { records: readonly CatalogRecord[] }) {
  return catalogueMachine(deps.records).catalogue
}

/**
 * Added for ISSUE-147: the catalogue with every record's CLI installed and probed, each driver
 * measuring its own ceiling, and every integration gate off (the new-install default).
 */
async function probedCatalogue(records: readonly CatalogRecord[]) {
  const m = catalogueMachine(records)
  for (const record of records) {
    for (const binary of record.profile.binaries) m.install(binary)
  }
  await m.catalogue.launchable()
  return m.catalogue
}

/** Added for ISSUE-147: a record's effective values with its driver measuring the ceiling, gate off. */
function effectiveOf(record: CatalogRecord): ProviderCapabilities {
  const gate = record.profile.answerChannelGate === undefined ? null : 'off'
  return merge(record.ceiling, negotiatedFor([record.ceiling], gate))
}

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

function profile(id: string, overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id,
    label: `Label of ${id}`,
    binaries: [`${id}-cli`],
    models: [
      { id: `${id}-model`, label: `Model of ${id}`, efforts: ['low', 'high'], isDefault: true }
    ],
    efforts: ['low', 'high'],
    permissionModes: ['ask-first', 'read-only'],
    drivers: ['acp'],
    publicLaunch: 'enabled',
    ...overrides
  }
}

/** Added for ISSUE-147: the specs behind the mode ids every test profile lists (ADR-011 item 1). */
const MODES: PermissionModeCatalog = {
  specs: [
    { id: 'ask-first', label: 'Ask first', needs: 'interactive', providerArgs: {} },
    { id: 'read-only', label: 'Read only', needs: 'policy-only', providerArgs: {} }
  ],
  denyPolicyVerified: false
}

const SIMULATED: CatalogRecord = {
  profile: profile('simulated'),
  ceiling: INTERACTIVE,
  developmentOnly: true,
  modes: MODES
}
const OBSERVE_ONLY: CatalogRecord = {
  profile: profile('observe-only', { publicLaunch: 'gated', drivers: ['ndjson'] }),
  ceiling: { ...FAIL_CLOSED_CAPABILITIES, observe: true, sendTurn: true },
  modes: MODES
}
const GATED_CHANNEL: CatalogRecord = {
  profile: profile('gated-channel', { answerChannelGate: 'opencode-permissions' }),
  ceiling: { ...INTERACTIVE, question: 'none' },
  modes: MODES
}
const SYNTHETIC: CatalogRecord = {
  profile: profile('synthetic-newcomer', { drivers: ['http-server', 'acp'] }),
  ceiling: { ...INTERACTIVE, permission: 'policy-only', question: 'none', resume: 'none' },
  modes: MODES
}

/**
 * What an entry must be: its own record's data and nothing else (INV-40).
 * Amended for ISSUE-147: the entry carries the effective values (installed and probed, gate off),
 * so its permission modes are the offered ones and its answer channel follows the effective
 * capabilities and the gate (ADR-011 items 1, 7). Was: the raw catalog modes, `installed: false`,
 * and an answer channel read from the ceiling.
 */
function expectedEntry(record: CatalogRecord): SupplierEntry {
  const { profile: p } = record
  const gated = p.answerChannelGate !== undefined
  const caps = effectiveOf(record)
  const modes = record.modes ?? { specs: [], denyPolicyVerified: false }
  return {
    providerId: p.id,
    label: p.label,
    models: p.models.map((model) => model.id),
    efforts: [...p.efforts],
    permissionModes: offeredModes(p, caps, modes).map((mode) => mode.id),
    installed: true,
    publicLaunch: p.publicLaunch,
    answerChannel: answerChannelOf(caps, gated ? 'off' : null),
    ...(gated ? { gatingIntegration: p.answerChannelGate } : {})
  }
}

const BASE = [SIMULATED, OBSERVE_ONLY, GATED_CHANNEL]

describe('SupplierCatalogueQueries (skeleton)', () => {
  it('[US-OBS-007.AC03, INV-40, BR-10] adding a synthetic provider profile changes no other entry, no capability and no behaviour of an existing provider', async () => {
    // Amended for ISSUE-147: both catalogues are installed and probed (async), and capabilities
    // are the effective values: the ceiling as each driver measured it, lowered by the gate
    // (ADR-009 D2; ADR-011 item 7). Was: unprobed catalogues answering the ceiling.
    const before = await probedCatalogue(BASE)
    const after = await probedCatalogue([...BASE, SYNTHETIC])

    for (const record of BASE) {
      const id = record.profile.id
      expect(after.entry(id)).toEqual(before.entry(id))
      expect(after.capabilities(id)).toEqual(before.capabilities(id))
      // Each entry is its own record's data, whatever its id: no provider is special.
      expect(after.entry(id)).toEqual(expectedEntry(record))
      expect(after.capabilities(id)).toEqual(effectiveOf(record))
    }
    expect(after.entry(SYNTHETIC.profile.id)).toEqual(expectedEntry(SYNTHETIC))
    expect(after.capabilities(SYNTHETIC.profile.id)).toEqual(effectiveOf(SYNTHETIC))
    // The entries carry their own offered modes: interactive, policy-only, and none.
    expect(after.entry('simulated')?.permissionModes).toEqual(['ask-first', 'read-only'])
    expect(after.entry(SYNTHETIC.profile.id)?.permissionModes).toEqual(['read-only'])
    expect(after.entry('gated-channel')?.permissionModes).toEqual([])
  })

  it('[US-LAUNCH-002.AC07, INV-43] the catalogue never contains an Other entry, whatever providers are added', () => {
    const growing: CatalogRecord[] = []
    for (const record of [...BASE, SYNTHETIC]) {
      growing.push(record)
      const catalogue = createSupplierCatalogue({ records: growing })
      for (const otherId of ['other', 'Other', 'Other…', 'custom', '']) {
        expect(catalogue.entry(otherId)).toBeNull()
      }
      for (const listed of growing) {
        expect(catalogue.entry(listed.profile.id)?.providerId).toBe(listed.profile.id)
      }
    }
  })

  it('[ADR-009] entry of an unknown provider id is null and capabilities of it are the fail-closed ceiling', () => {
    const catalogue = createSupplierCatalogue({ records: [...BASE, SYNTHETIC] })

    expect(catalogue.entry('never-listed')).toBeNull()
    expect(catalogue.capabilities('never-listed')).toEqual({
      launch: false,
      observe: false,
      sendTurn: false,
      interrupt: false,
      permission: 'none',
      question: 'none',
      answeredElsewhere: false,
      staleAnswerSafe: false,
      resume: 'none',
      adopt: false,
      turnEnd: 'none',
      reactionEvidence: 'none',
      subagents: 'none',
      usage: { fidelity: 0, rateLimits: false },
      mcpInjection: 'none',
      console: 'log',
      earlyFailure: 'exit-only',
      installDetection: 'user-binary',
      observedPermission: 'none',
      observedQuestion: 'none'
    })
  })
})
