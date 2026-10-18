// layer: L3
// The `DelegationLaunchFacts` read (16 §5.2 item 5; INV-80, INV-81; ISSUE-209): the delegation
// endpoint re-reads a relay's launch gate on every call. The gate is the launch's "Let Jev choose"
// (launching's `launchedWithLetJevChoose`, read through the dwarf the launch's token is bound to)
// and whether that dwarf is a delegated worker (crew).
import { describe, expect, it } from 'vitest'
import type { DwarfId, LaunchId } from '../../kernel/domain/values'
import type { DelegationToken } from '../../modules/delegation'
import { createDelegationLaunchFacts } from './delegationLaunchFacts'

const LAUNCH = '01890a5d-ac96-774b-bcce-b30220900011' as LaunchId
const PARENT = '01890a5d-ac96-774b-bcce-b30220900012' as DwarfId

function token(parentDwarfId: DwarfId | null): DelegationToken {
  return { launchId: LAUNCH, parentDwarfId, mechanism: 'ticket-file', issuedAt: 0 }
}

function facts(options: {
  row: DelegationToken | null
  letJevChoose?: boolean
  dwarf?: { delegated: boolean; departed: boolean } | null
}) {
  return createDelegationLaunchFacts({
    tokens: { byLaunch: (launchId) => (launchId === LAUNCH ? options.row : null) },
    launching: {
      launchedWithLetJevChoose: (dwarfId) => dwarfId === PARENT && (options.letJevChoose ?? false)
    },
    crew: {
      get: (dwarfId) =>
        dwarfId === PARENT && options.dwarf !== null
          ? (options.dwarf ?? { delegated: false, departed: false })
          : null
    }
  })
}

describe('the delegation launch facts (ISSUE-209)', () => {
  it("[INV-80] a bound launch's gate is its dwarf's Let Jev choose and whether it is a delegated worker", () => {
    expect(facts({ row: token(PARENT), letJevChoose: true }).gateOf(LAUNCH)).toEqual({
      launchedWithLetJevChoose: true,
      delegated: false
    })
    expect(
      facts({
        row: token(PARENT),
        letJevChoose: false,
        dwarf: { delegated: true, departed: false }
      }).gateOf(LAUNCH)
    ).toEqual({ launchedWithLetJevChoose: false, delegated: true })
  })

  it('[INV-80] a launch with no live token, no bound dwarf or a dwarf crew does not know has no gate', () => {
    expect(facts({ row: null, letJevChoose: true }).gateOf(LAUNCH)).toBeNull()
    expect(facts({ row: token(null), letJevChoose: true }).gateOf(LAUNCH)).toBeNull()
    expect(facts({ row: token(PARENT), letJevChoose: true, dwarf: null }).gateOf(LAUNCH)).toBeNull()
  })
})
