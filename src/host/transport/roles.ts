// The role scopes of the UI endpoint (ADR-003 item 12, frozen), as data: the "Roles" column of
// 14 §2.3 (methods) and §2.4 (frames), consulted per request (FORBIDDEN, 14 §3.3) and per frame.
//
// - `ui`: the full UI protocol, `host.shutdown` included.
// - `notifier`: `ping`, `attention.clicked` and `session.snapshot` (names sections only, 14 §3.7);
//   it receives `attention.notify`, `attention.withdraw` and `host.closing` only. It never mutates.
// - `viewer`: `ping`, `events.subscribe` and `conversation.feed` for its own dwarf (ADR-031 item 2).
// - Every other role (`mcp` belongs to the MCP endpoint) → FORBIDDEN.
//
// `hello` is the first frame, not a method (B-M01), and `hello.ok` / `error` are response frames,
// not `evt` frames (B-F01, B-F02), so none of them is listed here. New rows join with the issue
// that serves them; the table stays the one source of the scope rule.
import type { Hello } from '@dwarfai/contracts'

export type ChannelRole = Hello['role']

const UI: readonly ChannelRole[] = ['ui']
const UI_VIEWER: readonly ChannelRole[] = ['ui', 'viewer']

/** 14 §2.3 B-M02…B-M41: method → the roles that may call it. */
export const METHOD_ROLES: Readonly<Record<string, readonly ChannelRole[]>> = Object.freeze({
  ping: ['ui', 'notifier', 'viewer'], // B-M02
  'events.subscribe': UI_VIEWER, // B-M03
  'session.snapshot': ['ui', 'notifier'], // B-M04 (notifier: names sections only)
  'host.shutdown': UI, // B-M05
  'host.upgrade.request': UI, // B-M06
  presence: UI, // B-M07
  'attention.clicked': ['notifier'], // B-M08
  'ui.resetPreferences.ack': UI, // B-M09
  'settings.secret.set': UI, // B-M10
  'settings.secret.clear': UI, // B-M11
  'preferences.get': UI, // B-M12
  'preferences.set': UI, // B-M13
  'preferences.setOpenCodePermissions': UI, // B-M14
  'preferences.resetMetrics': UI, // B-M15
  'mines.declare': UI, // B-M16
  'mines.adoptMainProject': UI, // B-M17
  'mines.remove': UI, // B-M18
  'mines.list': UI, // B-M19
  'mines.resolveFile': UI, // B-M20
  'crew.stop': UI, // B-M21
  'crew.rename': UI, // B-M22
  'crew.resetName': UI, // B-M23
  'conversation.send': UI, // B-M24
  'conversation.retry': UI, // B-M25
  'conversation.feed': UI_VIEWER, // B-M26 (viewer: own dwarf only)
  'conversation.mineHistory': UI, // B-M27
  'conversation.describeAttachments': UI, // B-M28
  'conversation.resolveConsole': UI, // B-M29
  'asking.answerQuestion': UI, // B-M30
  'asking.answerPermission': UI, // B-M31
  'asking.setStep': UI, // B-M32
  'launching.launch': UI, // B-M33
  'launching.launchCustom': UI, // B-M34
  'launching.retryRecovery': UI, // B-M35
  'launching.dismissRecovery': UI, // B-M36
  'suppliers.launchable': UI, // B-M37
  'jev.suggest': UI, // B-M38
  'preferences.setClaudeHooks': UI, // B-M39
  'preferences.answerWelcome': UI, // B-M40
  'strangler.dwarfIdentities': UI // B-M41 (only LegacyDwarfIdBridge calls it)
})

/** 14 §2.4 B-F03…B-F28: evt frame → the roles that receive it. */
export const FRAME_ROLES: Readonly<Record<string, readonly ChannelRole[]>> = Object.freeze({
  'resync-required': UI_VIEWER, // B-F03
  'host.state': UI, // B-F04
  'host.closing': ['ui', 'notifier'], // B-F05
  'mine.changed': UI, // B-F06
  'mine.removed': UI, // B-F07
  'dwarf.arrived': UI, // B-F08
  'dwarf.changed': UI, // B-F09
  'dwarf.departed': UI_VIEWER, // B-F10 (viewer: own dwarf)
  'conversation.appended': UI_VIEWER, // B-F11 (viewer: own dwarf)
  'message.delivery': UI, // B-F12
  'activity.changed': UI_VIEWER, // B-F13 (viewer: own dwarf)
  'turn.ended': UI, // B-F14
  'ask.opened': UI, // B-F15
  'ask.closed': UI, // B-F16
  'ask.step': UI, // B-F17
  'launch.changed': UI, // B-F18
  'launch.failed': UI, // B-F19
  'ledger.changed': UI, // B-F20
  'host.recovered': UI, // B-F21
  'attention.notify': ['notifier'], // B-F22
  'attention.withdraw': ['notifier'], // B-F23
  'preferences.changed': UI, // B-F24
  'integration.changed': UI, // B-F25
  'ui.resetPreferences': UI, // B-F26
  'reset.progress': UI, // B-F27
  toast: UI // B-F28
})

/**
 * The protocol set: methods served while the Host is `starting` or `migrating`. Every other method
 * answers HOST_NOT_READY then (14 §3.3). These are the 14 §2.3 rows whose errors do not include
 * the standard set `eB` (which holds HOST_NOT_READY): `ping` (B-M02) only.
 */
export const PROTOCOL_METHODS: ReadonlySet<string> = new Set(['ping'])
