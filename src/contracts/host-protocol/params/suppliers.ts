// Seam-B params of `suppliers.launchable` that A-36 relays unchanged (14 §3.4, §1.2).
import { z } from 'zod'

/** The params of `suppliers.launchable`, written inline in 14 §3.4: `{ refresh?: boolean }`. */
export const suppliersLaunchableParamsSchema = z
  .object({ refresh: z.boolean().optional() })
  .strict()
