// The Claude `stream-json` driver's capability row (15 §3 row C2) and its probe reading (15 §2.3,
// ADR-009 D4). Every UNVERIFIED `U→x` value of row C2 is held at its in-force `x` (INV-44) until
// its spike records a measured value: `launch` (SP-08), `interrupt`, `permission` (SP-08),
// `resume` (SP-15), `reactionEvidence` (S-022-1), `subagents`, `earlyFailure` (S-020-1).
import type { ProviderCapabilities } from '../../../domain/capabilities'

/**
 * The spike records this driver's probe waits on. SP-08 is pending (`spike-results/SP-08.md`), so
 * a `claude` that advertises `--permission-prompt-tool` still probes `launch: false`: the driver is
 * built and conformance-tested but never offered (ADR-009 D4; ISSUE-150 "Gates"). Only ISSUE-321's
 * committed SP-08 record may change this value.
 */
export const SPIKE_RECORDS: { readonly sp08: boolean } = Object.freeze({ sp08: false })

/** 15 §3 row C2, every `U→x` at its in-force `x`; `launch` is what the probe lowers. */
export const STREAM_JSON_ROW: Readonly<ProviderCapabilities> = Object.freeze({
  launch: false, // U→no until SP-08
  observe: true,
  sendTurn: true,
  interrupt: false, // U→no: the stream-json interrupt is UNVERIFIED (15 §4.2 End / kill)
  permission: 'none', // U→none: interactive only through the prompt tool, once SP-08 passes
  question: 'none', // ADR-009 D4: --disallowedTools AskUserQuestion until SP-08
  answeredElsewhere: false,
  staleAnswerSafe: true,
  resume: 'none', // U→none: `cli-flag` (--resume <id>) once SP-15 records the id rule
  adopt: false,
  turnEnd: 'reliable', // the `result` line (ADR-021 item 4)
  reactionEvidence: 'transcript-match', // U→transcript-match (S-022-1)
  subagents: 'transcript', // U→transcript: the transcript path owns subagents
  usage: Object.freeze({ fidelity: 2, rateLimits: false }),
  mcpInjection: 'ticket-file', // ADR-013 item 3: the --mcp-config file holds a path only
  console: 'log',
  earlyFailure: 'exit-only', // U→exit-only until S-020-1 records the readiness line
  installDetection: 'user-binary',
  observedPermission: 'none',
  observedQuestion: 'none'
}) as Readonly<ProviderCapabilities>

/** `--permission-prompt-tool` as `claude --help` lists it (an option, not a word in prose). */
const PROMPT_TOOL_OPTION = /(?:^|[\s,])--permission-prompt-tool(?=[\s,=<]|$)/m
/** `--disallowedTools` / `--disallowed-tools`: the question tool can be disabled (15 §2.3 row 2). */
const DISALLOWED_TOOLS_OPTION = /(?:^|[\s,])--disallowed(?:Tools|-tools)(?=[\s,=<]|$)/m

/**
 * The probed capabilities (15 §2.3): `launch` is true only when the help lists both options and
 * SP-08 has passed; a help that could not be read (`null`: no answer within PROBE_TIMEOUT_MS, a
 * failed run) gives the fail-closed value of every probed field (15 §1.3 `probe`).
 */
export function capabilitiesFromHelp(
  help: string | null,
  gates: { readonly sp08: boolean }
): ProviderCapabilities {
  const launch =
    help !== null &&
    gates.sp08 &&
    PROMPT_TOOL_OPTION.test(help) &&
    DISALLOWED_TOOLS_OPTION.test(help)
  return { ...STREAM_JSON_ROW, usage: { ...STREAM_JSON_ROW.usage }, launch }
}
