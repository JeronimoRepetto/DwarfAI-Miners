// L6 (17 §1.6): the seam-B envelope, frame and call-error contracts of ADR-003 item 5 and 14 §1.3–§1.6, §3.2–§3.3.
import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import {
  helloOkSchema,
  helloSchema,
  mcpHelloSchema,
  type Hello,
  type HelloOk,
  type McpHello
} from './adr-003'
import { frameCapability, isAdvertised, methodCapability, sectionCapability } from './capabilities'
import {
  ipcErrorCodeSchema,
  ipcErrorSchema,
  ipcResultSchema,
  outcomeSchema,
  type IpcError,
  type IpcErrorCode,
  type IpcResult,
  type Outcome,
  type ProtocolErrorCode
} from './errors'
import {
  clientFrameSchema,
  errorFrameSchema,
  reqFrameSchema,
  evtFrameSchema,
  hostFrameSchema,
  resFrameSchema,
  serverFrameSchema,
  type ClientFrame,
  type ErrorFrame,
  type EvtFrame,
  type HostFrame,
  type HostFrameData,
  type HostFrameName,
  type HostMethod,
  type HostParams,
  type HostResult,
  type ReqFrame,
  type ResFrame,
  type ServerFrame
} from './envelope'
import { requestIdSchema } from './requestId'

// TC-008-04: a local augmentation standing in for the entry a later issue adds to methods.ts / frames.ts.
declare module './methods' {
  interface HostMethods {
    'contract.augmented': { params: { text: string }; result: { echoed: string } }
  }
}
declare module './frames' {
  interface HostFrames {
    'contract.augmented': { count: number }
  }
}

/** The frame with one key dropped. */
const without = (frame: object, key: string): Record<string, unknown> => {
  const copy: Record<string, unknown> = { ...frame }
  delete copy[key]
  return copy
}

const uiHello = {
  type: 'hello',
  endpointGeneration: 1,
  protocolVersion: 7,
  role: 'ui',
  token: 'ab12',
  client: { appVersion: '1.0.0', buildId: 'build-1', pid: 4242 }
}

const mcpHello = {
  type: 'hello',
  endpointGeneration: 1,
  protocolVersion: 7,
  role: 'mcp',
  launchId: 'launch-1',
  credential: 'cd34'
}

const helloOk = {
  type: 'hello.ok',
  hostVersion: '1.0.0',
  buildId: 'build-1',
  protocolVersion: 7,
  endpointGeneration: 1,
  epoch: 'epoch-1',
  state: 'ready',
  jobStatus: 'n/a',
  capabilities: ['conversation.send', 'frame:dwarf.arrived', 'section:launches'],
  clientId: 'client-1'
}

describe('Hello and HelloOk (ADR-003 item 5)', () => {
  it('[ADR-003] a hello with role ui, notifier or viewer and generation 1 parses; any other role or generation is refused', () => {
    for (const role of ['ui', 'notifier', 'viewer']) {
      expect(helloSchema.safeParse({ ...uiHello, role }).success).toBe(true)
    }
    expect(
      helloSchema.safeParse({
        ...uiHello,
        role: 'viewer',
        viewId: 'view-1',
        resume: { epoch: 'epoch-1', lastSeq: 12 }
      }).success
    ).toBe(true)
    for (const role of ['mcp', 'viewer2', 'admin', '']) {
      expect(helloSchema.safeParse({ ...uiHello, role }).success).toBe(false)
    }
    for (const endpointGeneration of [0, 2, '1']) {
      expect(helloSchema.safeParse({ ...uiHello, endpointGeneration }).success).toBe(false)
    }
  })

  it('[ADR-003] an McpHello is a different shape: role mcp with launchId and credential, never accepted by the UI Hello schema', () => {
    expect(mcpHelloSchema.safeParse(mcpHello).success).toBe(true)
    expect(helloSchema.safeParse(mcpHello).success).toBe(false)
    expect(mcpHelloSchema.safeParse(uiHello).success).toBe(false)
    expect(mcpHelloSchema.safeParse({ ...mcpHello, role: 'ui' }).success).toBe(false)
    expect(mcpHelloSchema.safeParse(without(mcpHello, 'credential')).success).toBe(false)
    expect(mcpHelloSchema.safeParse({ ...mcpHello, token: 'ab12' }).success).toBe(false)
  })

  it('[ADR-003] HelloOk requires state, jobStatus, capabilities and clientId with their literal unions', () => {
    expect(helloOkSchema.safeParse(helloOk).success).toBe(true)
    for (const state of ['starting', 'migrating', 'ready', 'upgrade-pending']) {
      expect(helloOkSchema.safeParse({ ...helloOk, state }).success).toBe(true)
    }
    for (const jobStatus of ['none', 'breakaway-ok', 'in-job', 'n/a']) {
      expect(helloOkSchema.safeParse({ ...helloOk, jobStatus }).success).toBe(true)
    }
    expect(helloOkSchema.safeParse({ ...helloOk, state: 'stopping' }).success).toBe(false)
    expect(helloOkSchema.safeParse({ ...helloOk, jobStatus: 'breakaway' }).success).toBe(false)
    expect(helloOkSchema.safeParse({ ...helloOk, capabilities: 'conversation.send' }).success).toBe(
      false
    )
    for (const key of ['state', 'jobStatus', 'capabilities', 'clientId']) {
      expect(helloOkSchema.safeParse(without(helloOk, key)).success).toBe(false)
    }
  })
})

const req = { type: 'req', id: 'c-1', method: 'conversation.send', params: { text: 'hi' } }
const resOk = { type: 'res', id: 'c-1', ok: true, result: { messageId: 'm-1' } }
const resError = {
  type: 'res',
  id: 'c-1',
  ok: false,
  error: { code: 'METHOD_NOT_FOUND', message: 'unknown method', retryable: false }
}
const evt = {
  type: 'evt',
  seq: 1,
  epoch: 'epoch-1',
  name: 'dwarf.arrived',
  data: { announce: true }
}
const errorFrame = { type: 'error', code: 'AUTH_FAILED' }

describe('frames (14 §3.2)', () => {
  it('[ADR-003] req, res, evt and error frames parse with strict schemas and reject extra keys', () => {
    expect(reqFrameSchema.safeParse(req).success).toBe(true)
    expect(reqFrameSchema.safeParse({ ...req, requestId: 'x' }).success).toBe(false)
    expect(reqFrameSchema.safeParse({ ...req, id: 1 }).success).toBe(false)
    expect(reqFrameSchema.safeParse({ ...req, method: 7 }).success).toBe(false)
    expect(reqFrameSchema.safeParse({ ...req, type: 'request' }).success).toBe(false)
    for (const key of ['type', 'id', 'method', 'params']) {
      expect(reqFrameSchema.safeParse(without(req, key)).success).toBe(false)
    }

    expect(resFrameSchema.safeParse(resOk).success).toBe(true)
    expect(resFrameSchema.safeParse(resError).success).toBe(true)
    expect(resFrameSchema.safeParse({ ...resOk, extra: true }).success).toBe(false)
    expect(resFrameSchema.safeParse({ ...resError, result: {} }).success).toBe(false)
    expect(resFrameSchema.safeParse({ ...resOk, ok: 'true' }).success).toBe(false)
    expect(
      resFrameSchema.safeParse({ ...resError, error: { ...resError.error, stack: 'x' } }).success
    ).toBe(false)
    for (const key of ['type', 'id', 'ok', 'result']) {
      expect(resFrameSchema.safeParse(without(resOk, key)).success).toBe(false)
    }
    expect(resFrameSchema.safeParse(without(resError, 'error')).success).toBe(false)

    expect(evtFrameSchema.safeParse(evt).success).toBe(true)
    expect(evtFrameSchema.safeParse({ ...evt, id: 'c-1' }).success).toBe(false)
    expect(evtFrameSchema.safeParse({ ...evt, name: 3 }).success).toBe(false)
    expect(evtFrameSchema.safeParse({ ...evt, type: 'event' }).success).toBe(false)
    for (const key of ['type', 'seq', 'epoch', 'name', 'data']) {
      expect(evtFrameSchema.safeParse(without(evt, key)).success).toBe(false)
    }

    expect(errorFrameSchema.safeParse(errorFrame).success).toBe(true)
    for (const code of [
      'PROTOCOL_ERROR',
      'HELLO_TIMEOUT',
      'INCOMPATIBLE_GENERATION',
      'RATE_LIMITED'
    ]) {
      expect(errorFrameSchema.safeParse({ type: 'error', code }).success).toBe(true)
    }
    expect(errorFrameSchema.safeParse({ type: 'error', code: 'FORBIDDEN' }).success).toBe(false)
    expect(errorFrameSchema.safeParse({ ...errorFrame, message: 'bad token' }).success).toBe(false)
    expect(errorFrameSchema.safeParse(without(errorFrame, 'code')).success).toBe(false)

    expect(clientFrameSchema.safeParse(uiHello).success).toBe(true)
    expect(clientFrameSchema.safeParse(req).success).toBe(true)
    expect(clientFrameSchema.safeParse(mcpHello).success).toBe(false)
    expect(clientFrameSchema.safeParse(resOk).success).toBe(false)

    for (const frame of [helloOk, resOk, resError, evt, errorFrame]) {
      expect(serverFrameSchema.safeParse(frame).success).toBe(true)
    }
    for (const frame of [uiHello, req, { ...evt, extra: 1 }, { ...helloOk, extra: 1 }]) {
      expect(serverFrameSchema.safeParse(frame).success).toBe(false)
    }
    expect(hostFrameSchema.safeParse(evt).success).toBe(true)
    for (const frame of [helloOk, resOk, errorFrame]) {
      expect(hostFrameSchema.safeParse(frame).success).toBe(false)
    }
  })

  it('[ADR-003] an evt frame needs a positive integer seq and the Host epoch', () => {
    expect(evtFrameSchema.safeParse({ ...evt, seq: 1 }).success).toBe(true)
    expect(evtFrameSchema.safeParse({ ...evt, seq: 9007 }).success).toBe(true)
    for (const seq of [0, -1, 1.5, '1', Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(evtFrameSchema.safeParse({ ...evt, seq }).success).toBe(false)
    }
    expect(evtFrameSchema.safeParse(without(evt, 'epoch')).success).toBe(false)
    expect(evtFrameSchema.safeParse({ ...evt, epoch: 1 }).success).toBe(false)
    expect(evtFrameSchema.safeParse({ ...evt, epoch: null }).success).toBe(false)
  })
})

const IPC_ERROR_CODES = [
  'INVALID_PARAMS',
  'SENDER_REJECTED',
  'HOST_UNAVAILABLE',
  'HOST_NOT_READY',
  'NOT_SUPPORTED',
  'METHOD_NOT_FOUND',
  'FORBIDDEN',
  'SNAPSHOT_EXPIRED',
  'TIMEOUT',
  'INTERNAL'
] as const

const callError: IpcError = {
  code: 'HOST_NOT_READY',
  message: 'host is migrating',
  retryable: true
}

describe('call errors (14 §3.3)', () => {
  it('[ADR-003] IpcErrorCode has exactly the ten codes of 14 §3.3', () => {
    expectTypeOf<IpcErrorCode>().toEqualTypeOf<(typeof IPC_ERROR_CODES)[number]>()
    expect(ipcErrorCodeSchema.options).toEqual(IPC_ERROR_CODES)
    expect(ipcErrorSchema.safeParse(callError).success).toBe(true)
    expect(ipcErrorSchema.safeParse({ ...callError, code: 'NOT_FOUND' }).success).toBe(false)
    expect(ipcErrorSchema.safeParse({ ...callError, retryable: 'yes' }).success).toBe(false)
    expect(ipcErrorSchema.safeParse({ ...callError, detail: 'x' }).success).toBe(false)
  })

  it('[ADR-003] Outcome and IpcResult discriminate on ok, value and error', () => {
    const result = ipcResultSchema(z.number())
    expect(result.safeParse({ ok: true, value: 3 }).success).toBe(true)
    expect(result.safeParse({ ok: false, error: callError }).success).toBe(true)
    expect(result.safeParse({ ok: true, error: callError }).success).toBe(false)
    expect(result.safeParse({ ok: false, value: 3 }).success).toBe(false)
    expect(result.safeParse({ ok: true, value: 'three' }).success).toBe(false)
    expect(result.safeParse({ ok: false, error: 'HOST_NOT_READY' }).success).toBe(false)
    expect(result.safeParse({ ok: true, value: 3, error: callError }).success).toBe(false)

    const outcome = outcomeSchema(z.number(), z.enum(['not-open', 'already-answered']))
    expect(outcome.safeParse({ ok: true, value: 3 }).success).toBe(true)
    expect(outcome.safeParse({ ok: false, error: 'not-open' }).success).toBe(true)
    expect(outcome.safeParse({ ok: false, error: 'stale' }).success).toBe(false)
    expect(outcome.safeParse({ ok: false, error: callError }).success).toBe(false)
    expect(outcome.safeParse({ ok: false, value: 3 }).success).toBe(false)

    const results: IpcResult<number>[] = [
      { ok: true, value: 3 },
      { ok: false, error: callError }
    ]
    for (const r of results) {
      if (r.ok) expectTypeOf(r.value).toEqualTypeOf<number>()
      else expectTypeOf(r.error).toEqualTypeOf<IpcError>()
    }
    const outcomes: Outcome<number, 'not-open'>[] = [
      { ok: true, value: 3 },
      { ok: false, error: 'not-open' }
    ]
    for (const o of outcomes) {
      if (o.ok) expectTypeOf(o.value).toEqualTypeOf<number>()
      else expectTypeOf(o.error).toEqualTypeOf<'not-open'>()
    }
  })
})

describe('capabilities (14 §1.3)', () => {
  it('[ADR-027] method, frame and section capability names are the exact strings of 14 §1.3', () => {
    expect(methodCapability('conversation.send')).toBe('conversation.send')
    expect(frameCapability('dwarf.arrived')).toBe('frame:dwarf.arrived')
    expect(sectionCapability('launches')).toBe('section:launches')
    expectTypeOf(frameCapability('dwarf.arrived')).toEqualTypeOf<'frame:dwarf.arrived'>()
    expectTypeOf(sectionCapability('launches')).toEqualTypeOf<'section:launches'>()

    const advertised = helloOk.capabilities
    expect(isAdvertised(advertised, 'conversation.send')).toBe(true)
    expect(isAdvertised(advertised, frameCapability('dwarf.arrived'))).toBe(true)
    expect(isAdvertised(advertised, sectionCapability('launches'))).toBe(true)
    expect(isAdvertised(advertised, 'dwarf.arrived')).toBe(false)
    expect(isAdvertised(advertised, 'launches')).toBe(false)
    expect(isAdvertised(advertised, 'conversation.send.v2')).toBe(false)
    expect(isAdvertised(['conversation.send.v2'], 'conversation.send')).toBe(false)
    expect(isAdvertised(advertised, 'Conversation.Send')).toBe(false)
  })
})

describe('requestId (14 §1.6)', () => {
  it('[ADR-003] requestId accepts a UUIDv7 and refuses a v4 UUID or a free string', () => {
    expect(requestIdSchema.safeParse('01890a5d-ac96-774b-bcce-b302099a8057').success).toBe(true)
    expect(requestIdSchema.safeParse('01890A5D-AC96-774B-BCCE-B302099A8057').success).toBe(true)
    expect(requestIdSchema.safeParse('9b2f6c1e-3d4a-4f5b-8c6d-7e8f9a0b1c2d').success).toBe(false)
    expect(requestIdSchema.safeParse('01890a5d-ac96-774b-ccce-b302099a8057').success).toBe(false)
    expect(requestIdSchema.safeParse('send-1').success).toBe(false)
    expect(requestIdSchema.safeParse('').success).toBe(false)
    expect(requestIdSchema.safeParse(' 01890a5d-ac96-774b-bcce-b302099a8057').success).toBe(false)
    expect(requestIdSchema.safeParse(42).success).toBe(false)
  })
})

describe('type tests (17 §1.6: wire types = contract types)', () => {
  it('[ADR-003] the zod-inferred types equal Hello, McpHello, HelloOk and the 14 §3.2–§3.3 types', () => {
    expectTypeOf<z.infer<typeof helloSchema>>().toEqualTypeOf<Hello>()
    expectTypeOf<z.infer<typeof mcpHelloSchema>>().toEqualTypeOf<McpHello>()
    expectTypeOf<z.infer<typeof helloOkSchema>>().toEqualTypeOf<HelloOk>()
    expectTypeOf<z.infer<typeof errorFrameSchema>>().toEqualTypeOf<ErrorFrame>()
    expectTypeOf<z.infer<typeof ipcErrorSchema>>().toEqualTypeOf<IpcError>()
    expectTypeOf<z.infer<typeof ipcErrorCodeSchema>>().toEqualTypeOf<IpcErrorCode>()
    expectTypeOf<z.infer<ReturnType<typeof ipcResultSchema<z.ZodNumber>>>>().toEqualTypeOf<
      IpcResult<number>
    >()
    type Refusal = z.ZodEnum<['not-open', 'already-answered']>
    expectTypeOf<z.infer<ReturnType<typeof outcomeSchema<z.ZodNumber, Refusal>>>>().toEqualTypeOf<
      Outcome<number, 'not-open' | 'already-answered'>
    >()
    // The envelope schemas check the frame; the payload is typed by the method's catalog entry, so every
    // contract frame is a valid envelope and the envelope carries nothing the contract lacks.
    expectTypeOf<ReqFrame>().toExtend<z.infer<typeof reqFrameSchema>>()
    expectTypeOf<ResFrame>().toExtend<z.infer<typeof resFrameSchema>>()
    expectTypeOf<ClientFrame>().toExtend<z.infer<typeof clientFrameSchema>>()
    expectTypeOf<keyof z.infer<typeof reqFrameSchema>>().toEqualTypeOf<keyof ReqFrame>()
    expectTypeOf<EvtFrame>().toExtend<z.infer<typeof evtFrameSchema>>()
    expectTypeOf<keyof z.infer<typeof evtFrameSchema>>().toEqualTypeOf<keyof EvtFrame>()
    expectTypeOf<EvtFrame['epoch']>().toEqualTypeOf<z.infer<typeof evtFrameSchema>['epoch']>()
    expectTypeOf<EvtFrame['seq']>().toEqualTypeOf<z.infer<typeof evtFrameSchema>['seq']>()
    expectTypeOf<ServerFrame>().toExtend<z.infer<typeof serverFrameSchema>>()
    expectTypeOf<HostFrame>().toEqualTypeOf<EvtFrame>()
    expectTypeOf<HostFrame>().toExtend<z.infer<typeof hostFrameSchema>>()
    expectTypeOf<ProtocolErrorCode>().toEqualTypeOf<
      | 'AUTH_FAILED'
      | 'PROTOCOL_ERROR'
      | 'HELLO_TIMEOUT'
      | 'INCOMPATIBLE_GENERATION'
      | 'RATE_LIMITED'
    >()
  })

  it('[ADR-003] an entry added to HostMethods or HostFrames reaches HostMethod, HostParams, HostResult, HostFrameName and HostFrameData', () => {
    expectTypeOf<'contract.augmented'>().toExtend<HostMethod>()
    expectTypeOf<HostParams['contract.augmented']>().toEqualTypeOf<{ text: string }>()
    expectTypeOf<HostResult['contract.augmented']>().toEqualTypeOf<{ echoed: string }>()
    expectTypeOf<'contract.augmented'>().toExtend<HostFrameName>()
    expectTypeOf<HostFrameData['contract.augmented']>().toEqualTypeOf<{ count: number }>()
    expectTypeOf<ReqFrame<'contract.augmented'>['params']>().toEqualTypeOf<{ text: string }>()
    expectTypeOf<EvtFrame<'contract.augmented'>['data']>().toEqualTypeOf<{ count: number }>()
    const frame: ReqFrame<'contract.augmented'> = {
      type: 'req',
      id: 'c-2',
      method: 'contract.augmented',
      params: { text: 'hi' }
    }
    expect(reqFrameSchema.safeParse(frame).success).toBe(true)
  })
})
