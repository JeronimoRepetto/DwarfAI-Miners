// The Antigravity `ndjson` driver's capability row (15 §3 row A1) and its probe reading (15 §2.3).
// Every UNVERIFIED `U→x` value of row A1 is held at its in-force `x` (INV-44): `interrupt` false
// (the stream has no cancel), `turnEnd` none (the `result` line ends a turn as an inferred end),
// `subagents` none, `usage` fidelity 0 (stream-json usage, SP-10). `permission` and `question`
// are none: this driver answers no ask, and SP-10 (Antigravity part) has recorded no deny policy
// (`spike-results/SP-10.md`), so no policy-only mode is offered (15 §2.8). `resume` is
// `cli-flag` (AMENDMENT-13) when the help lists `--conversation`.
import type { ProviderCapabilities } from '../../../domain/capabilities'

/** 15 §3 row A1, every `U→x` at its in-force `x`; the probe opens `launch` and `resume`. */
export const NDJSON_ROW: Readonly<ProviderCapabilities> = Object.freeze({
  launch: false, // the probe opens it: stream-json in and out are listed
  observe: true,
  sendTurn: true,
  interrupt: false, // U→no
  permission: 'none',
  question: 'none',
  answeredElsewhere: false,
  staleAnswerSafe: true,
  resume: 'none', // `cli-flag` once the help lists --conversation (AMENDMENT-13)
  adopt: false,
  turnEnd: 'none', // U→none
  reactionEvidence: 'none',
  subagents: 'none', // U→none
  usage: Object.freeze({ fidelity: 0, rateLimits: false }), // U→0 (SP-10)
  mcpInjection: 'none',
  console: 'log',
  earlyFailure: 'exit-only',
  installDetection: 'user-binary',
  observedPermission: 'none',
  observedQuestion: 'none'
}) as Readonly<ProviderCapabilities>

/** An option line of agy's help (two-space indent, the flag, then its description). */
const optionLine = (flag: string): RegExp => new RegExp(`^ {1,4}${flag}(?=\\s)(.*)$`, 'm')
/** `stream-json` among an option's listed values, e.g. `(text, stream-json)`, not in its prose. */
const STREAM_JSON = /\((?:[^()]*,\s*)?stream-json(?:\s*,[^()]*)?\)/

function optionMentions(help: string, flag: string, value: RegExp): boolean {
  const line = optionLine(flag).exec(help)?.[1]
  return line !== undefined && value.test(line)
}

/**
 * The probed capabilities (15 §2.3): `launch` is true only when the help lists stream-json as a
 * value of both `--input-format` and `--output-format`; `resume` is `cli-flag` when it lists
 * `--conversation`. A help that could not be read (`null`) gives the fail-closed values (15 §1.3
 * `probe`).
 */
export function capabilitiesFromHelp(help: string | null): ProviderCapabilities {
  const launch =
    help !== null &&
    optionMentions(help, '--input-format', STREAM_JSON) &&
    optionMentions(help, '--output-format', STREAM_JSON)
  const resume = help !== null && optionLine('--conversation').test(help)
  return {
    ...NDJSON_ROW,
    usage: { ...NDJSON_ROW.usage },
    launch,
    resume: resume ? 'cli-flag' : 'none'
  }
}
