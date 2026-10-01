// The seam-B method catalog (14 §3.4): one `'<name>': { params; result }` entry per UI → Host request.
// Each entry lands here, in this file, with the issue that serves its handler (hot spot, 22 §5); `hello` is the
// first frame, not a method. HostMethod, HostParams and HostResult derive from it once, in envelope.ts.
//
// Each entry has its strict() params and result schemas in HOST_METHOD_SCHEMAS (14 §1.4: both sides validate
// every frame); the type test in methods.test.ts keeps every schema equal to its interface entry. The mapping is
// Partial only because a test may merge a method of its own into HostMethods.
import { z } from 'zod'
import { instantSchema, type Instant } from '../wire'

// An interface, not a type alias, so that entries merge into it.
// verbatim: 14 §3.4 (the B-M02 entry, byte-for-byte; `prettier-ignore` keeps its alignment)
// prettier-ignore
export interface HostMethods {
  // protocol
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- 14 §3.4 spells the empty params as {}
  'ping':                            { params: {}; result: { at: Instant } }
}
// end verbatim: 14 §3.4

/** The strict() schemas of each method's `params` and `result`, by method name. */
export const HOST_METHOD_SCHEMAS = {
  ping: {
    params: z.object({}).strict(),
    result: z.object({ at: instantSchema }).strict()
  }
} as const satisfies Partial<{
  [M in keyof HostMethods]: {
    params: z.ZodType<HostMethods[M]['params']>
    result: z.ZodType<HostMethods[M]['result']>
  }
}>
