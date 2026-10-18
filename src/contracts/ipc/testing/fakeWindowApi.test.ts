// L6: the generated fake `window.api` matches the channel registry (ADR-033 item 7 and Verification; 17 §1.6), so a
// renderer test cannot call a member that does not exist.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CHANNELS,
  MEMBER_REMOVED,
  PRELOAD_HELPERS,
  ROW_IDS,
  type ChannelKey
} from '@dwarfai/contracts'
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
/*
 * AMENDED for ISSUE-183 (was: every registry key): a RETIRE row whose member left with its route (`MEMBER_REMOVED`, A-26
 * in 3a, the release this fake is generated for) has no member, so the fake carries those of every other row.
 */
const KEYS = (Object.keys(CHANNELS) as ChannelKey[]).filter(
  (key) => MEMBER_REMOVED[key] === undefined
)
const helpers: readonly string[] = PRELOAD_HELPERS

/**
 * The member each row's CHANGE renames once its route is `target` (14 §1.1: A-44 only). AMENDED for ISSUE-123 (was:
 * today's name for every row): the cut-1 switch routes A-44 with its target shape, so the fake carries its 14 name.
 */
const RENAMED_FROM_CUT_1: Partial<Record<ChannelKey, string>> = {
  'presence:visibleMines': 'reportVisibleMines',
  // AMENDED for ISSUE-172: 14 gives `resetDwarfName` to A-N09 and to this legacy row of §8 I-21, both live until cut 5;
  // the legacy member is renamed so window.api has one member per row.
  'dwarf:resetName': 'resetDwarfNameToday'
}

/** A row's 14 member name. */
function memberOf(key: ChannelKey): string | undefined {
  const id = ROW_IDS[key]
  return (
    RENAMED_FROM_CUT_1[key] ??
    catalog14.find((row) => row.id === id && (id !== I21 || row.wire === key))?.member
  )
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

    // AMENDED for ISSUE-171 (was: `stopDwarf`, then not a row of this registry): A-N29 is declared now, so the
    // unknown member is one 14 never lists — no member interrupts only the turn (OQ-49). Reading or faking it fails.
    const unknown = fake as unknown as Record<string, () => unknown>
    expect(() => unknown.interruptTurn?.()).toThrow(/interruptTurn/)
    expect(() =>
      createFakeWindowApi({ interruptTurn: async () => undefined } as unknown as Parameters<
        typeof createFakeWindowApi
      >[0])
    ).toThrow(/interruptTurn/)
  })
})
