// Today's shapes of the rows owned by `window` (14 §2.1): the shell window, audio, typography, shortcut,
// launch view, links, clipboard, pickers and the dropped-file helper. Every one is KEEP except A-44 and A-P5.
import { z } from 'zod'
import { MAX_EXTERNAL_LINK_CHARS } from '../../text'
import { legacyStringSchema } from './common'

export const audioPreferencesSchema = z
  .object({
    musicAtStartup: z.boolean(),
    musicVolume: z.number(),
    ambienceVolume: z.number(),
    voiceVolume: z.number(),
    notificationSounds: z.boolean()
  })
  .strict()

const panelEdgeSchema = z.enum(['left', 'right'])

export const panelLayoutSchema = z
  .object({ edge: panelEdgeSchema, mineOpen: z.boolean(), dockOpen: z.boolean() })
  .strict()

export const panelLayoutRequestSchema = z
  .object({ mineOpen: z.boolean(), dockOpen: z.boolean(), edge: panelEdgeSchema.optional() })
  .strict()

export const shortcutStateSchema = z
  .object({
    accelerator: legacyStringSchema,
    registered: z.boolean(),
    error: legacyStringSchema.optional(),
    platform: z.enum(['darwin', 'win32', 'other'])
  })
  .strict()

/** A-21 request: the raw address, at most the `externalLinkOf` ceiling (18 C-02: ≤ 2048 chars). */
export const externalLinkSchema = z.string().max(MAX_EXTERNAL_LINK_CHARS)

const openedOrReasonSchema = z.discriminatedUnion('opened', [
  z.object({ opened: z.literal(true) }).strict(),
  z.object({ opened: z.literal(false), reason: legacyStringSchema }).strict()
])

export const externalLinkResultSchema = openedOrReasonSchema

export const copyTextResultSchema = z.object({ copied: z.boolean() }).strict()

export const attachmentPathsSchema = z.array(legacyStringSchema)

export const appBuildSchema = z
  .object({ version: legacyStringSchema, packaged: z.boolean() })
  .strict()

export const featureFlagsSchema = z.object({ guildAreasEnabled: z.boolean() }).strict()

const typeFaceSchema = z.enum(['jacquard-12', 'tiny5', 'pixelify-sans', 'roboto', 'arial'])

export const typographyPreferencesSchema = z
  .object({
    style: z.enum(['dwarfai', 'pixel-clean', 'readable', 'custom']),
    faces: z
      .object({
        display: typeFaceSchema,
        label: typeFaceSchema,
        meta: typeFaceSchema,
        talk: typeFaceSchema
      })
      .strict()
  })
  .strict()

export const launchViewSchema = z
  .object({
    area: z.enum(['settings', 'map', 'mines', 'lab', 'market', 'laboral-union']),
    mineId: legacyStringSchema.nullable()
  })
  .strict()

/** A-X1 request: a DOM `File` handed to the preload helper (no IPC). */
export const droppedFileSchema = z.custom<File>(
  (value) => typeof File !== 'undefined' && value instanceof File,
  { message: 'expected a File' }
)

/** A-44 today (`setOpenMine`): the open mine interior, or none. */
export const openMineIdSchema = legacyStringSchema.nullable()
