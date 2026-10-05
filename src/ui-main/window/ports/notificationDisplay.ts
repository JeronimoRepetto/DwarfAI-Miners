// NotificationDisplay: driven port of the window module, main half (05 §3.14; frozen copy 16 §4.14). Adapter
// `ElectronNotificationDisplay` ← `notifications/electronNotifications.ts`, `appUserModelId.ts`; double
// `RecordingNotificationDisplay` (16 §4.14 table; gates S-018-1, S-018-2). It displays what the Host decided
// (ADR-018 item 7): the title and body arrive formatted in `attention.notify` (`OsNotification`, 14 §3.5) and are shown
// unchanged. Type-only (R2).
//
// Withdrawal (ADR-018 item 4; 14 B-F23 `attention.withdraw {keys}`) is no port method (ISSUE-113): the adapter keeps a
// key → notification map privately. `show` learns the key from a `key` field the presenter passes next to the title and
// body (a wider argument the port's `n` accepts as written), and `close(key)` is the adapter's own member, typed below
// as `NotificationWithdrawal`.

// verbatim: 16 §4.14 (the `NotificationDisplay` line, byte-for-byte)
// prettier-ignore
export interface NotificationDisplay { show(n: { title: string; body: string }, onClick: () => void): void }
// end verbatim: 16 §4.14

/** What the presenter hands `show`: the Host's title and body, unchanged, and the notification's key. */
export interface KeyedNotification {
  key: string
  title: string
  body: string
}

/** The adapter's own withdrawal (ISSUE-113: no port method): closes the notification shown under `key`, if any. */
export interface NotificationWithdrawal {
  close(key: string): void
}
