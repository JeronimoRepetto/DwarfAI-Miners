// The AttentionSettings double (16 §4.11 `FakeAttentionSettings`). Never imported by production
// code (R14). A test flips the Host preference with `set`; it starts on, as the migration-1 seed
// of `host_preferences.system_notifications_on` does (09 §4.9).
import type { AttentionSettings } from '../attentionSettings'

export class FakeAttentionSettings implements AttentionSettings {
  constructor(private on = true) {}

  systemNotificationsOn(): boolean {
    return this.on
  }

  set(on: boolean): void {
    this.on = on
  }
}
