// B-M40 `preferences.answerWelcome` (14 §2.3, §3.4; AMENDMENT-7, OQ-68; ADR-016 item 5; 16 §4.12;
// 07 S41.04, S41.05). host/wiring registers it when it composes the step's answer into the Host
// (later: ISSUE-323).
//
// - B-M40 is `ui` only (roles.ts; a `notifier` gets FORBIDDEN) and mutating: a repeated `requestId`
//   gets the first answer with no second effect (dispatcher.ts, 14 §1.6). Its params are the
//   contract's strict() schema, the two ticks and a requestId: the consent origin `first-run` is the
//   module's (16 §4.12), so an `origin` on the wire is INVALID_PARAMS.
// - It answers every integration's state with its failure (a failure is never a call error, 14
//   §2.3) and the step as the module holds it once the answer settled (`due: false`, 07 S41.05).
// - The module publishes `IntegrationChanged` per integration touched and then `WelcomeStepChanged`,
//   synchronously; the routes host/wiring composes send them as `integration.changed` and
//   `preferences.changed` to every `ui` connection before the handler returns, so both frames
//   precede the `res` (14 §1.7 "effects before response"). This file publishes no frame of its own.
import { HOST_METHOD_SCHEMAS, type HostMethods } from '@dwarfai/contracts'
import type { WelcomeAnswer, WelcomeQueries } from '../../modules/preferences'
import type { Dispatcher } from '../dispatcher'
import { METHOD_ROLES } from '../roles'

export interface AnswerWelcomeMethodDeps {
  /** 16 §4.12 `PreferencesCommands.answerWelcome`. */
  commands: WelcomeAnswer
  /** 16 §4.12 `PreferencesQueries.welcome`, read once the answer settled. */
  queries: WelcomeQueries
}

/** Serves `preferences.answerWelcome` (B-M40) on `dispatcher`. */
export function registerAnswerWelcome(dispatcher: Dispatcher, deps: AnswerWelcomeMethodDeps): void {
  dispatcher.registerMutating(
    'preferences.answerWelcome',
    HOST_METHOD_SCHEMAS['preferences.answerWelcome'].params,
    METHOD_ROLES['preferences.answerWelcome'] ?? [],
    async (params): Promise<HostMethods['preferences.answerWelcome']['result']> => {
      const { claudeHooks, openCodePermissions } = params
      const integrations = await deps.commands.answerWelcome({ claudeHooks, openCodePermissions })
      return { integrations, welcome: deps.queries.welcome() }
    }
  )
}
