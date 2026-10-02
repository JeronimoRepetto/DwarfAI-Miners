import { describe, expect, it } from 'vitest'
import { FAIL_CLOSED_CAPABILITIES } from '../domain/capabilities'
import type { CatalogRecord, ProviderProfile } from '../domain/profile'
import { catalogueMachine, settle } from '../testing/catalogueMachine'

function record(id: string, overrides: Partial<ProviderProfile> = {}): CatalogRecord {
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
      ...overrides
    },
    ceiling: { ...FAIL_CLOSED_CAPABILITIES, launch: true, installDetection: 'user-binary' }
  }
}

const ALPHA = record('alpha')
const BRAVO = record('bravo')
const CHARLIE = record('charlie')

/**
 * A machine: the fake resolver plus the file each resolved path names (detection stats it).
 * Amended for ISSUE-147: built by the shared `catalogueMachine`, where each record has a driver
 * that measures its own ceiling, because `launchable` now lists a provider only when a driver's
 * probe says it can launch (ADR-009 D4, D6). Was: the catalogue over detection alone.
 */
function machine(records: readonly CatalogRecord[], build: { publicBuild: boolean }) {
  return catalogueMachine(records, build)
}

// Amended for ISSUE-147: `settle` is the shared one (50 turns, was 20 here), because a
// launchable answer now also waits for the probe round's promise hops; no fake time is added.

describe('launchable (INV-41)', () => {
  it('[US-RES-005.AC01, US-LAUNCH-001.AC10, INV-41] a catalog provider that does not resolve is absent from launchable', async () => {
    const m = machine([ALPHA, BRAVO, CHARLIE], { publicBuild: true })
    m.install('alpha-cli')
    m.install('charlie-cli')

    expect(await m.ids()).toEqual(['alpha', 'charlie'])
  })

  it('[US-RES-005.AC02] an absent provider leaves no entry at all, neither disabled nor with a reason', async () => {
    const m = machine([ALPHA, BRAVO], { publicBuild: true })
    m.install('alpha-cli')

    const listed = await m.catalogue.launchable()

    expect(listed).toHaveLength(1)
    expect(listed.some((entry) => entry.providerId === 'bravo')).toBe(false)
    // The one entry is the ordinary installed entry: no disabled flag, no reason, no extra field.
    expect(listed[0]).toEqual({ ...m.catalogue.entry('alpha'), installed: true })
    expect(Object.keys(listed[0] ?? {}).sort()).toEqual(
      [
        'answerChannel',
        'efforts',
        'installed',
        'label',
        'models',
        'permissionModes',
        'providerId',
        'publicLaunch'
      ].sort()
    )
  })

  it('[US-RES-005.AC03, INV-43] no launchable list ever contains an Other entry, whatever is installed', async () => {
    const records = [ALPHA, BRAVO, CHARLIE]
    const binaries = records.map((r) => r.profile.binaries[0] ?? '')
    // Every subset of installed CLIs, from none to all.
    for (let mask = 0; mask < 1 << binaries.length; mask += 1) {
      const m = machine(records, { publicBuild: true })
      binaries.forEach((binary, at) => {
        if ((mask & (1 << at)) !== 0) m.install(binary)
      })
      const ids = await m.ids()
      for (const id of ids) {
        expect(id.toLowerCase()).not.toMatch(/other|custom/)
        expect(records.some((r) => r.profile.id === id)).toBe(true)
      }
    }
  })

  it('[US-RES-005.AC04] a provider that resolves on the next Add-panel open appears in launchable', async () => {
    const m = machine([ALPHA, BRAVO], { publicBuild: true })
    m.install('alpha-cli')
    expect(await m.ids()).toEqual(['alpha'])

    m.install('bravo-cli') // installed while the app runs

    expect(await m.ids()).toEqual(['alpha', 'bravo'])
  })

  it('[US-RES-005.AC05, ADR-009] in a public build Antigravity is absent from launchable even when agy resolves, and in a development build it is present', async () => {
    // The catalog facts of Antigravity (adapters/catalog/profiles.ts): `agy`, launch gated (OQ-15).
    const antigravity = record('antigravity', { binaries: ['agy'], publicLaunch: 'gated' })
    const records = [ALPHA, antigravity]
    const publicBuild = machine(records, { publicBuild: true })
    const development = machine(records, { publicBuild: false })
    for (const m of [publicBuild, development]) {
      m.install('alpha-cli')
      m.install('agy')
    }

    const inPublic = await publicBuild.ids()
    const inDevelopment = await development.ids()

    expect(inPublic).toEqual(['alpha'])
    expect(inDevelopment).toEqual(['alpha', 'antigravity'])
    // Observation is not touched: the public catalogue still knows the entry (US-RES-005.AC05).
    expect(publicBuild.catalogue.entry('antigravity')?.publicLaunch).toBe('gated')
  })

  it('[ADR-009] a detection slower than 500 ms answers from the cache and the rescan updates the next answer', async () => {
    const m = machine([ALPHA, BRAVO], { publicBuild: true })
    m.install('alpha-cli')
    expect(await m.ids()).toEqual(['alpha']) // the cache now holds alpha installed, bravo absent

    m.install('bravo-cli')
    m.resolver.delayMs = 600 // every resolve now takes longer than the budget
    let answered: string[] | null = null
    void m.ids().then((ids) => (answered = ids))
    await settle()
    m.clock.advance(499)
    await settle()
    expect(answered).toBeNull() // still inside the budget

    m.clock.advance(1) // 500 ms: the budget ends, the cached answer is returned
    await settle()
    expect(answered).toEqual(['alpha'])

    m.clock.advance(100) // the background rescan finishes and refreshes the cache
    await settle()
    let next: string[] | null = null
    void m.ids().then((ids) => (next = ids))
    await settle()
    m.clock.advance(500)
    await settle()
    expect(next).toEqual(['alpha', 'bravo'])
  })

  it('[INV-41] entry reports installed from the last detection, and a provider without a CLI to resolve is installed by itself', async () => {
    const noCli: CatalogRecord = {
      ...record('no-cli', { binaries: [] }),
      ceiling: { ...FAIL_CLOSED_CAPABILITIES, launch: true, installDetection: 'none' }
    }
    const m = machine([ALPHA, BRAVO, noCli], { publicBuild: true })
    m.install('alpha-cli')

    expect(await m.ids()).toEqual(['alpha', 'no-cli'])
    expect(m.catalogue.entry('alpha')?.installed).toBe(true)
    expect(m.catalogue.entry('bravo')?.installed).toBe(false)
    expect(m.catalogue.entry('no-cli')?.installed).toBe(true)
  })
})
