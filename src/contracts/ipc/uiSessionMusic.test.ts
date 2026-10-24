// layer: L6
import { describe, expect, it } from 'vitest'
import { uiSessionChangeSchema, uiSessionPatchSchema, uiSessionSnapshotSchema } from './windowApi'

/*
 * AMENDMENT-28 (owner-approved 2026-10-24; 14 §3.9 `UiSessionSnapshot.music`, §6.5; ADR-024 D1): the music the shown
 * mode window plays rides the UI-main session store, so the next mode window resumes it — one music, one playlist,
 * for this run only and never persisted (owner ruling 2026-10-24; #174). Optional: a store no window wrote it to has
 * no `music`.
 */
const MUSIC = {
  on: true,
  track: './assets/music-3.ogg',
  positionMs: 41250,
  queue: ['./assets/music-7.ogg', './assets/music-1.ogg'],
  lastPlayed: './assets/music-3.ogg'
}
const EMPTY = { drafts: {}, chatViews: {}, askPicks: {}, openChat: {}, currentMine: {}, valle: {} }

describe('UiSessionSnapshot.music (14 §3.9, AMENDMENT-28)', () => {
  it('[US-SHELL-005.AC03] a valid music slot validates in the snapshot, the patch and the change', () => {
    expect(uiSessionSnapshotSchema.safeParse({ ...EMPTY, music: MUSIC }).success).toBe(true)
    const patch = uiSessionPatchSchema.safeParse({ kind: 'music', music: MUSIC })
    expect(patch.success && patch.data).toEqual({ kind: 'music', music: MUSIC })
    expect(
      uiSessionChangeSchema.safeParse({ kind: 'music', music: MUSIC, origin: 'panel' }).success
    ).toBe(true)
    // Between two tracks nothing sounds: no track, and the queue still names what comes next.
    const between = { ...MUSIC, track: null, positionMs: 0, lastPlayed: null }
    expect(uiSessionPatchSchema.safeParse({ kind: 'music', music: between }).success).toBe(true)
  })

  it('[US-SHELL-005.AC03] the slot absent still validates: no window wrote the music yet', () => {
    const parsed = uiSessionSnapshotSchema.safeParse(EMPTY)
    expect(parsed.success).toBe(true)
    expect(parsed.success && 'music' in parsed.data).toBe(false)
  })

  it('[US-SHELL-005.AC03] an unknown field or a malformed value is refused', () => {
    const refused: unknown[] = [
      { ...MUSIC, volume: 0.5 },
      { ...MUSIC, positionMs: -1 },
      { ...MUSIC, positionMs: Number.POSITIVE_INFINITY },
      { ...MUSIC, on: 'yes' },
      { ...MUSIC, track: '' },
      { ...MUSIC, queue: [''] },
      { ...MUSIC, queue: Array.from({ length: 65 }, (_, i) => `./assets/m-${i}.ogg`) },
      { ...MUSIC, track: 'x'.repeat(2049) }
    ]
    for (const music of refused) {
      expect(
        uiSessionPatchSchema.safeParse({ kind: 'music', music }).success,
        JSON.stringify(music).slice(0, 80)
      ).toBe(false)
      expect(uiSessionSnapshotSchema.safeParse({ ...EMPTY, music }).success).toBe(false)
    }
    expect(uiSessionPatchSchema.safeParse({ kind: 'music', music: MUSIC, extra: 1 }).success).toBe(
      false
    )
  })
})
