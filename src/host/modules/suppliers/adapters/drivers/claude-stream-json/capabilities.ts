// The Claude `stream-json` driver's capability row (15 §3 row C2) and its probe reading (15 §2.3,
// ADR-009 D4). Every UNVERIFIED `U→x` value of row C2 is held at its in-force `x` (INV-44) until
// its spike records a measured value. Recorded for Claude Code 2.1.301 on Windows (ISSUE-321,
// `spike-results/`): `launch` (SP-08), `earlyFailure` (S-020-1), `resume` (SP-15). Still at their
// in-force values: `interrupt`, `question` (ADR-009 D4), `reactionEvidence` (S-022-1),
// `subagents`. `permission` (AMENDMENT-21, owner-approved 2026-10-17): the Host serves
// `mcp__dwarfai__permission` on the relay every launch carries, so SP-08's prompt-tool channel
// opens it to `interactive` exactly when the probe opens the prompt tool (15 §3 row C2:
// "U→none (interactive via prompt tool, SP-08)"); a help that could not be read keeps `none`.
import type { ProviderCapabilities } from '../../../domain/capabilities'

/** The spike records this driver's capability values follow; each is a committed record. */
export interface SpikeRecords {
  /** `spike-results/SP-08.md`, passed: `--permission-prompt-tool` present and routing. */
  readonly sp08: boolean
  /** `spike-results/S-020-1.md`, passed: readiness is `system/init`, after the first stdin line. */
  readonly s0201: boolean
  /** `spike-results/SP-15.md` (Claude stream-json part passed): `--resume <id>` keeps the id. */
  readonly sp15: boolean
}

/**
 * ISSUE-321's records for Claude Code 2.1.301 (Windows; macOS and Linux not run, not claimed).
 * Only a committed record may change a value here.
 */
export const SPIKE_RECORDS: SpikeRecords = Object.freeze({ sp08: true, s0201: true, sp15: true })

/** 15 §3 row C2, every `U→x` at its in-force `x`; the probe and the records raise what they prove. */
export const STREAM_JSON_ROW: Readonly<ProviderCapabilities> = Object.freeze({
  launch: false, // U→no: the probe opens it (SP-08)
  observe: true,
  sendTurn: true,
  interrupt: false, // U→no: the stream-json interrupt is UNVERIFIED (15 §4.2 End / kill)
  permission: 'none', // U→none: the probe opens `interactive` with the prompt tool (SP-08)
  question: 'none', // ADR-009 D4: --disallowedTools AskUserQuestion
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
  earlyFailure: 'exit-only', // U→exit-only: `handshake` once S-020-1 records the readiness line
  installDetection: 'user-binary',
  observedPermission: 'none',
  observedQuestion: 'none'
}) as Readonly<ProviderCapabilities>

/** `--permission-prompt-tool` listed as an option of its own (an option line, not prose). */
const PROMPT_TOOL_OPTION = /^ {2}--permission-prompt-tool(?=[\s,=<]|$)/m
/** The `--permission-prompts` option line and its indented description lines (SP-08, 2.1.301). */
const PROMPTS_OPTION_BLOCK = /^ {2}--permission-prompts\b.*(?:\r?\n {3,}.*)*/m
/** The flag named inside that description: `"host" (the SDK host or --permission-prompt-tool)`. */
const PROMPT_TOOL_NAMED = /--permission-prompt-tool(?![\w-])/
/** `--disallowedTools` / `--disallowed-tools`: the question tool can be disabled (15 §2.3 row 2). */
const DISALLOWED_TOOLS_OPTION = /(?:^|[\s,])--disallowed(?:Tools|-tools)(?=[\s,=<]|$)/m

/**
 * SP-08 Decision: in Claude Code 2.1.301 `--permission-prompt-tool` is hidden from the option list
 * but accepted and routing, and `--help` names it inside the `--permission-prompts` description.
 * The probe therefore accepts either its own option line or that mention; `--permission-prompts`
 * itself is never passed (its `host` value is not covered by the record).
 */
function promptToolAdvertised(help: string): boolean {
  if (PROMPT_TOOL_OPTION.test(help)) return true
  const block = PROMPTS_OPTION_BLOCK.exec(help)?.[0]
  return block !== undefined && PROMPT_TOOL_NAMED.test(block)
}

/**
 * The probed capabilities (15 §2.3): `launch` is true only when the help advertises the prompt
 * tool and `--disallowedTools` and SP-08 has passed, and `permission` is `interactive` when the
 * prompt tool is advertised with SP-08 passed (AMENDMENT-21); a help that could not be read (`null`: no
 * answer within PROBE_TIMEOUT_MS, a failed run) gives the fail-closed `launch` (15 §1.3 `probe`).
 * `earlyFailure` and `resume` are the recorded protocol facts of the version (S-020-1, SP-15), not
 * probed: the merge with the ceiling decides what is effective (ADR-009 D2).
 */
export function capabilitiesFromHelp(
  help: string | null,
  gates: SpikeRecords
): ProviderCapabilities {
  const promptTool = help !== null && gates.sp08 && promptToolAdvertised(help)
  const launch = promptTool && DISALLOWED_TOOLS_OPTION.test(help)
  return {
    ...STREAM_JSON_ROW,
    usage: { ...STREAM_JSON_ROW.usage },
    launch,
    permission: promptTool ? 'interactive' : STREAM_JSON_ROW.permission,
    resume: gates.sp15 ? 'cli-flag' : STREAM_JSON_ROW.resume,
    earlyFailure: gates.s0201 ? 'handshake' : STREAM_JSON_ROW.earlyFailure
  }
}
