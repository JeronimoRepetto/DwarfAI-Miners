// B-M12 `preferences.get`, B-M13 `preferences.set`, B-F24 `preferences.changed` and the snapshot's
// `preferences` section (14 §2.3, §2.4, §3.4, §3.6, §4.1; ADR-024 D1, D9; INV-105), over the
// preferences module's driving ports. The composition root registers them (later: ISSUE-226).
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
// Lead decision (2026-09-30): the view's `secrets`, `secretBackend` and `welcome` have no source in
// cut 1 (SecretStore: ISSUE-215; the first-run evaluation: ISSUE-222), so they are served as none
// configured, `'unavailable'` and not due; `integrations` likewise until its store joins (later:
// ISSUE-218…ISSUE-221). No renderer reads them before 3a / cut 2.
import {
  HOST_METHOD_SCHEMAS,
  type HostFrameName,
  type HostMethods,
  type HostPreferences,
  type PreferencesView
} from '@dwarfai/contracts'
import type { DomainEventBus } from '../../kernel/ports/domainEventBus'
import type { Preferences, PreferencesEvent } from '../../modules/preferences'
import type { FramePublisher } from '../connectionRegistry'
import type { Dispatcher } from '../dispatcher'
import { METHOD_ROLES } from '../roles'
import type { SectionProvider } from '../snapshot/sectionRegistry'

/** The frames this file publishes, for `hello.ok.capabilities` (14 §1.3). */
export const PREFERENCES_FRAMES: readonly HostFrameName[] = Object.freeze(['preferences.changed'])

/** 14 §3.6 `PreferencesView` of cut 1 over the stored `preferences` (see the lead decision above). */
export function preferencesView(preferences: HostPreferences): PreferencesView {
  return {
    preferences,
    secrets: [],
    secretBackend: 'unavailable',
    integrations: [],
    welcome: { due: false, legacyFound: [], offered: [] }
  }
}

export interface PreferencesMethodsDeps {
  preferences: Preferences
}

/** Serves `preferences.get` (B-M12) and `preferences.set` (B-M13) on `dispatcher`. */
export function registerPreferences(dispatcher: Dispatcher, deps: PreferencesMethodsDeps): void {
  const { commands, queries } = deps.preferences
  dispatcher.register(
    'preferences.get',
    HOST_METHOD_SCHEMAS['preferences.get'].params,
    METHOD_ROLES['preferences.get'] ?? [],
    (): HostMethods['preferences.get']['result'] => preferencesView(queries.get())
  )
  dispatcher.registerMutating(
    'preferences.set',
    HOST_METHOD_SCHEMAS['preferences.set'].params,
    METHOD_ROLES['preferences.set'] ?? [],
    (params): HostMethods['preferences.set']['result'] => commands.set(params.key, params.value)
  )
}

/** The snapshot's `preferences` section (14 §4.1): the same view as `preferences.get`. */
export function preferencesSection(preferences: Preferences): SectionProvider<'preferences'> {
  return () => preferencesView(preferences.queries.get())
}

/**
 * Routes `HostPreferencesChanged` to `preferences.changed` (B-F24) on `frames`; returns the
 * unsubscribe.
 */
export function publishPreferencesChanged(
  bus: DomainEventBus<PreferencesEvent>,
  frames: FramePublisher
): () => void {
  return bus.subscribe('HostPreferencesChanged', (event) =>
    frames.publish('preferences.changed', preferencesView(event.payload.preferences))
  )
}
