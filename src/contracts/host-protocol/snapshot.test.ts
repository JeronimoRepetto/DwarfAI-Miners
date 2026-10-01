import { describe, expect, expectTypeOf, it } from 'vitest'
import type { z } from 'zod'
import type { HelloOk } from './adr-003'
import { HOST_METHOD_SCHEMAS, type HostMethods } from './methods'
import {
  SNAPSHOT_SECTIONS,
  snapshotChunkSchema,
  snapshotMetaSchema,
  snapshotPageSchema,
  snapshotParamsSchema,
  type SnapshotChunk,
  type SnapshotMeta,
  type SnapshotPage,
  type SnapshotParams,
  type SnapshotSection
} from './snapshot'

// The B-M04 entry of 14 §3.4 and the 14 §3.7 snapshot types with their strict() schemas (14 §1.4).

describe('session.snapshot params and result (14 §3.4 B-M04, §3.7)', () => {
  it('[ADR-003] the snapshot schemas infer exactly the 14 §3.7 types and the B-M04 entry uses them', () => {
    expectTypeOf<HostMethods['session.snapshot']>().toEqualTypeOf<{
      params: SnapshotParams
      result: SnapshotPage
    }>()
    expectTypeOf<z.infer<typeof snapshotParamsSchema>>().toEqualTypeOf<SnapshotParams>()
    expectTypeOf<z.infer<typeof snapshotPageSchema>>().toEqualTypeOf<SnapshotPage>()
    expectTypeOf<z.infer<typeof snapshotChunkSchema>>().toEqualTypeOf<SnapshotChunk>()
    expectTypeOf<z.infer<typeof snapshotMetaSchema>>().toEqualTypeOf<SnapshotMeta>()
    expectTypeOf<SnapshotMeta['state']>().toEqualTypeOf<HelloOk['state']>()
    expectTypeOf<(typeof SNAPSHOT_SECTIONS)[number]>().toEqualTypeOf<SnapshotSection>()
    expect(HOST_METHOD_SCHEMAS['session.snapshot']).toEqual({
      params: snapshotParamsSchema,
      result: snapshotPageSchema
    })
  })

  it('[ADR-003] the snapshot schemas accept the 14 §3.7 shapes and refuse any other key or section', () => {
    const meta = {
      hostVersion: '0.20.0',
      state: 'ready',
      resetEpoch: 0,
      snapshotTail: 20,
      minesEverKnown: false
    }
    expect(snapshotParamsSchema.safeParse({}).success).toBe(true)
    expect(snapshotParamsSchema.safeParse({ sections: ['meta', 'dwarf-names'] }).success).toBe(true)
    expect(snapshotParamsSchema.safeParse({ snapshotId: 's', cursor: 'c' }).success).toBe(true)
    expect(snapshotParamsSchema.safeParse({ sections: ['tails.v2'] }).success).toBe(false)
    expect(snapshotParamsSchema.safeParse({ limit: 1 }).success).toBe(false)

    expect(snapshotMetaSchema.safeParse(meta).success).toBe(true)
    expect(snapshotMetaSchema.safeParse({ ...meta, state: 'stopped' }).success).toBe(false)
    expect(snapshotMetaSchema.safeParse({ ...meta, resetEpoch: -1 }).success).toBe(false)
    expect(snapshotMetaSchema.safeParse({ ...meta, secret: 'x' }).success).toBe(false)

    const page = { snapshotId: 's', seq: 3, epoch: 'e', chunks: [{ section: 'meta', data: meta }] }
    expect(snapshotPageSchema.safeParse(page).success).toBe(true)
    expect(snapshotPageSchema.safeParse({ ...page, next: 'c' }).success).toBe(true)
    expect(snapshotPageSchema.safeParse({ ...page, seq: -1 }).success).toBe(false)
    expect(
      snapshotPageSchema.safeParse({ ...page, chunks: [{ section: 'meta', data: {} }] }).success
    ).toBe(false)
    expect(
      snapshotPageSchema.safeParse({ ...page, chunks: [{ section: 'drafts', data: [] }] }).success
    ).toBe(false)
    expect(snapshotChunkSchema.safeParse({ section: 'recovery', data: null }).success).toBe(true)
    expect(snapshotChunkSchema.safeParse({ section: 'mines', data: [] }).success).toBe(true)
    expect(
      snapshotChunkSchema.safeParse({ section: 'asks', data: { asks: [], needsYou: [] } }).success
    ).toBe(true)
  })
})
