// The argv of the person's `agy` for a held session (15 §4.8 Launch, frozen): stream-json in and
// out, `--model` / `--effort` only when the launch named them, and on a resume the same argv plus
// `--conversation <conversationId>` (AMENDMENT-13, OQ-81; `resume: 'cli-flag'`). The prompt and
// every turn travel on stdin, never in argv: `-p` / `--print` / `--prompt` take the prompt as
// their value (measured on agy 1.1.26; agy 1.4.2 --help: "Run a single prompt non-interactively")
// and are never passed. Nothing else of the reference launchers is taken (no print flag, no
// auto-approve flag, no execution mode). Every argv goes through `assertNoForbidden` (ADR-008
// item 3, C-24), and a value that is empty, holds a line break or NUL, or starts with `-` is
// refused, because agy would read it as a flag of its own.
//
// Candidate decision (21 §6): `antigravityHeldArgs` of `src/main/sessionLaunch/
// antigravityHeldSession.ts` is carried over unchanged in shape (both formats named explicitly,
// model and effort only when given); the value guard and the resume flag are new.
import { HostInvariantError } from '../../../../../kernel/domain/errors'
import { assertNoForbidden } from '../shared/forbiddenFlags'

const STREAM_JSON = 'stream-json'
const GATE_OFF = { subagentDelegationOn: false, launchedWithLetJevChoose: false }
/** A value agy could read as a flag or as more than one argument. */
const UNSAFE_VALUE = /^$|^-|[\u0000\r\n]/

export interface ArgvInput {
  readonly model?: string
  readonly effort?: string
  /** A resume: the conversation agy continues (`--conversation <id>`). */
  readonly conversationId?: string
}

function value(name: string, text: string | undefined): string[] {
  if (text === undefined) return []
  if (UNSAFE_VALUE.test(text)) {
    throw new HostInvariantError(`the ${name} value cannot be passed to agy as one argument`)
  }
  return [name, text]
}

/** The argv; throws `HostInvariantError` on an unsafe value or a forbidden flag. */
export function buildArgv(input: ArgvInput): string[] {
  const argv = [
    '--input-format',
    STREAM_JSON,
    '--output-format',
    STREAM_JSON,
    ...value('--model', input.model),
    ...value('--effort', input.effort),
    ...value('--conversation', input.conversationId)
  ]
  assertNoForbidden(argv, {}, { delegationGate: GATE_OFF })
  return argv
}
