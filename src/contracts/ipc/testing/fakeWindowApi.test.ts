// L6: the generated fake `window.api` matches the channel registry (ADR-033 item 7 and Verification; 17 §1.6), so a
// renderer test cannot call a member that does not exist.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHANNELS, PRELOAD_HELPERS, ROW_IDS, type ChannelKey } from '@dwarfai/contracts'
import { createFakeWindowApi } from './fakeWindowApi'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..')
const I21 = '§8 I-21'

interface CatalogRow {
  id: string
  wire: string | null
  member: string
}
/** The hand-written, reviewed data fixture of 14 §2.1/§2.2 and §8 I-21 (member names as 14 gives them). */
const catalog14: CatalogRow[] = JSON.parse(
  readFileSync(
    resolve(
      REPO_ROOT,
      'scripts',
      'checks',
      '__fixtures__',
      'ipc-reinventory',
      'catalog-14-seam-a.json'
    ),
    'utf8'
  )
).rows
const KEYS = Object.keys(CHANNELS) as ChannelKey[]
const helpers: readonly string[] = PRELOAD_HELPERS

/** A row's 14 member name (today's: every route before cut 0 keeps `shape: 'today'`). */
function memberOf(key: ChannelKey): string | undefined {
  const id = ROW_IDS[key]
  return catalog14.find((row) => row.id === id && (id !== I21 || row.wire === key))?.member
}

describe('fake window.api (ADR-033 item 7; 17 §1.6)', () => {
  it('[ADR-033] the fake window.api has every registry member and calling an unknown member fails the test', async () => {
    const fake = createFakeWindowApi({ getAlwaysOnTop: async () => true })
    const members = KEYS.map(memberOf)
    expect(members.every((member) => typeof member === 'string')).toBe(true)
    expect(Object.keys(fake).sort()).toEqual([...(members as string[])].sort())
    for (const member of members as string[]) {
      expect(typeof (fake as unknown as Record<string, unknown>)[member], member).toBe('function')
    }

    // An override answers; a member left unfaked never answers silently.
    await expect(fake.getAlwaysOnTop()).resolves.toBe(true)
    await expect(fake.getMines()).rejects.toThrow(/getMines/)
    const helper = KEYS.find((key) => helpers.includes(key))
    expect(helper && memberOf(helper)).toBe('pathForDroppedFile')

    // `stopDwarf` is 14's NEW A-N29, not a row of this registry: reading or faking it fails.
    const unknown = fake as unknown as Record<string, () => unknown>
    expect(() => unknown.stopDwarf?.()).toThrow(/stopDwarf/)
    expect(() =>
      createFakeWindowApi({ stopDwarf: async () => undefined } as unknown as Parameters<
        typeof createFakeWindowApi
      >[0])
    ).toThrow(/stopDwarf/)
  })
})
