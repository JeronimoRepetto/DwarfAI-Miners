// The seam-B method registry and router (ADR-003 items 6, 12; 14 §1.4, §1.5, §3.3). Each served
// method is registered once with its strict params schema, the roles that may call it (from the
// roles.ts table) and its handler. A request is answered, in this order:
//
// 1. METHOD_NOT_FOUND — no such method is served (never silence);
// 2. FORBIDDEN — outside the connection's role scope; logged `error` (a defect, FM-035);
// 3. HOST_NOT_READY (retryable) — the Host is `starting` or `migrating` and the method is not in
//    the protocol set;
// 4. INVALID_PARAMS — the params fail the method's schema (FM-031), or a mutating method's params
//    carry no UUIDv7 `requestId` (14 §1.6);
// 5. a mutating method's repeat — the same `requestId` in flight or settled less than 10 min ago —
//    gets the first call's answer from the RequestTable, with no second effect (ADR-003 item 6);
// 6. the handler's result, or INTERNAL when it throws (details in the log only, ADR-026). A
//    mutating handler also receives the `requestId`, so a module can key it durably.
//
// Logging is names only (14 §1.10): the method name of a served method, the correlation fields,
// outcome and error code; never params or results, and never a name the client made up. A repeat
// answered from the table is also logged `channel.dedupe` with its `requestId` only (19 §9.2).
import type { z } from 'zod'
import {
  requestIdSchema,
  type IpcError,
  type IpcErrorCode,
  type resFrameSchema
} from '@dwarfai/contracts'
import type { Clock } from '../kernel/ports/clock'
import type { Scheduler } from '../kernel/ports/scheduler'
import type { DiagnosticEntry, DiagnosticsLog } from '../kernel/ports/diagnosticsLog'
import type { HostStateReport } from '../wiring/boot'
import { MUTATING_METHODS } from './dedupe/mutatingMethods'
import { RequestTable } from './dedupe/requestTable'
import { METHOD_ROLES, PROTOCOL_METHODS, type ChannelRole } from './roles'

/** The `res` frame of 14 §3.2, as its contract schema reads it. */
export type ResponseFrame = z.infer<typeof resFrameSchema>

export interface RequestContext {
  role: ChannelRole
  clientId: string
}

export type MethodHandler<P> = (params: P, context: RequestContext) => unknown

/** What a mutating handler receives: the caller plus the call's validated `requestId`. */
export interface MutatingContext extends RequestContext {
  requestId: string
}

export type MutatingHandler<P> = (params: P, context: MutatingContext) => unknown

export interface DispatcherDeps {
  log: DiagnosticsLog
  clock: Clock
  /** Sweeps settled requestIds at the end of their 10-min window (the clock check is authoritative). */
  scheduler: Scheduler
  /** The Host's lifecycle state right now (HostStateHolder). */
  state: () => HostStateReport['state']
}

interface MethodShape {
  schema: z.ZodTypeAny
  roles: readonly ChannelRole[]
}

type MethodEntry =
  | (MethodShape & { mutating: false; handler: MethodHandler<unknown> })
  | (MethodShape & { mutating: true; handler: MutatingHandler<unknown> })

/** A settled answer without its correlation id: replayed verbatim to a repeat (14 §1.6). */
type Answer =
  | { ok: true; result: Extract<ResponseFrame, { ok: true }>['result'] }
  | { ok: false; error: IpcError; errCode: string }

/** Fixed diagnostics sentences (`IpcError.message` is never copy and never carries a value). */
const MESSAGES: Readonly<Record<IpcErrorCode, string>> = {
  METHOD_NOT_FOUND: 'no such method is served',
  FORBIDDEN: 'the method is outside this connection role scope',
  HOST_NOT_READY: 'the Host is not ready yet',
  INVALID_PARAMS: 'the params do not match the method schema',
  INTERNAL: 'the method failed; see the Host log',
  SENDER_REJECTED: 'the sender was rejected',
  HOST_UNAVAILABLE: 'the Host is unavailable',
  NOT_SUPPORTED: 'the Host does not serve this method',
  SNAPSHOT_EXPIRED: 'the snapshot expired',
  TIMEOUT: 'the call timed out'
}

/** 14 §3.3: retryable for HOST_UNAVAILABLE, HOST_NOT_READY and TIMEOUT. */
const RETRYABLE: ReadonlySet<IpcErrorCode> = new Set([
  'HOST_UNAVAILABLE',
  'HOST_NOT_READY',
  'TIMEOUT'
])

const SUBSYSTEM = 'transport'

export class Dispatcher {
  private readonly entries = new Map<string, MethodEntry>()
  /** One per Host process: it ends with this object and is never persisted (ADR-003 item 6). */
  private readonly requests: RequestTable<Answer>

  constructor(private readonly deps: DispatcherDeps) {
    this.requests = new RequestTable<Answer>({
      clock: deps.clock,
      scheduler: deps.scheduler
    })
  }

  /**
   * Serves a method that does not mutate. Registering one name twice, or a 14 §1.6 mutating
   * method here, is a wiring defect and throws.
   */
  register<S extends z.ZodTypeAny>(
    method: string,
    schema: S,
    roles: readonly ChannelRole[],
    handler: MethodHandler<z.infer<S>>
  ): void {
    if (MUTATING_METHODS.has(method)) {
      throw new Error(`a mutating method needs registerMutating: ${method}`)
    }
    this.add(method, { mutating: false, schema, roles, handler: handler as MethodHandler<unknown> })
  }

  /**
   * Serves a mutating method: its params must carry a UUIDv7 `requestId`, it runs at most once
   * per `requestId`, and its handler receives that `requestId`. A 14 §2.3 method that is not
   * mutating throws here (a wiring defect).
   */
  registerMutating<S extends z.ZodTypeAny>(
    method: string,
    schema: S,
    roles: readonly ChannelRole[],
    handler: MutatingHandler<z.infer<S>>
  ): void {
    if (Object.hasOwn(METHOD_ROLES, method) && !MUTATING_METHODS.has(method)) {
      throw new Error(`method is not mutating (14 §1.6): ${method}`)
    }
    this.add(method, {
      mutating: true,
      schema,
      roles,
      handler: handler as MutatingHandler<unknown>
    })
  }

  /** Every served method name (for `hello.ok.capabilities`). */
  methods(): string[] {
    return [...this.entries.keys()]
  }

  async dispatch(
    request: { id: string; method: string; params: unknown },
    context: RequestContext
  ): Promise<ResponseFrame> {
    const startedAt = this.deps.clock.now()
    const entry = this.entries.get(request.method)
    // A method nobody serves is never logged by name: the name is the client's text.
    const method = entry === undefined ? undefined : request.method
    const settle = (
      res: ResponseFrame,
      extra: Pick<DiagnosticEntry, 'requestId' | 'errCode'> = {}
    ): ResponseFrame => {
      this.record({
        level: 'debug',
        event: 'channel.req',
        connId: context.clientId,
        role: context.role,
        ...(method === undefined ? {} : { method }),
        outcome: res.ok ? 'ok' : 'failed',
        ...(res.ok ? {} : { errCode: res.error.code }),
        durationMs: this.deps.clock.now() - startedAt,
        ...extra
      })
      return res
    }
    const refuse = (code: IpcErrorCode): ResponseFrame =>
      settle({ type: 'res', id: request.id, ok: false, error: callError(code) })

    if (entry === undefined) return refuse('METHOD_NOT_FOUND')
    if (!entry.roles.includes(context.role)) {
      this.record({
        level: 'error',
        event: 'channel.forbidden',
        method: request.method,
        role: context.role,
        connId: context.clientId
      })
      return refuse('FORBIDDEN')
    }
    const state = this.deps.state()
    if ((state === 'starting' || state === 'migrating') && !PROTOCOL_METHODS.has(request.method)) {
      return refuse('HOST_NOT_READY')
    }
    const parsed = entry.schema.safeParse(request.params)
    if (!parsed.success) return refuse('INVALID_PARAMS')
    const params: unknown = parsed.data

    const requestId = requestIdOf(params)
    const answerWith = (answer: Answer): ResponseFrame =>
      answer.ok
        ? settle({ type: 'res', id: request.id, ok: true, result: answer.result }, requestId)
        : settle(
            { type: 'res', id: request.id, ok: false, error: answer.error },
            { ...requestId, errCode: answer.errCode }
          )

    if (!entry.mutating) return answerWith(await runHandler(() => entry.handler(params, context)))
    if (requestId.requestId === undefined) return refuse('INVALID_PARAMS')

    const id = requestId.requestId
    const admission = this.requests.run(id, () =>
      runHandler(() => entry.handler(params, { ...context, requestId: id }))
    )
    if (admission.repeat) this.record({ level: 'debug', event: 'channel.dedupe', requestId: id })
    return answerWith(await admission.outcome)
  }

  private add(method: string, entry: MethodEntry): void {
    if (this.entries.has(method)) throw new Error(`method registered twice: ${method}`)
    this.entries.set(method, entry)
  }

  private record(entry: Omit<DiagnosticEntry, 'subsystem'>): void {
    this.deps.log.record({ ...entry, subsystem: SUBSYSTEM })
  }
}

/** Runs a handler to its answer; a throw becomes INTERNAL, the error reduced to a code. */
async function runHandler(handler: () => unknown): Promise<Answer> {
  try {
    const result: unknown = await handler()
    return { ok: true, result: result === undefined ? {} : result }
  } catch (error) {
    return { ok: false, error: callError('INTERNAL'), errCode: errorCode(error) }
  }
}

function callError(code: IpcErrorCode): IpcError {
  return { code, message: MESSAGES[code], retryable: RETRYABLE.has(code) }
}

/**
 * The validated params' `requestId` (14 §1.6), the one params value the log may carry, and only
 * when it has the UUIDv7 shape the log record accepts.
 */
function requestIdOf(params: unknown): Pick<DiagnosticEntry, 'requestId'> {
  if (typeof params !== 'object' || params === null) return {}
  const requestId = (params as { requestId?: unknown }).requestId
  return typeof requestId === 'string' && requestIdSchema.safeParse(requestId).success
    ? { requestId }
    : {}
}

/** ADR-026 item 5: a thrown error is reduced to its code, else its class name. */
function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' || typeof code === 'number') return String(code)
    if (error instanceof Error) return error.name
  }
  return 'unknown'
}
