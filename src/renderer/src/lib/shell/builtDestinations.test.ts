import { describe, expect, it } from 'vitest'
import type { AgentProviderOption } from '../../types'
import {
  SHIPPED_MODES,
  launchMode,
  leverModes,
  modeAtLaunchOptions,
  offeredProviders
} from './builtDestinations'

/*
 * What a Panel build may show (ADR-034 item 2; BR-19; 21 §1 item 8): a control whose destination
 * is not built is absent. The modes come from the build's feature list, the providers from the
 * offered catalog main answers (`launchable`), never from a provider id named here (R12).
 */

const offered: AgentProviderOption = { provider: 'claude', installed: true, launchable: true }
const notOffered: AgentProviderOption = {
  provider: 'antigravity',
  installed: true,
  launchable: false,
  reason: 'That agent cannot be started from the panel yet.'
}
const absent: AgentProviderOption = { provider: 'codex', installed: false, launchable: false }

describe('the modes a Panel build shows (ADR-034 item 2)', () => {
  it('[ADR-034, BR-19] with only the Panel shipped there is no mode lever and no Mode at launch option', () => {
    expect(SHIPPED_MODES).toEqual(['panel'])
    expect(leverModes(SHIPPED_MODES)).toEqual([])
    expect(modeAtLaunchOptions(SHIPPED_MODES)).toEqual([])
  })

  it('[ADR-034] between Veta and Valle the lever and Mode at launch show only the modes that exist', () => {
    expect(leverModes(['panel', 'veta'])).toEqual(['veta'])
    expect(modeAtLaunchOptions(['panel', 'veta'])).toEqual(['last-used', 'panel', 'veta'])
    expect(leverModes(['panel', 'veta', 'valle'])).toEqual(['valle', 'veta'])
    expect(modeAtLaunchOptions(['panel', 'veta', 'valle'])).toEqual([
      'last-used',
      'panel',
      'veta',
      'valle'
    ])
  })

  it('[ADR-034] a stored lastMode or modeAtLaunch naming an unshipped mode resolves to Panel', () => {
    expect(launchMode({ modeAtLaunch: 'veta' }, SHIPPED_MODES)).toBe('panel')
    expect(launchMode({ modeAtLaunch: 'valle' }, SHIPPED_MODES)).toBe('panel')
    expect(launchMode({ modeAtLaunch: 'last-used', lastMode: 'veta' }, SHIPPED_MODES)).toBe('panel')
    expect(launchMode({ lastMode: 'valle' }, SHIPPED_MODES)).toBe('panel')
    expect(launchMode({}, SHIPPED_MODES)).toBe('panel')
    // A shipped mode is kept, so the rule resolves only what is not built.
    expect(launchMode({ modeAtLaunch: 'veta' }, ['panel', 'veta'])).toBe('veta')
    expect(launchMode({ modeAtLaunch: 'last-used', lastMode: 'veta' }, ['panel', 'veta'])).toBe(
      'veta'
    )
    expect(launchMode({ modeAtLaunch: 'panel', lastMode: 'veta' }, ['panel', 'veta'])).toBe('panel')
  })
})

describe('the providers a Panel build offers (BR-19; 20 §8 R-03)', () => {
  it('[BR-19] a provider whose launch is not offered has no chip, no Jev pick and no default-provider option', () => {
    // One list feeds the Add panel's chips and Settings' default-provider select: only what main
    // said can be launched, in main's order. Jev's own pick reads the same `launchable` verdict
    // in main (routeRequest.ts), so it never names a provider this list leaves out.
    expect(offeredProviders([offered, notOffered, absent])).toEqual([offered])
    expect(offeredProviders([notOffered])).toEqual([])
  })
})
