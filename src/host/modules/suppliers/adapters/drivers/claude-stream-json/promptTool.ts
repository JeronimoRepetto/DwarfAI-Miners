// What the stream-json driver needs to serve Claude's permission prompt tool (AMENDMENT-21,
// owner-approved 2026-10-17; 15 §2.7, §4.2; ADR-010 items 1, 5; ADR-013 item 3). Type-only.
//
// - `PromptToolRelay.issue(launchId)`: the relay entry (the relay program and the credential FILE
//   PATH, never the value) of a launch the delegation gates left out, so every stream-json launch
//   carries `--mcp-config`. `null` when the credential could not be issued: the launch then fails
//   `could-not-start` (a session without the prompt tool would deny every tool use unseen).
// - `PromptToolSessions.register(launchId, handler)`: the session of a launch takes the prompt-tool
//   calls of its own relay (the relay credential is bound to that launch). The handler opens one
//   ask (`ask.opened`, channel `driver`) and settles with the person's answer given through
//   `DriverSession.answerPermission` (the asking module's `DriverAskChannel`). The returned
//   function unregisters that handler only.
//
// Both are implemented by host/wiring (the bridge to module delegation), never by this folder.
import type { LaunchId } from '../../../../../kernel/domain/values'
import type { DelegationInjection } from '../../../ports/providerDriver'

/** One prompt as the MCP tool received it (`tool_name`, `input`, `tool_use_id`). */
export interface PromptToolCall {
  readonly toolName: string
  readonly input: Readonly<Record<string, unknown>>
  readonly toolUseId: string
}

/** Settles with the person's answer; `signal` aborts when Claude cancels the tool call. */
export type PromptToolHandler = (
  call: PromptToolCall,
  signal: AbortSignal
) => Promise<'allow' | 'deny'>

/** What the relay serves a session besides the prompt tool. */
export interface PromptToolScope {
  /**
   * Both delegation gates let the launch in (its request carried a `DelegationInjection`): its
   * relay lists the two delegation tools too. An ungated launch's relay lists `permission` only.
   */
  readonly delegationGated: boolean
}

export interface PromptToolSessions {
  register(launchId: LaunchId, scope: PromptToolScope, handler: PromptToolHandler): () => void
}

export interface PromptToolRelay {
  issue(launchId: LaunchId): Promise<DelegationInjection | null>
  /**
   * Revokes a credential `issue` gave, when the launch it was issued for failed to start: its row
   * and file never outlive a launch that never ran. Never called for a gated request's own entry.
   */
  release(launchId: LaunchId): Promise<void>
}

/** The driver's dependency: both halves, bound by the composition root. */
export interface PromptToolDeps {
  readonly sessions: PromptToolSessions
  readonly relay: PromptToolRelay
}
