// The `session.snapshot` types of 14 §3.7 (frozen; details in 14 §4) and their strict() schemas (14 §1.4: both
// sides validate every frame). `MineNameWire` and `DwarfNameWire`, which 14 §3.7 also spells, live in
// `wire/names.ts` and are imported here, never restated. Each section's data type is imported from its owner
// (14 §3 intro). The type test in snapshot.test.ts keeps every schema equal to its interface.
import { z } from 'zod'
import {
  askRecordSchema,
  deliverySchema,
  dwarfIdSchema,
  dwarfNameWireSchema,
  dwarfWireSchema,
  hostEpochSchema,
  hostRecoveryReportViewSchema,
  launchWireSchema,
  messageViewSchema,
  mineNameWireSchema,
  mineWireSchema,
  needsYouQueueSchema,
  preferencesViewSchema,
  type AskRecord,
  type Delivery,
  type DwarfId,
  type DwarfNameWire,
  type DwarfWire,
  type HostEpoch,
  type HostRecoveryReportView,
  type LaunchWire,
  type MessageView,
  type MineNameWire,
  type MineWire,
  type NeedsYouQueue,
  type PreferencesView
} from '../wire'
import type { HelloOk } from './adr-003'

// As 14 §3.7 writes them (names, fields and comments; layout by prettier)
export type SnapshotSection =
  | 'meta'
  | 'mines'
  | 'dwarfs'
  | 'asks'
  | 'tails'
  | 'marks'
  | 'launches'
  | 'recovery'
  | 'preferences'
  | 'mine-names'
  | 'dwarf-names' // the notifier's only sections (§4.1)
export interface SnapshotParams {
  sections?: SnapshotSection[] // default: every section the role may read
  snapshotId?: string // continue a paged snapshot
  cursor?: string
}
export interface SnapshotPage {
  snapshotId: string
  seq: number // the seq every page of this snapshot reflects
  epoch: HostEpoch
  chunks: SnapshotChunk[]
  next?: string // cursor; absent on the last page
}
export type SnapshotChunk =
  | { section: 'meta'; data: SnapshotMeta }
  | { section: 'mines'; data: MineWire[] }
  | { section: 'dwarfs'; data: DwarfWire[] }
  | { section: 'asks'; data: { asks: AskRecord[]; needsYou: NeedsYouQueue } }
  | {
      section: 'tails'
      data: Array<{ dwarfId: DwarfId; messages: MessageView[]; reachedStart: boolean }>
    }
  | { section: 'marks'; data: Delivery[] }
  | { section: 'launches'; data: LaunchWire[] }
  | { section: 'recovery'; data: HostRecoveryReportView | null }
  | { section: 'preferences'; data: PreferencesView }
  | { section: 'mine-names'; data: MineNameWire[] }
  | { section: 'dwarf-names'; data: DwarfNameWire[] }
export interface SnapshotMeta {
  hostVersion: string
  state: HelloOk['state']
  resetEpoch: number // resolves N-11-09: compared with UiPreferencesMap.resetEpochApplied (§3.9)
  snapshotTail: number // SNAPSHOT_TAIL in force (§4.1)
  minesEverKnown: boolean // 07 N-11: true once any mine was declared or observed (removed mines count);
  // false again only after Reset metrics (drives Veta's first-run state, machine 20)
}
// end: as 14 §3.7 writes them

/** Every section name of 14 §3.7. */
export const SNAPSHOT_SECTIONS = [
  'meta',
  'mines',
  'dwarfs',
  'asks',
  'tails',
  'marks',
  'launches',
  'recovery',
  'preferences',
  'mine-names',
  'dwarf-names'
] as const satisfies readonly SnapshotSection[]

/** The data of one section's chunk. */
export type SnapshotSectionData<S extends SnapshotSection> = Extract<
  SnapshotChunk,
  { section: S }
>['data']

export const snapshotSectionSchema = z.enum(SNAPSHOT_SECTIONS)

export const snapshotParamsSchema = z
  .object({
    sections: z.array(snapshotSectionSchema).optional(),
    snapshotId: z.string().optional(),
    cursor: z.string().optional()
  })
  .strict()

export const snapshotMetaSchema = z
  .object({
    hostVersion: z.string(),
    state: z.enum(['starting', 'migrating', 'ready', 'upgrade-pending']),
    resetEpoch: z.number().int().nonnegative(),
    snapshotTail: z.number().int().nonnegative(),
    minesEverKnown: z.boolean()
  })
  .strict()

export const snapshotChunkSchema = z.discriminatedUnion('section', [
  z.object({ section: z.literal('meta'), data: snapshotMetaSchema }).strict(),
  z.object({ section: z.literal('mines'), data: z.array(mineWireSchema) }).strict(),
  z.object({ section: z.literal('dwarfs'), data: z.array(dwarfWireSchema) }).strict(),
  z
    .object({
      section: z.literal('asks'),
      data: z.object({ asks: z.array(askRecordSchema), needsYou: needsYouQueueSchema }).strict()
    })
    .strict(),
  z
    .object({
      section: z.literal('tails'),
      data: z.array(
        z
          .object({
            dwarfId: dwarfIdSchema,
            messages: z.array(messageViewSchema),
            reachedStart: z.boolean()
          })
          .strict()
      )
    })
    .strict(),
  z.object({ section: z.literal('marks'), data: z.array(deliverySchema) }).strict(),
  z.object({ section: z.literal('launches'), data: z.array(launchWireSchema) }).strict(),
  z
    .object({ section: z.literal('recovery'), data: hostRecoveryReportViewSchema.nullable() })
    .strict(),
  z.object({ section: z.literal('preferences'), data: preferencesViewSchema }).strict(),
  z.object({ section: z.literal('mine-names'), data: z.array(mineNameWireSchema) }).strict(),
  z.object({ section: z.literal('dwarf-names'), data: z.array(dwarfNameWireSchema) }).strict()
])

export const snapshotPageSchema = z
  .object({
    snapshotId: z.string(),
    seq: z.number().int().nonnegative(),
    epoch: hostEpochSchema,
    chunks: z.array(snapshotChunkSchema),
    next: z.string().optional()
  })
  .strict()
