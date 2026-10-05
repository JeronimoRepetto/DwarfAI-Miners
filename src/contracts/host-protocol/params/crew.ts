// Seam-B types of the crew rows (14 §3.4, §3.5): the B-F10 `dwarf.departed` cause.
import { z } from 'zod'

// As 06 §0.2 writes it (crew `DepartureCause`, VO): the `sessionClosed` causes plus the two recovery ones (OQ-43)
export type DepartureCause =
  | 'stopped'
  | 'mine-removed'
  | 'closed-elsewhere'
  | 'crashed'
  | 'recovery-dismissed'
  | 'recovery-failed'

export const departureCauseSchema = z.enum([
  'stopped',
  'mine-removed',
  'closed-elsewhere',
  'crashed',
  'recovery-dismissed',
  'recovery-failed'
])
