// ADR-009 D2 `ProviderCapabilities`, copied field for field (ADR-009 is the owner and wins on any
// difference), and the fail-closed value of every field. The merge of a ceiling with a negotiated
// set comes later (ISSUE-147). Pure: no I/O, no clock read (05 §2.2, R1).

export interface ProviderCapabilities {
  launch: boolean
  observe: boolean
  sendTurn: boolean
  interrupt: boolean
  permission: 'interactive' | 'policy-only' | 'none' // ADR-010 / ADR-011
  question: 'form' | 'options' | 'none'
  answeredElsewhere: boolean // provider reports resolution outside DwarfAI (A7)
  staleAnswerSafe: boolean // a late answer has no side effect (false only for keystrokes, ADR-012)
  resume: 'load' | 'resume' | 'cli-flag' | 'none' // ADR-015
  adopt: boolean // re-attach to a live server-kind session without restart
  turnEnd: 'reliable' | 'none' // per session; behaviour: ADR-021 (AQ-20)
  reactionEvidence: 'turn-id' | 'transcript-match' | 'none' // how ✓✓ is correlated; behaviour: ADR-022 (AQ-07)
  subagents: 'events' | 'transcript' | 'none' // rank source (AQ-12, PO #21)
  usage: { fidelity: 0 | 1 | 2; rateLimits: boolean } // ADR-006
  mcpInjection: 'in-process' | 'protocol' | 'ticket-file' | 'none' // ADR-013
  console: 'focus-terminal' | 'attach' | 'log' // per session; behaviour: ADR-031 (every dwarf has a console)
  earlyFailure: 'handshake' | 'exit-only' // ADR-020 3 s window (NFR-TIM-06)
  installDetection: 'user-binary' | 'none' // D5: 'user-binary' = present iff the user's own CLI resolves
  observedPermission: 'detected' | 'none' // observed sessions, per ask kind: a trusted signal reveals that the
  observedQuestion: 'detected' | 'none' // session waits on the person for a permission / for a question
  // (ADR-011 item 4). OQ-35 A: 'detected' -> the dwarf shows the
  // "Jump to terminal" state for that kind; 'none' -> documented
  // per-provider limitation for that kind, the dwarf shows working,
  // then idle/asleep
}

/** ADR-009 D3 prose (O-15-09): what an observation adapter declares; an omitted field fails closed. */
export type ObservedCapabilities = Partial<ProviderCapabilities>

/**
 * Every field at its lowest or fail-closed value (ADR-009 D2 merge table: booleans false, ordered
 * enums their lowest value, unordered enums `resume` → `none`, `mcpInjection` → `none`,
 * `console` → `log`, `earlyFailure` → `exit-only`, `installDetection` → `user-binary`). The
 * capabilities of a provider the catalog does not know.
 */
export const FAIL_CLOSED_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  launch: false,
  observe: false,
  sendTurn: false,
  interrupt: false,
  permission: 'none',
  question: 'none',
  answeredElsewhere: false,
  staleAnswerSafe: false,
  resume: 'none',
  adopt: false,
  turnEnd: 'none',
  reactionEvidence: 'none',
  subagents: 'none',
  usage: Object.freeze({ fidelity: 0, rateLimits: false }),
  mcpInjection: 'none',
  console: 'log',
  earlyFailure: 'exit-only',
  installDetection: 'user-binary',
  observedPermission: 'none',
  observedQuestion: 'none'
})
