// The English copy catalog: every user-visible string of the rebuilt UI, keyed by a stable, namespaced key.
// See `index.ts` for how to add a key. Rules for a value:
// - Approved copy is written exactly as approved.
// - Copy design has not written yet is the `⟦COPY NEEDED: <design item>⟧` marker, exactly (25-AGENTS §8.1); never
//   invented text.
// - A `{name}` slot is filled with a value as plain text by `t`. A plural entry holds one string per form and gets
//   `{count}`.
import type { CopyCatalog } from './catalog'

export const en = {
  // The Host-state message (ADR-002 D8 items 4–5, D9; O-4, O-5; 13 FM-007 "O-15 crash-loop variant").
  'hostState.reconnecting.text': '⟦COPY NEEDED: O-5 reconnecting message⟧',
  'hostState.crashLoop.text': '⟦COPY NEEDED: O-15 crash-loop variant⟧',
  'hostState.crashLoop.title': '⟦COPY NEEDED: O-15 crash-loop variant, dialog title⟧',
  'hostState.unresponsive.text': '⟦COPY NEEDED: O-5 Host-unresponsive message⟧',
  'hostState.unresponsive.title': '⟦COPY NEEDED: O-5 Host-unresponsive message, dialog title⟧',
  'hostState.incompatible.text': '⟦COPY NEEDED: O-5 incompatible Host message⟧',
  'hostState.incompatible.title': '⟦COPY NEEDED: O-5 incompatible Host message, dialog title⟧',
  'hostState.spawnFailed.text': '⟦COPY NEEDED: O-5 Host did not start message⟧',
  'hostState.spawnFailed.title': '⟦COPY NEEDED: O-5 Host did not start message, dialog title⟧',
  'hostState.elevatedRefused.text': '⟦COPY NEEDED: O-4 elevated-refused message⟧',
  'hostState.inJob.text': '⟦COPY NEEDED: O-4 in-job message⟧',
  'hostState.action.retry': '⟦COPY NEEDED: O-5 Host-state Retry action⟧',
  'hostState.action.stopEverything': '⟦COPY NEEDED: O-3 Stop everything and quit action⟧',

  // The design's own dialog labels (copy.md, Dialog).
  'dialog.cancel': 'Cancel',

  // Stop everything and quit, its confirmation and its danger messages (ADR-018 D5 copy items 4–7 and 9; O-3).
  'stopEverything.confirmation.title':
    '⟦COPY NEEDED: Stop everything and quit, confirmation title (ADR-018 D5 copy item 4)⟧',
  // Design gives the zero, singular and plural forms; until then each form is the marker.
  'stopEverything.confirmation.count': {
    '=0': '⟦COPY NEEDED: Stop everything and quit, {count} sessions DwarfAI started will end, singular, plural and zero forms (ADR-018 D5 copy item 5)⟧',
    one: '⟦COPY NEEDED: Stop everything and quit, {count} sessions DwarfAI started will end, singular, plural and zero forms (ADR-018 D5 copy item 5)⟧',
    other:
      '⟦COPY NEEDED: Stop everything and quit, {count} sessions DwarfAI started will end, singular, plural and zero forms (ADR-018 D5 copy item 5)⟧'
  },
  'stopEverything.confirmation.ownTerminal':
    "⟦COPY NEEDED: Stop everything and quit, sessions started in the person's own terminal keep running and are no longer watched (ADR-018 D5 copy item 6)⟧",
  'stopEverything.confirmation.confirm':
    '⟦COPY NEEDED: Stop everything and quit, confirm button naming the count {count} (ADR-018 D5 copy item 7)⟧',
  'stopEverything.incomplete.title':
    '⟦COPY NEEDED: Stop everything and quit could not end every session, danger message title (ADR-018 D5 copy item 9)⟧',
  'stopEverything.incomplete.body':
    '⟦COPY NEEDED: Stop everything and quit could not end {names}, danger message naming the dwarfs (ADR-018 D5 copy item 9)⟧',
  'stopEverything.incomplete.dismiss':
    '⟦COPY NEEDED: Stop everything and quit could not end every session, dismiss button (ADR-018 D5 copy item 9)⟧',
  'stopEverything.unfinished.title':
    '⟦COPY NEEDED: Stop everything incomplete, no names: danger message title (closest: ADR-018 D5 copy item 9, which names the dwarfs)⟧',
  'stopEverything.unfinished.body':
    '⟦COPY NEEDED: Stop everything incomplete, no names: Stop everything and quit did not finish and DwarfAI keeps running (closest: ADR-018 D5 copy item 9, which names the dwarfs)⟧',
  'stopEverything.unfinished.dismiss':
    '⟦COPY NEEDED: Stop everything incomplete, no names: dismiss button (closest: ADR-018 D5 copy item 9)⟧',

  // The tray menu (ADR-002 O-3; ADR-018 D5).
  'tray.open': '⟦COPY NEEDED: open item label⟧',
  'tray.quit': '⟦COPY NEEDED: quit item label⟧',
  'tray.stopEverything':
    "⟦COPY NEEDED: label of the tray's secondary-menu action that stops every session the app launched and quits⟧",

  // The "renderer crashed" message of UI main (ADR-019 item 11 open item, DG "renderer crashed"; DR-01).
  'rendererCrashed.message': '⟦COPY NEEDED: DG "renderer crashed"⟧',
  'rendererCrashed.reload': '⟦COPY NEEDED: DG "renderer crashed" Reload⟧',
  'rendererCrashed.dismiss': '⟦COPY NEEDED: DG "renderer crashed" dismiss⟧',

  // The level-3 OS notification titles (PO decision 2026-09-28 #44; US-SHELL-010.AC03): {dwarf} is the dwarf's
  // display name, customName ?? baseName (ADR-018 item 9; PO #88). The body is the mine's own name, not copy.
  'attention.level3Title.permission': '{dwarf} asks for permission',
  'attention.level3Title.question': '{dwarf} has a question',
  'attention.level3Title.turnFinished': '{dwarf} finished the turn',

  // The turn outcome line under a dwarf's header (US-MSG-011 "States and copy"; 06 §9.2 parts), joined by " · ".
  'outcomeLine.separator': ' · ',
  'outcomeLine.status.working': 'Working',
  'outcomeLine.status.waitingOnYou': 'Waiting on you',
  'outcomeLine.status.concluded': 'Turn finished',
  'outcomeLine.status.capped': 'Turn stopped at a limit',
  'outcomeLine.status.errored': 'Turn failed',
  'outcomeLine.status.interrupted': 'Turn interrupted',
  'outcomeLine.status.noReliableEnd':
    '⟦COPY NEEDED: US-MSG-011 outcome line of a dwarf that became idle without a reliable end-of-turn signal (FUNCTIONAL-SPEC §9)⟧',
  'outcomeLine.part.steps': { one: '{count} step', other: '{count} steps' },
  'outcomeLine.part.stepsSoFar': { one: '{count} step so far', other: '{count} steps so far' },
  'outcomeLine.part.waitingQuestions': {
    one: '⟦COPY NEEDED: US-MSG-011 "Waiting on you" question count, singular form⟧',
    other: '{count} questions'
  },
  'outcomeLine.part.waitingPermission': 'permission',
  'outcomeLine.part.answersReceived': 'answers received',
  'outcomeLine.part.readingYourMessage': 'reading your message',
  'outcomeLine.part.idleFor': 'idle for {time}',
  // Idle time (NFR-TIM-15): minutes, hours, days, each rounded down, no larger unit ("41m", "2h", "7d").
  'outcomeLine.idle.minutes': '{count}m',
  'outcomeLine.idle.hours': '{count}h',
  'outcomeLine.idle.days': '{count}d',

  // The first-run consent step (AMENDMENT-7, OQ-68; 07 machine 41; SCR-31; ADR-016 item 5). Only the two option
  // labels are approved copy; every other string of the step is design's and not written yet.
  'welcome.step.title': '⟦COPY NEEDED: first-run consent step title (07 machine 41; SCR-31)⟧',
  'welcome.step.body':
    '⟦COPY NEEDED: first-run consent step, what connecting Claude Code and OpenCode does and that an unticked one can be turned on later in Settings → Integrations (07 machine 41; SCR-31)⟧',
  'welcome.option.claudeHooks': 'Claude Code · instant updates',
  'welcome.option.openCodePermissions': 'OpenCode · permission requests',
  'welcome.step.activate': '⟦COPY NEEDED: first-run consent step, Activate button (07 S41.04)⟧',
  'welcome.result.failure':
    '⟦COPY NEEDED: first-run consent step, {names} could not be turned on or reverted and can be retried from Settings (07 S41.05; 13 FM-148, FM-149)⟧',
  'welcome.result.dismiss':
    '⟦COPY NEEDED: first-run consent step, dismiss button of the failure line (07 S41.05)⟧'
} as const satisfies CopyCatalog
