import type { DwarfProvider, TurnOutcome, TurnOutcomeKind } from '../domain/types'

/**
 * The wire contract between the stdio MCP server this app injects into a
 * launched session (this file, T2) and main's own loopback listener (T3) —
 * pure so both sides, and this file's own tests, can be proven with no
 * Node import beyond ambient types and no network at all (#511).
 *
 * Nothing here decides ANYTHING about routing, limits or launching — see
 * `delegationGate.ts` (T1) for the gate and T3's delegation service for the
 * actual ticket registry. This module only says what bytes cross the wire
 * and what they mean.
 */

/* --- Env the injecting adapter (T4) sets on the launched child ------------ */

/** `http://127.0.0.1:<port>` — main's own loopback origin for this launch. */
export const DELEGATION_ENDPOINT_ENV = 'DWARFAI_DELEGATION_ENDPOINT'
/** The per-launch shared secret, carried in `DELEGATION_TOKEN_HEADER`. */
export const DELEGATION_TOKEN_ENV = 'DWARFAI_DELEGATION_TOKEN'
/** How long `delegate_subtask` may block before answering `pending` (ms). */
export const DELEGATION_WAIT_MS_ENV = 'DWARFAI_DELEGATION_WAIT_MS'

/**
 * Codex documents a 60s default `tool_timeout_sec` for its own MCP calls
 * (feature document, Evidence section) — this app's own default sits below
 * that ceiling so a `pending` ticket answer reaches the agent before the
 * CALLING CLI'S OWN timer would have cut the tool call off with nothing
 * typed. An adapter may raise this per provider for one with no per-request
 * timer (T4's decision, not this module's).
 */
export const DEFAULT_DELEGATION_WAIT_MS = 50_000

/* --- Loopback wire shape --------------------------------------------------- */

/**
 * Mirrors `HOOK_TOKEN_HEADER` in `hooks/hookCommand.ts` EXACTLY — same
 * per-install-shared-secret shape, same lowercase-header discipline (Node
 * lowercases incoming header names) — but declared independently rather than
 * imported: `mcp/` and `hooks/` are separate subjects (AGENTS.md's `src/`
 * index), each reaching main over its own listener, and this wire constant
 * is this subject's own contract, not a reuse of the other one's.
 */
export const DELEGATION_TOKEN_HEADER = 'x-dwarfai-token'

export const DELEGATE_ROUTE = '/delegate'
const RESULT_ROUTE_PREFIX = '/result/'

/** `GET` route for one ticket. URL-encoded, so T3's router and this link agree on the exact byte shape. */
export function resultRoute(ticket: string): string {
  return `${RESULT_ROUTE_PREFIX}${encodeURIComponent(ticket)}`
}

/**
 * Largest `/delegate` body this wire accepts, mirroring `MAX_HOOK_BODY_BYTES`'s
 * own cap-before-parse style (`hooks/hookServer.ts`) — sized for a subtask's
 * prose rather than a terse hook payload, but still a hard ceiling so T3's
 * listener never buffers an unbounded body before the token is even checked.
 */
export const MAX_DELEGATION_BODY_BYTES = 32_768
/** Bound on `delegate_subtask`'s own `task` argument (the zod schema in jevMcpServerCore.ts enforces this). */
export const MAX_DELEGATION_TASK_CHARS = 4_000
/** Bound on `delegate_subtask`'s own `context` argument. */
export const MAX_DELEGATION_CONTEXT_CHARS = 16_000

export const DELEGATE_SUBTASK_TOOL_NAME = 'delegate_subtask'
export const SUBTASK_RESULT_TOOL_NAME = 'subtask_result'

/** What a launch was routed to, echoed back on `/delegate`'s 202 and on a `pending` tool result. */
export interface DelegationRouting {
  provider: DwarfProvider
  model?: string
  effort?: string
}

export interface DelegateRequestBody {
  task: string
  context?: string
}

export interface DelegateAcceptedBody {
  ticket: string
  routing: DelegationRouting
}

export interface DelegateRefusedBody {
  failure: DelegationFailure
}

/**
 * `pending` carries `routing` here too — not only on `/delegate`'s own 202 —
 * so `subtask_result` can answer the same fully-typed `DelegationToolResult`
 * as `delegate_subtask` without the link keeping its own cache of a fact
 * main already owns. Main knows a ticket's routing for its whole life (it is
 * what launched the child), so echoing it back costs main nothing and keeps
 * the link a stateless forwarder.
 */
export type ResultBody =
  | { status: 'pending'; routing: DelegationRouting }
  | { status: 'done'; outcome: TurnOutcome }
  | { status: 'failed'; failure: DelegationFailure }

/** What the two MCP tools hand back to the agent that called them — the ONE typed shape (#511). */
export type DelegationToolResult =
  | { status: 'done'; outcome: TurnOutcome }
  | { status: 'pending'; ticket: string; routing: DelegationRouting }
  | { status: 'failed'; failure: DelegationFailure }

/**
 * Every real, named way a subtask delegation can fail to become a
 * `TurnOutcome` — never a generic "failed", so the agent that receives one
 * can always say (to itself, or to a person) exactly why. `detail` is a
 * short human sentence; see `delegationFailure` for the rule that keeps the
 * fallback instruction attached to it.
 */
export type DelegationFailureKind =
  | 'disabled'
  | 'jev-unreachable'
  | 'jev-unsure'
  | 'provider-not-launchable'
  | 'concurrency-limit'
  | 'depth-exceeded'
  | 'unknown-ticket'
  | 'link-unconfigured'
  | 'link-unreachable'
  | 'invalid-response'

export interface DelegationFailure {
  kind: DelegationFailureKind
  detail: string
}

/**
 * The one sentence every refusal must carry (#511): a parent agent that
 * cannot delegate must not sit idle waiting on a tool that will never
 * resolve into work — it must fall back to whatever subagent mechanism it
 * already has. Put in the tool descriptions too (jevMcpServerCore.ts), so it
 * reaches the agent whether it reads the schema or the result.
 */
export const NATIVE_SUBAGENT_FALLBACK_SENTENCE =
  'Use your own native subagent mechanism for this subtask instead.'

/**
 * The ONLY way a `DelegationFailure` should be constructed (link.ts,
 * jevMcpServerCore.ts, and T3's own service). Building `{ kind, detail }` by
 * hand risks a refusal whose `detail` never says to fall back — this
 * function makes that impossible rather than relying on every call site to
 * remember it.
 */
export function delegationFailure(kind: DelegationFailureKind, reason: string): DelegationFailure {
  return { kind, detail: `${reason} ${NATIVE_SUBAGENT_FALLBACK_SENTENCE}` }
}

/* --- Env parsing ------------------------------------------------------------ */

export interface DelegationLinkEnv {
  endpoint: string
  token: string
  waitMs: number
}

function isLoopbackOrigin(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return (
    url.protocol === 'http:' &&
    url.hostname === '127.0.0.1' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === ''
  )
}

function parseWaitMs(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_DELEGATION_WAIT_MS
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_DELEGATION_WAIT_MS
}

/**
 * Read the three env vars T4's injecting adapter sets on the launched child.
 * Any missing or malformed endpoint/token means UNCONFIGURED — the server
 * still starts (jevMcpServerCore.ts), and every tool call answers
 * `link-unconfigured` rather than the process exiting non-zero. Junk in
 * `_WAIT_MS` alone never disqualifies the other two; it just falls back to
 * `DEFAULT_DELEGATION_WAIT_MS` (feature document, T2 decisions).
 */
export function readLinkEnv(
  env: Readonly<Record<string, string | undefined>>
): DelegationLinkEnv | undefined {
  const endpoint = env[DELEGATION_ENDPOINT_ENV]
  const token = env[DELEGATION_TOKEN_ENV]
  if (endpoint === undefined || endpoint === '') return undefined
  if (token === undefined || token === '') return undefined
  if (!isLoopbackOrigin(endpoint)) return undefined
  return { endpoint, token, waitMs: parseWaitMs(env[DELEGATION_WAIT_MS_ENV]) }
}

/* --- Boundary parsers: what the link reads back off main -------------------
 *
 * Never trust a JSON body. Every parser here returns undefined on anything
 * it does not recognise rather than throwing — the same convention
 * `parseClaudeHookPayload` (hooks/hookPayload.ts) already holds, so every
 * caller reduces a bad response the same way: `delegationLink.ts` turns an
 * undefined parse into a `delegationFailure('invalid-response', …)`.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const DELEGATION_FAILURE_KINDS: ReadonlySet<DelegationFailureKind> = new Set([
  'disabled',
  'jev-unreachable',
  'jev-unsure',
  'provider-not-launchable',
  'concurrency-limit',
  'depth-exceeded',
  'unknown-ticket',
  'link-unconfigured',
  'link-unreachable',
  'invalid-response'
])

function isDelegationFailureKind(value: unknown): value is DelegationFailureKind {
  return typeof value === 'string' && DELEGATION_FAILURE_KINDS.has(value as DelegationFailureKind)
}

export function parseDelegationFailure(json: unknown): DelegationFailure | undefined {
  if (!isRecord(json)) return undefined
  if (!isDelegationFailureKind(json.kind)) return undefined
  if (typeof json.detail !== 'string') return undefined
  return { kind: json.kind, detail: json.detail }
}

const TURN_OUTCOME_KINDS: ReadonlySet<TurnOutcomeKind> = new Set([
  'concluded',
  'capped',
  'errored',
  'interrupted'
])

/**
 * `TurnOutcome`'s own boundary reading — this app's main process is the only
 * producer today, but the child process reads it back over an HTTP body, so
 * it gets no more trust than any other inbound JSON.
 */
export function parseTurnOutcome(json: unknown): TurnOutcome | undefined {
  if (!isRecord(json)) return undefined
  if (typeof json.kind !== 'string' || !TURN_OUTCOME_KINDS.has(json.kind as TurnOutcomeKind)) {
    return undefined
  }
  if (typeof json.endedAt !== 'number') return undefined
  if (json.text !== undefined && typeof json.text !== 'string') return undefined
  if (json.truncated !== undefined && typeof json.truncated !== 'boolean') return undefined
  if (json.detail !== undefined && typeof json.detail !== 'string') return undefined
  return {
    kind: json.kind as TurnOutcomeKind,
    endedAt: json.endedAt,
    ...(json.text === undefined ? {} : { text: json.text }),
    ...(json.truncated === undefined ? {} : { truncated: json.truncated }),
    ...(json.detail === undefined ? {} : { detail: json.detail })
  }
}

/**
 * Mirrors `DWARF_PROVIDERS` (`shared/contracts.ts`) BY VALUE rather than by
 * import. Importing that array here would pull `shared/contracts.ts` into
 * this module's own runtime graph — and since `main/index.ts`'s graph also
 * needs values from that same file, Rollup would split it into a shared
 * chunk between `index.js` and `jevMcpServer.js` (observed: it did, before
 * this was written this way — `pnpm build` produced `chunks/contracts-*.js`
 * and jevMcpServer.js imported from it), breaking the single self-contained
 * file `electron.vite.config.ts`'s build promises for the server script.
 * `DwarfProvider`'s own TYPE is still reused everywhere in this file
 * (`import type`, fully erased at build time) — only this one runtime list
 * is declared locally. Written as a `Record<DwarfProvider, true>` rather
 * than an array so a FUTURE member added to the real `DwarfProvider` union
 * fails `pnpm typecheck` here too (a mapped-type object literal must supply
 * every key), not just an extra one removed from it.
 */
const KNOWN_PROVIDERS: Readonly<Record<DwarfProvider, true>> = {
  claude: true,
  codex: true,
  antigravity: true,
  opencode: true
}

function isKnownProvider(value: string): value is DwarfProvider {
  return Object.prototype.hasOwnProperty.call(KNOWN_PROVIDERS, value)
}

function parseRouting(json: unknown): DelegationRouting | undefined {
  if (!isRecord(json)) return undefined
  if (typeof json.provider !== 'string' || !isKnownProvider(json.provider)) {
    return undefined
  }
  if (json.model !== undefined && typeof json.model !== 'string') return undefined
  if (json.effort !== undefined && typeof json.effort !== 'string') return undefined
  return {
    provider: json.provider as DwarfProvider,
    ...(json.model === undefined ? {} : { model: json.model }),
    ...(json.effort === undefined ? {} : { effort: json.effort })
  }
}

export function parseDelegateAcceptedBody(json: unknown): DelegateAcceptedBody | undefined {
  if (!isRecord(json)) return undefined
  if (typeof json.ticket !== 'string' || json.ticket === '') return undefined
  const routing = parseRouting(json.routing)
  if (routing === undefined) return undefined
  return { ticket: json.ticket, routing }
}

export function parseDelegateRefusedBody(json: unknown): DelegateRefusedBody | undefined {
  if (!isRecord(json)) return undefined
  const failure = parseDelegationFailure(json.failure)
  if (failure === undefined) return undefined
  return { failure }
}

export function parseResultBody(json: unknown): ResultBody | undefined {
  if (!isRecord(json)) return undefined
  if (json.status === 'pending') {
    const routing = parseRouting(json.routing)
    return routing === undefined ? undefined : { status: 'pending', routing }
  }
  if (json.status === 'done') {
    const outcome = parseTurnOutcome(json.outcome)
    return outcome === undefined ? undefined : { status: 'done', outcome }
  }
  if (json.status === 'failed') {
    const failure = parseDelegationFailure(json.failure)
    return failure === undefined ? undefined : { status: 'failed', failure }
  }
  return undefined
}
