// Driven port of conversation (05 §3.6, 16 §4.6 `ConsoleResolver`, frozen), type-only (05 R2): the
// console target of a dwarf (ADR-031 item 1). The Host resolves it; UI main executes it right after
// the person's click (ADR-031 item 4). Every dwarf has a console, `log` at worst (ADR-031 item 3), and
// no target ever carries a token or a secret in `command.args` (ADR-017 item 3): the `log` view's
// credential crosses as the path of a per-view token file only (ADR-003 item 12).
//
// `ConsoleTarget` is ADR-031 item 1's block, byte-identical; its `mode` is ADR-009 D2's
// `ProviderCapabilities['console']`, imported from its owner through suppliers' index (the
// conversation → suppliers edge, 05 §1.3).
import type { DwarfId } from '../../../kernel/domain/values'
import type { ProviderCapabilities } from '../../suppliers'

// verbatim: ADR-031 item 1 (list indentation removed; prettier-ignore keeps the aligned comments)
// prettier-ignore
export interface ConsoleTarget {
  mode: ProviderCapabilities['console']                  // ADR-009 D2
  // resolved by the Host; executed by the UI (foreground rules)
  focus?: { pid: number; startTime: number }             // focus-terminal
  command?: { program: string; args: readonly string[]; cwd: string } // attach / log, no shell (ADR-029 #8)
  credentialFile?: string                                // log: viewer-token file path (ADR-003 item 12); never the token itself
}
// end verbatim

// 16 §4.6, its signature and comment as written (laid out by prettier)
export interface ConsoleResolver {
  targetFor(dwarfId: DwarfId): Promise<ConsoleTarget>
} // ADR-031 ConsoleTarget; window raise happens in UI
