// B-M39 `preferences.setClaudeHooks` and B-F25 `integration.changed` (14 §2.3, §2.4, §3.4, §3.5;
// AMENDMENT-7, OQ-68; ADR-016 items 1, 5–7; 16 §4.12, §7.4). host/wiring/preferencesWiring.ts
// registers them (ISSUE-221).
//
// - B-M39 is `ui` only (roles.ts; a `notifier` gets FORBIDDEN) and mutating: a repeated `requestId`
//   gets the first answer with no second effect (dispatcher.ts, 14 §1.6). Its params are the
//   contract's strict() schema, `{ on, requestId }`: the toggle lives in Settings only, so the Host
//   records the consent origin `settings` itself and any `origin` on the wire is INVALID_PARAMS.
//   `first-run` reaches the same enable path only through `answerWelcome` (later: ISSUE-223).
// - It answers the module's stored state; `config-write-failed` and `config-revert-failed` are
//   outcomes of the result, never call errors (14 §3.4 `SetClaudeHooksResult`).
// - `IntegrationChanged`, published by the module after every outcome (a failed one with the
//   unchanged state) and synchronously, becomes `integration.changed` for every `ui` connection
//   before the handler returns, so the frame precedes the `res` (14 §1.7 "effects before
//   response"). The frame carries the integration's consent origin while it is on, read from the
//   stored setting; never a token.
//
// Package gap: 16 §4.12 gives `IntegrationChanged` the payload `{ id, state }` only, so the frame's
// optional `failure` (14 §3.5) is not sent: the caller reads its failure from the result, and every
// other window needs only the real state (16 §7.4).
import {
  HOST_METHOD_SCHEMAS,
  type HostFrameName,
  type HostFrames,
  type HostMethods
} from '@dwarfai/contracts'
import type { DomainEventBus } from '../../kernel/ports/domainEventBus'
import type {
  IntegrationChanged,
  IntegrationSettingsQueries,
  PreferencesCommands,
  PreferencesEvent
} from '../../modules/preferences'
import type { FramePublisher } from '../connectionRegistry'
import type { Dispatcher } from '../dispatcher'
import { METHOD_ROLES } from '../roles'

/** The frames this file publishes, for `hello.ok.capabilities` (14 §1.3). */
export const SET_CLAUDE_HOOKS_FRAMES: readonly HostFrameName[] = Object.freeze([
  'integration.changed'
])

export interface SetClaudeHooksMethodDeps {
  commands: Pick<PreferencesCommands, 'setClaudeHooks'>
}

/** Serves `preferences.setClaudeHooks` (B-M39) on `dispatcher`, with the Host's origin `settings`. */
export function registerSetClaudeHooks(
  dispatcher: Dispatcher,
  deps: SetClaudeHooksMethodDeps
): void {
  dispatcher.registerMutating(
    'preferences.setClaudeHooks',
    HOST_METHOD_SCHEMAS['preferences.setClaudeHooks'].params,
    METHOD_ROLES['preferences.setClaudeHooks'] ?? [],
    (params): Promise<HostMethods['preferences.setClaudeHooks']['result']> =>
      deps.commands.setClaudeHooks(params.on, 'settings')
  )
}

/** B-F25's data for `event`, with the consent origin of the stored setting while it is on. */
export function integrationChangedFrame(
  event: IntegrationChanged,
  queries: IntegrationSettingsQueries
): HostFrames['integration.changed'] {
  const { id, state } = event.payload
  const setting = queries.integrationSettings().find((candidate) => candidate.id === id)
  const origin = state !== 'off' && setting?.state === state ? setting.consentOrigin : undefined
  return origin === undefined ? { id, state } : { id, state, consentOrigin: origin }
}

/** Routes `IntegrationChanged` to `integration.changed` (B-F25) on `frames`; returns the unsubscribe. */
export function publishIntegrationChanged(
  bus: DomainEventBus<PreferencesEvent>,
  frames: FramePublisher,
  queries: IntegrationSettingsQueries
): () => void {
  return bus.subscribe('IntegrationChanged', (event) =>
    frames.publish('integration.changed', integrationChangedFrame(event, queries))
  )
}
