// Driven port (05 §3.11, 16 §4.11): the one Host-owned preference the level-3 gate reads. The
// adapter is a bridge to the preferences module (05 §1.3 attention → preferences); the UI-main
// preference `notificationSoundsOn` is never read here (ADR-018 item 8, ADR-024).
export interface AttentionSettings {
  systemNotificationsOn(): boolean
} // bridge → preferences (Host-owned pref only)
