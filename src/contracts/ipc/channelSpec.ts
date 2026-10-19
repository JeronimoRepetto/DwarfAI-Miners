// ChannelSpec: the shape of every entry of the channel registry (ADR-019 item 6).
// verbatim: ADR-019 item 6 — the code block with its list indentation removed; the one added line is the
// prettier-ignore directive that keeps the aligned comments byte-identical.
import { z } from 'zod'
// prettier-ignore
export interface ChannelSpec<Req extends z.ZodTypeAny, Res extends z.ZodTypeAny> {
  name: string                                   // wire name, unique
  kind: 'invoke' | 'send' | 'push'
  placement: 'ui-local' | 'host' | 'split'       // ipc-inventory §3b, ADR-001
  status: 'kept' | 'changed' | 'new' | 'retired' // 14-ipc-contract; Veta/Valle = 'new' (ADR-034)
  request: Req                                   // z.object(...).strict(); the target shape. A row whose today shape differs (CHANGE, RETIRE) keeps { request, response } of today in the sibling map TODAY_SHAPES (21 §1 item 2a); a KEEP row's today shape is this one
  response: Res
  sensitive?: boolean                            // payload never logged (ADR-026)
}
