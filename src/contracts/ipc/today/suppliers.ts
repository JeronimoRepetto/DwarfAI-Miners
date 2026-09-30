// Today's shapes of the rows owned by `suppliers` (14 §2.1): A-36 today (CHANGE) and A-37 (RETIRE).
import { z } from 'zod'
import { legacyProviderSchema, legacyStringSchema } from './common'

/** A-36 today response (`AgentProviderList`). */
export const agentProviderListSchema = z
  .object({
    providers: z.array(
      z
        .object({
          provider: legacyProviderSchema,
          installed: z.boolean(),
          launchable: z.boolean(),
          reason: legacyStringSchema.optional()
        })
        .strict()
    )
  })
  .strict()

/** A-37 response (`AgentModelCatalogList`). */
export const agentModelCatalogListSchema = z
  .object({
    catalogs: z.array(
      z
        .object({
          provider: legacyProviderSchema,
          models: z.array(
            z
              .object({
                value: legacyStringSchema,
                label: legacyStringSchema.optional(),
                effortLevels: z.array(legacyStringSchema).optional()
              })
              .strict()
          ),
          efforts: z.array(legacyStringSchema),
          source: z.enum(['provider', 'history', 'none'])
        })
        .strict()
    )
  })
  .strict()
