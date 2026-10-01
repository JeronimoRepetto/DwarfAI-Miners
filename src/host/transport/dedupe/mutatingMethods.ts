// Which seam-B methods mutate (14 §1.6, frozen): exactly the 14 §3.4 rows whose params carry a
// `requestId`. Queries carry none, and so do `presence`, `attention.clicked`,
// `ui.resetPreferences.ack` and `asking.setStep` (idempotent by their own shape). The dispatcher
// refuses to register one of these with `register`, and refuses `registerMutating` for any other
// 14 §2.3 row, so the table stays the one source of the rule.

/** 14 §3.4: the 23 methods whose params carry `requestId`. */
export const MUTATING_METHODS: ReadonlySet<string> = new Set([
  'host.shutdown', // B-M05
  'host.upgrade.request', // B-M06
  'settings.secret.set', // B-M10
  'settings.secret.clear', // B-M11
  'preferences.set', // B-M13
  'preferences.setOpenCodePermissions', // B-M14
  'preferences.resetMetrics', // B-M15
  'mines.declare', // B-M16
  'mines.adoptMainProject', // B-M17
  'mines.remove', // B-M18
  'crew.stop', // B-M21
  'crew.rename', // B-M22
  'crew.resetName', // B-M23
  'conversation.send', // B-M24
  'conversation.retry', // B-M25
  'asking.answerQuestion', // B-M30
  'asking.answerPermission', // B-M31
  'launching.launch', // B-M33
  'launching.launchCustom', // B-M34
  'launching.retryRecovery', // B-M35
  'launching.dismissRecovery', // B-M36
  'preferences.setClaudeHooks', // B-M39
  'preferences.answerWelcome' // B-M40
])

/**
 * 14 §1.6: the mutating methods whose `requestId` is also a durable key, so main may re-send them
 * after a Host restart (new epoch). The transport only hands them the `requestId`; the keys live
 * in their modules' tables (later: ISSUE-166 `messages.request_id` UNIQUE, ISSUE-128 the
 * `ask_answers` PK).
 */
export const DURABLE_KEY_METHODS: ReadonlySet<string> = new Set([
  'conversation.send',
  'asking.answerQuestion',
  'asking.answerPermission'
])
