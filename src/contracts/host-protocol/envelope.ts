// contracts/host-protocol/ (05 §2.1): the seam-B envelope of 14 §3.2 and the strict() schemas both sides validate
// every frame with (ADR-003 item 6, 14 §1.4). The envelope schemas check the frame itself; each method's params and
// result and each frame's data are checked by that name's own schema, registered with its catalog entry.
import { z } from 'zod'
import { helloOkSchema, helloSchema, type Hello, type HelloOk } from './adr-003'
import {
  ipcErrorSchema,
  protocolErrorCodeSchema,
  type IpcError,
  type ProtocolErrorCode
} from './errors'
import type { HostFrames } from './frames'
import type { HostMethods } from './methods'
import { hostEpochSchema, type HostEpoch } from '../wire'

export type HostMethod = keyof HostMethods
export type HostParams = { [M in HostMethod]: HostMethods[M]['params'] }
export type HostResult = { [M in HostMethod]: HostMethods[M]['result'] }
export type HostFrameName = keyof HostFrames
export type HostFrameData = HostFrames

export interface ReqFrame<M extends HostMethod = HostMethod> {
  type: 'req'
  id: string // per-connection correlation id (not the requestId)
  method: M
  params: HostParams[M]
}
export type ResFrame<M extends HostMethod = HostMethod> =
  | { type: 'res'; id: string; ok: true; result: HostResult[M] }
  | { type: 'res'; id: string; ok: false; error: IpcError }
export interface EvtFrame<F extends HostFrameName = HostFrameName> {
  type: 'evt'
  seq: number // per-connection, monotonic, starts at 1 after hello.ok
  epoch: HostEpoch // Host boot id (ADR-003 HelloOk.epoch)
  name: F
  data: HostFrameData[F]
}
export interface ErrorFrame {
  type: 'error'
  code: ProtocolErrorCode
} // before hello.ok only, then close
export type ClientFrame = Hello | ReqFrame
export type ServerFrame = HelloOk | ResFrame | EvtFrame | ErrorFrame

/** What seam A relays to renderers (A-N02): exactly the Host's evt frames, in seq order. */
export type HostFrame = EvtFrame

// A payload key must be present: a decoded JSON frame only holds `undefined` where the key is missing.
const payload = z.unknown().refine((value) => value !== undefined, { message: 'Required' })

export const reqFrameSchema = z
  .object({ type: z.literal('req'), id: z.string(), method: z.string(), params: payload })
  .strict()

export const resFrameSchema = z.discriminatedUnion('ok', [
  z
    .object({ type: z.literal('res'), id: z.string(), ok: z.literal(true), result: payload })
    .strict(),
  z
    .object({ type: z.literal('res'), id: z.string(), ok: z.literal(false), error: ipcErrorSchema })
    .strict()
])

export const evtFrameSchema = z
  .object({
    type: z.literal('evt'),
    seq: z.number().int().positive(),
    epoch: hostEpochSchema,
    name: z.string(),
    data: payload
  })
  .strict()

export const errorFrameSchema = z
  .object({ type: z.literal('error'), code: protocolErrorCodeSchema })
  .strict()

/** What the UI endpoint accepts from a client: its `Hello` first, then `req` frames (ADR-003 item 12). */
export const clientFrameSchema = z.discriminatedUnion('type', [helloSchema, reqFrameSchema])

/** What a client accepts from the Host: `HelloOk` first, then `res` and `evt` frames; `error` only before hello.ok. */
export const serverFrameSchema = z.union([
  helloOkSchema,
  resFrameSchema,
  evtFrameSchema,
  errorFrameSchema
])

/** What seam A relays to renderers (A-N02): exactly the Host's evt frames. */
export const hostFrameSchema = evtFrameSchema
