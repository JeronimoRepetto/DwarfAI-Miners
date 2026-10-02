import { describe, expect, it } from 'vitest'
import { FAIL_CLOSED_CAPABILITIES, type ProviderCapabilities } from '../domain/capabilities'
import type { CatalogRecord, ProviderProfile } from '../domain/profile'
import { createSupplierCatalogue, type SupplierEntry } from './catalogue'

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

const SIMULATED: CatalogRecord = {
  profile: profile('simulated'),
  ceiling: INTERACTIVE,
  developmentOnly: true
}
const OBSERVE_ONLY: CatalogRecord = {
  profile: profile('observe-only', { publicLaunch: 'gated', drivers: ['ndjson'] }),
  ceiling: { ...FAIL_CLOSED_CAPABILITIES, observe: true, sendTurn: true }
}
const GATED_CHANNEL: CatalogRecord = {
  profile: profile('gated-channel', { answerChannelGate: 'opencode-permissions' }),
  ceiling: { ...INTERACTIVE, question: 'none' }
}
const SYNTHETIC: CatalogRecord = {
  profile: profile('synthetic-newcomer', { drivers: ['http-server', 'acp'] }),
  ceiling: { ...INTERACTIVE, permission: 'policy-only', question: 'none', resume: 'none' }
}

/** What an entry must be: its own record's data and nothing else (INV-40). */
function expectedEntry(record: CatalogRecord): SupplierEntry {
  const { profile: p, ceiling } = record
  const gated = p.answerChannelGate !== undefined
  const canAnswer = ceiling.permission === 'interactive' || ceiling.question !== 'none'
  return {
    providerId: p.id,
    label: p.label,
    models: p.models.map((model) => model.id),
    efforts: [...p.efforts],
    permissionModes: [...p.permissionModes],
    installed: false,
    publicLaunch: p.publicLaunch,
    answerChannel: gated ? 'gated-off' : canAnswer ? 'available' : 'none',
    ...(gated ? { gatingIntegration: p.answerChannelGate } : {})
  }
}

const BASE = [SIMULATED, OBSERVE_ONLY, GATED_CHANNEL]

describe('SupplierCatalogueQueries (skeleton)', () => {
  it('[US-OBS-007.AC03, INV-40, BR-10] adding a synthetic provider profile changes no other entry, no capability and no behaviour of an existing provider', () => {
    const before = createSupplierCatalogue({ records: BASE })
    const after = createSupplierCatalogue({ records: [...BASE, SYNTHETIC] })

    for (const record of BASE) {
      const id = record.profile.id
      expect(after.entry(id)).toEqual(before.entry(id))
      expect(after.capabilities(id)).toEqual(before.capabilities(id))
      // Each entry is its own record's data, whatever its id: no provider is special.
      expect(after.entry(id)).toEqual(expectedEntry(record))
      expect(after.capabilities(id)).toEqual(record.ceiling)
    }
    expect(after.entry(SYNTHETIC.profile.id)).toEqual(expectedEntry(SYNTHETIC))
    expect(after.capabilities(SYNTHETIC.profile.id)).toEqual(SYNTHETIC.ceiling)
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
