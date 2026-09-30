// `requestId` (14 §1.6): a client-generated UUIDv7 string on every mutating seam-B method.
import { z } from 'zod'

// RFC 9562 layout: version nibble 7, variant bits 10 (8, 9, a or b); hex digits in either case.
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const requestIdSchema = z.string().regex(UUID_V7)
