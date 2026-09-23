import type {
  DelegateRequestBody,
  DelegationFailure,
  DelegationFailureKind
} from './delegationProtocol'

/**
 * The server-only twin of `delegationProtocol.ts`'s own runtime vocabulary
 * (#511 T3) — safe for EVERY main-only module in this directory
 * (`delegationRouting.ts`, `delegationService.ts`) to import as a runtime
 * value, because this file is reachable ONLY from `index.ts`'s own build
 * graph, never from `jevMcpServer.ts`'s.
 *
 * ## Why this file exists at all, rather than importing `delegationProtocol.ts` directly
 *
 * Every TYPE below (`DelegationFailure`, `DelegationFailureKind`,
 * `DelegateRequestBody`) comes straight from `delegationProtocol.ts` via
 * `import type` — fully erased at build time, so it costs nothing and risks
 * nothing. The RUNTIME values are declared locally instead, mirroring
 * `delegationProtocol.ts`'s own `KNOWN_PROVIDERS` precedent exactly:
 * `delegationProtocol.ts` is a runtime dependency of `jevMcpServer.ts`'s own
 * build graph too (via `delegationLink.ts`/`jevMcpServerCore.ts`), and
 * `electron.vite.config.ts` bundles that entry as a single, dependency-free
 * script. If any main-only module imported a runtime value from
 * `delegationProtocol.ts` directly, Rollup would extract it into a chunk
 * shared between BOTH entries — observed, before this file existed, as
 * `out/main/chunks/delegationProtocol-*.js` imported by `jevMcpServer.js`.
 * Centralising the duplication HERE means every main-only file needs this
 * reasoning written down exactly once, rather than once per file.
 *
 * `delegationProtocol.test.ts` keeps proving the CANONICAL values;
 * `delegationServerProtocol.test.ts` proves these copies agree with them
 * byte for byte, so the two can never drift unnoticed.
 */

export const DELEGATE_ROUTE = '/delegate'
export const RESULT_ROUTE_PREFIX = '/result/'
export const DELEGATION_TOKEN_HEADER = 'x-dwarfai-token'
/**
 * Added for #511 T4: `delegationInjection.ts` (main-only — it builds what a
 * launched CLI's own MCP config needs, never reachable from
 * `jevMcpServer.ts`'s graph) needs these five runtime values too, and
 * importing them from `delegationProtocol.ts` directly reproduced the exact
 * regression this file's own top comment describes — observed firsthand
 * while wiring T4: `pnpm build` grew a fresh `out/main/chunks/delegationProtocol-*.js`
 * that `jevMcpServer.js` then imported, the instant `delegationInjection.ts`
 * pulled a runtime value from the canonical module. Local copies here, on
 * the same terms as every constant above.
 */
export const DELEGATE_SUBTASK_TOOL_NAME = 'delegate_subtask'
export const SUBTASK_RESULT_TOOL_NAME = 'subtask_result'
export const DELEGATION_ENDPOINT_ENV = 'DWARFAI_DELEGATION_ENDPOINT'
export const DELEGATION_TOKEN_ENV = 'DWARFAI_DELEGATION_TOKEN'
export const DELEGATION_WAIT_MS_ENV = 'DWARFAI_DELEGATION_WAIT_MS'
/**
 * Added for #511 M1a: `runtime.ts`'s `resolveHeldDelegationInjection` needs
 * this default too, for a held Claude session whose in-process server takes
 * a concrete `waitMs` rather than an env var a detached child's own process
 * parses — same duplication reasoning as every other constant here.
 */
export const DEFAULT_DELEGATION_WAIT_MS = 50_000
/**
 * Mirrors `MAX_HOOK_BODY_BYTES`'s own cap-before-parse style
 * (`hooks/hookServer.ts`), sized to fit the actual worst case rather than a
 * round guess (#511 LOW-9). Neither the zod schema (`jevMcpServerCore.ts`)
 * nor `parseDelegateRequestBody` below restricts task/context to printable
 * characters, so the worst case per UTF-16 code unit is NOT a 4-byte UTF-8
 * codepoint — it is a control character with no short JSON escape (unlike
 * `\n`, `\t`, `"`, `\\`), which `JSON.stringify` renders as `\u00XX`: 6 ASCII
 * bytes for one code unit. Worst case: (`MAX_DELEGATION_TASK_CHARS` +
 * `MAX_DELEGATION_CONTEXT_CHARS`) * 6 = 20,000 * 6 = 120,000 bytes of
 * content, plus `{"task":"","context":""}`'s own 25 bytes of structure =
 * 120,025 bytes. 131,072 (128 KiB) leaves headroom above that exact figure
 * while staying a round power of two, matching this constant's own previous
 * shape.
 */
export const MAX_DELEGATION_BODY_BYTES = 131_072
export const MAX_DELEGATION_TASK_CHARS = 4_000
export const MAX_DELEGATION_CONTEXT_CHARS = 16_000
export const NATIVE_SUBAGENT_FALLBACK_SENTENCE =
  'Use your own native subagent mechanism for this subtask instead.'

/** Local twin of `delegationProtocol.ts`'s own function of the same name — see this file's own top comment for why. */
export function delegationFailure(kind: DelegationFailureKind, reason: string): DelegationFailure {
  return { kind, detail: `${reason} ${NATIVE_SUBAGENT_FALLBACK_SENTENCE}` }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * T3's own boundary read of `POST /delegate`'s body — never trust a JSON
 * body, return undefined on anything this does not recognise rather than
 * throwing. The server never relies on the calling MCP tool's own zod schema
 * (`jevMcpServerCore.ts`) having been the only path to this route; a body
 * that skipped it is refused here on exactly the same terms.
 */
export function parseDelegateRequestBody(json: unknown): DelegateRequestBody | undefined {
  if (!isRecord(json)) return undefined
  if (typeof json.task !== 'string') return undefined
  if (json.task === '' || json.task.length > MAX_DELEGATION_TASK_CHARS) return undefined
  if (json.context !== undefined) {
    if (typeof json.context !== 'string' || json.context.length > MAX_DELEGATION_CONTEXT_CHARS) {
      return undefined
    }
  }
  return { task: json.task, ...(json.context === undefined ? {} : { context: json.context }) }
}
