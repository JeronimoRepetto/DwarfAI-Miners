// The public events of the preferences module (08 §1, §3; 16 §4.12). Published after commit (16 §2.3).
import type { DomainEvent } from '../../../kernel/domain/domainEvent'
import type { HostPreferences } from './hostPreferences'

/** 08 `HostPreferencesChanged`: only when the stored preferences changed (ADR-024 D9). */
export type HostPreferencesChanged = DomainEvent<
  'HostPreferencesChanged',
  { preferences: HostPreferences }
>

/** Every event this module publishes. */
export type PreferencesEvent = HostPreferencesChanged
