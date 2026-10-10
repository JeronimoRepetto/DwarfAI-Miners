// B-M12 `preferences.get`, B-M13 `preferences.set`, B-F24 `preferences.changed` and the snapshot's
// `preferences` section (14 §2.3, §2.4, §3.4, §3.6, §4.1; ADR-024 D1, D9; INV-105), over the
// preferences module's driving ports. host/wiring/preferencesWiring.ts registers them (ISSUE-226).
//
// - B-M12 and B-M13 are `ui` only (roles.ts; a `notifier` gets FORBIDDEN). Their params are the
//   contract's strict() schemas: one writable key, a catalog provider or none as the default
//   provider (INVALID_PARAMS otherwise, before the handler runs).
// - B-M13 is mutating: a repeated `requestId` gets the first answer, with no second effect
//   (dispatcher.ts, 14 §1.6). Its answer is what was STORED (IPC Gap 10). The module publishes
//   `HostPreferencesChanged` after commit and synchronously, and `publishPreferencesChanged` turns
//   it into `preferences.changed` for every `ui` connection before the handler returns, so the
//   frame precedes the `res` on the wire (14 §1.7 "effects before response"). A write that stores
//   nothing new publishes nothing (ADR-024 D9).
// - The snapshot section and the frame carry the same `PreferencesView` as B-M12.
//
// - `welcome` is the first-run consent step the module evaluated at boot (`queries.welcome()`, 07
//   machine 41; 16 §4.12; ISSUE-222), in B-M12, the snapshot section and B-F24 alike; its
//   `WelcomeStepChanged` is sent as `preferences.changed` with the same view (07 S41.05).
//
// Lead decision (2026-09-30): the view's `secrets` and `secretBackend` have no source in cut 1
// (SecretStore: ISSUE-215), so they are served as none configured and `'unavailable'`. No renderer
// reads them before 3a / cut 2. `integrations` is the stored `integration_settings` (14 §4.1;
// `queries.integrationSettings()`, ISSUE-221), whose changes reach the UIs as `integration.changed`
// (setClaudeHooks.ts), not as `preferences.changed`.
import {
  HOST_METHOD_SCHEMAS,
  type HostFrameName,
  type HostMethods,
  type HostPreferences,
  type PreferencesView
} from '@dwarfai/contracts'
import type { DomainEventBus } from '../../kernel/ports/domainEventBus'
import type {
  IntegrationSetting,
  IntegrationSettingsQueries,
  Preferences,
  PreferencesEvent,
  PreferencesQueries,
  WelcomeQueries,
  WelcomeStepState
} from '../../modules/preferences'
import type { FramePublisher } from '../connectionRegistry'
import type { Dispatcher } from '../dispatcher'
import { METHOD_ROLES } from '../roles'
import type { SectionProvider } from '../snapshot/sectionRegistry'

/** The frames this file publishes, for `hello.ok.capabilities` (14 §1.3). */
export const PREFERENCES_FRAMES: readonly HostFrameName[] = Object.freeze(['preferences.changed'])

/** The module as these members read it: its queries with the first-run step's `welcome()`. */
export type ServedPreferences = Preferences & { queries: PreferencesQueries & WelcomeQueries }

/** 14 §3.6 `PreferencesView` over the stored `preferences`, integrations and the step (see above). */
export function preferencesView(
  preferences: HostPreferences,
  welcome: WelcomeStepState,
  integrations: IntegrationSetting[]
): PreferencesView {
  return {
    preferences,
    secrets: [],
    secretBackend: 'unavailable',
    integrations,
    welcome
  }
}

export interface PreferencesMethodsDeps {
  preferences: ServedPreferences
}

/** Serves `preferences.get` (B-M12) and `preferences.set` (B-M13) on `dispatcher`. */
export function registerPreferences(dispatcher: Dispatcher, deps: PreferencesMethodsDeps): void {
  const { commands, queries } = deps.preferences
  dispatcher.register(
    'preferences.get',
    HOST_METHOD_SCHEMAS['preferences.get'].params,
    METHOD_ROLES['preferences.get'] ?? [],
    (): HostMethods['preferences.get']['result'] =>
      preferencesView(queries.get(), queries.welcome(), queries.integrationSettings())
  )
  dispatcher.registerMutating(
    'preferences.set',
    HOST_METHOD_SCHEMAS['preferences.set'].params,
    METHOD_ROLES['preferences.set'] ?? [],
    (params): HostMethods['preferences.set']['result'] => commands.set(params.key, params.value)
  )
}

/** The snapshot's `preferences` section (14 §4.1): the same view as `preferences.get`. */
export function preferencesSection(preferences: ServedPreferences): SectionProvider<'preferences'> {
  return () =>
    preferencesView(
      preferences.queries.get(),
      preferences.queries.welcome(),
      preferences.queries.integrationSettings()
    )
}

/**
 * Routes `HostPreferencesChanged` and `WelcomeStepChanged` (07 S41.05) to `preferences.changed`
 * (B-F24) on `frames`, each with the full view; returns the unsubscribe. The step's state is read
 * from `queries`, which already holds the new state when its event is published.
 */
export function publishPreferencesChanged(
  bus: DomainEventBus<PreferencesEvent>,
  frames: FramePublisher,
  queries: Pick<PreferencesQueries, 'get'> & WelcomeQueries & IntegrationSettingsQueries
): () => void {
  const offPreferences = bus.subscribe('HostPreferencesChanged', (event) =>
    frames.publish(
      'preferences.changed',
      preferencesView(event.payload.preferences, queries.welcome(), queries.integrationSettings())
    )
  )
  const offWelcome = bus.subscribe('WelcomeStepChanged', (event) =>
    frames.publish(
      'preferences.changed',
      preferencesView(queries.get(), event.payload.state, queries.integrationSettings())
    )
  )
  return () => {
    offPreferences()
    offWelcome()
  }
}
