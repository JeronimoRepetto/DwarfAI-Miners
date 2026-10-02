import { describe, expect, it } from 'vitest'
import { FAIL_CLOSED_CAPABILITIES, type ProviderCapabilities } from './capabilities'
import { offeredModes, type PermissionModeCatalog } from './offeredModes'
import type { PermissionModeSpec, ProviderProfile } from './profile'

const spec = (id: string, needs: PermissionModeSpec['needs']): PermissionModeSpec => ({
  id,
  label: `Label of ${id}`,
  needs,
  providerArgs: {}
})

const ASK_FIRST = spec('ask-first', 'interactive')
const ACCEPT_EDITS = spec('accept-edits', 'policy-only')
const PLAN_ONLY = spec('plan-only', 'policy-only')
const READ_ONLY = spec('read-only', 'policy-only')

const CATALOG: PermissionModeCatalog = {
  specs: [READ_ONLY, PLAN_ONLY, ACCEPT_EDITS, ASK_FIRST],
  denyPolicyVerified: false
}

function profile(permissionModes: string[]): ProviderProfile {
  return {
    id: 'synthetic',
    label: 'Synthetic',
    binaries: ['synthetic-cli'],
    models: [],
    efforts: [],
    permissionModes,
    drivers: ['acp'],
    publicLaunch: 'enabled'
  }
}

const caps = (permission: ProviderCapabilities['permission']): ProviderCapabilities => ({
  ...FAIL_CLOSED_CAPABILITIES,
  launch: true,
  permission
})

const ids = (modes: readonly PermissionModeSpec[]): string[] => modes.map((mode) => mode.id)

describe('offeredModes (ADR-011 item 1)', () => {
  it('[US-LAUNCH-001.AC11, INV-42] a supplier without an answer channel is never offered Ask first and its first remaining mode comes first', () => {
    // Ask first sits first in the catalog order, as for an interactive supplier.
    const p = profile(['ask-first', 'accept-edits', 'plan-only'])

    const policyOnly = offeredModes(p, caps('policy-only'), CATALOG)
    expect(ids(policyOnly)).toEqual(['accept-edits', 'plan-only'])

    // No permission channel at all: policy-only modes only behind a verified deny policy.
    expect(ids(offeredModes(p, caps('none'), CATALOG))).toEqual([])
    expect(ids(offeredModes(p, caps('none'), { ...CATALOG, denyPolicyVerified: true }))).toEqual([
      'accept-edits',
      'plan-only'
    ])
  })

  it('[INV-42] an interactive supplier is offered every catalog mode with Ask first first', () => {
    const p = profile(['accept-edits', 'ask-first', 'read-only'])

    expect(ids(offeredModes(p, caps('interactive'), CATALOG))).toEqual([
      'ask-first',
      'accept-edits',
      'read-only'
    ])
    // A mode id the catalog lists without a spec is never offered (fail closed).
    expect(
      ids(offeredModes(profile(['ask-first', 'unknown']), caps('interactive'), CATALOG))
    ).toEqual(['ask-first'])
  })
})
