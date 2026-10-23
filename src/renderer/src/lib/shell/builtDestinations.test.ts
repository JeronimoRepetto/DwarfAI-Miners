import { describe, expect, it } from 'vitest'
import type { AgentProviderOption } from '../../types'
import {
  MODE_AT_LAUNCH_LABELS,
  SHIPPED_MODES,
  launchMode,
  leverMove,
  leverModes,
  modeAtLaunchOptions,
  offeredProviders
} from './builtDestinations'
import { gripMenuEntries } from '../veta/gripMenu'

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

/** A build that ships the Panel alone (ADR-034's first release). */
const PANEL_ONLY = ['panel'] as const

describe('the modes a Panel build shows (ADR-034 item 2)', () => {
  // AMENDED for ISSUE-294 (was: this build's own list, the Panel alone): a release build ships Veta now (ADR-034 item 2),
  // so a Panel-only build is the list written here; this build's list is checked to hold no Valle.
  // AMENDED for ISSUE-311 (was: this build's list holds no Valle): Valle ships with ISSUE-311 (ADR-034 item 2), so the
  // Panel-only list written here is the whole case.
  it('[ADR-034, BR-19] with only the Panel shipped there is no mode lever and no Mode at launch option', () => {
    expect(leverModes(PANEL_ONLY)).toEqual([])
    expect(modeAtLaunchOptions(PANEL_ONLY)).toEqual([])
  })

  // AMENDED for ISSUE-311 (was: a release build ships the Panel and Veta, the lever ▼ Veta alone): once Valle ships every
  // mode is shown (ADR-034 item 2; BR-19).
  it('[BR-19, ADR-034] with Valle built the lever, the grip menu and Mode at launch list every mode', () => {
    expect(SHIPPED_MODES).toEqual(['panel', 'veta', 'valle'])
    // The Panel's lever: "▲ Valle" above "▼ Veta", as the design draws it.
    expect(leverModes(SHIPPED_MODES)).toEqual(['valle', 'veta'])
    // Veta's grip menu: "Open Panel" and "Open Valle", then its own rows.
    expect(
      gripMenuEntries(SHIPPED_MODES).flatMap((entry) => (entry.kind === 'item' ? [entry.id] : []))
    ).toEqual(['open-panel', 'open-valle', 'new-dwarf', 'hide'])
    // Settings › General: Last used, then every mode.
    expect(modeAtLaunchOptions(SHIPPED_MODES)).toEqual(['last-used', 'panel', 'veta', 'valle'])
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

  // AMENDED for ISSUE-294 (was: over this build's list, the Panel alone): the unshipped modes are those of a Panel-only
  // list written here, and Valle, which no release build ships yet, over this build's list.
  // AMENDED for ISSUE-311 (was: Valle over this build's list): Valle ships now, so it is unshipped in the Panel-and-Veta
  // list written here, and kept over this build's list.
  it('[ADR-034] a stored lastMode or modeAtLaunch naming an unshipped mode resolves to Panel', () => {
    expect(launchMode({ modeAtLaunch: 'veta' }, PANEL_ONLY)).toBe('panel')
    expect(launchMode({ modeAtLaunch: 'valle' }, ['panel', 'veta'])).toBe('panel')
    expect(launchMode({ modeAtLaunch: 'last-used', lastMode: 'veta' }, PANEL_ONLY)).toBe('panel')
    expect(launchMode({ lastMode: 'valle' }, ['panel', 'veta'])).toBe('panel')
    expect(launchMode({ lastMode: 'valle' }, SHIPPED_MODES)).toBe('valle')
    expect(launchMode({}, SHIPPED_MODES)).toBe('panel')
    // A shipped mode is kept, so the rule resolves only what is not built.
    expect(launchMode({ modeAtLaunch: 'veta' }, ['panel', 'veta'])).toBe('veta')
    expect(launchMode({ modeAtLaunch: 'last-used', lastMode: 'veta' }, ['panel', 'veta'])).toBe(
      'veta'
    )
    expect(launchMode({ modeAtLaunch: 'panel', lastMode: 'veta' }, ['panel', 'veta'])).toBe('panel')
  })
})

describe('the mode lever and Mode at launch (ISSUE-294)', () => {
  it('[US-SHELL-001.AC02, S10.04, S9.01] a side of the lever moves to its mode, carrying the chat open in the Panel', () => {
    expect(leverMove('veta', { mineId: 'mine-1', dwarfId: 'dwarf-1' })).toEqual({
      mode: 'veta',
      mineId: 'mine-1',
      dwarfId: 'dwarf-1'
    })
    // No chat open (the Add panel, or nothing): the move carries none.
    expect(leverMove('veta', { mineId: 'mine-1', dwarfId: null })).toEqual({ mode: 'veta' })
    expect(leverMove('veta', { mineId: '', dwarfId: null })).toEqual({ mode: 'veta' })
  })

  it('[US-SET-002.AC09] each Mode at launch option reads as the design writes it', () => {
    expect(
      modeAtLaunchOptions(['panel', 'veta', 'valle']).map((o) => MODE_AT_LAUNCH_LABELS[o])
    ).toEqual(['Last used', 'Panel', 'Veta', 'Valle'])
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
