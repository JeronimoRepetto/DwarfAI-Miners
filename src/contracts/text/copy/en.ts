// The English copy catalog: every user-visible string of the rebuilt UI, keyed by a stable, namespaced key.
// See `index.ts` for how to add a key. Rules for a value:
// - Approved copy is written exactly as approved.
// - Copy design has not written yet is the `⟦COPY NEEDED: <design item>⟧` marker, exactly (25-AGENTS §8.1); never
//   invented text. No value ships a marker today: the owner approved every text on 2026-10-11.
// - A `{name}` slot is filled with a value as plain text by `t`. A plural entry holds one string per form and gets
//   `{count}`.
import type { CopyCatalog } from './catalog'

export const en = {
  // The Host-state message (ADR-002 D8 items 4–5, D9; O-4, O-5; 13 FM-007 "O-15 crash-loop variant").
  'hostState.reconnecting.text': 'Reconnecting… The panel is read-only until it is back.',
  'hostState.crashLoop.text':
    'The part of DwarfAI-Miners that runs your dwarfs stopped several times in a few minutes, so it is no longer restarted on its own. The panel is read-only until it runs again.',
  'hostState.crashLoop.title': 'DwarfAI-Miners keeps stopping',
  'hostState.unresponsive.text':
    'The part of DwarfAI-Miners that runs your dwarfs has stopped responding. Trying again restarts it; dwarfs it was running may be interrupted.',
  'hostState.unresponsive.title': 'DwarfAI-Miners is not responding',
  'hostState.incompatible.text':
    'A newer version of DwarfAI-Miners is already running, and this version cannot work with it. Stop everything and quit to continue.',
  'hostState.incompatible.title': 'A newer version is running',
  'hostState.spawnFailed.text':
    'The part of DwarfAI-Miners that runs your dwarfs did not start. The panel is read-only until it does.',
  'hostState.spawnFailed.title': 'DwarfAI-Miners could not start',
  'hostState.elevatedRefused.text':
    'DwarfAI-Miners does not run with administrator rights. Close it and open it again normally.',
  'hostState.inJob.text':
    'Your dwarfs will stop when the program that opened DwarfAI-Miners closes. To keep them running, open DwarfAI-Miners from the Start menu.',
  'hostState.action.retry': 'Try again',
  'hostState.action.stopEverything': 'Stop everything and quit…',

  // The grouped recovery message (ADR-015 item 5, O-15; US-RES-009; ISSUE-330): owner-approved copy, 2026-10-17. One
  // plain-language message, no per-reason lines; the body is followed by the dwarfs' display names.
  'recovery.message.title': 'Some dwarfs could not come back',
  'recovery.message.body':
    "DwarfAI restarted in the background and could not resume these dwarfs' sessions:",
  'recovery.message.retry': 'Try again',
  'recovery.message.dismiss': 'Dismiss',

  // The design's own dialog labels (copy.md, Dialog).
  'dialog.cancel': 'Cancel',

  // Stop everything and quit, its confirmation and its danger messages (ADR-018 D5 copy items 4–7 and 9; O-3).
  'stopEverything.confirmation.title': 'Stop everything and quit?',
  'stopEverything.confirmation.count': {
    '=0': 'No dwarf started by DwarfAI-Miners is running.',
    one: '{count} dwarf started by DwarfAI-Miners will stop.',
    other: '{count} dwarfs started by DwarfAI-Miners will stop.'
  },
  'stopEverything.confirmation.ownTerminal':
    'Dwarfs you started in your own terminal keep running, but DwarfAI-Miners stops watching them.',
  'stopEverything.confirmation.confirm': {
    '=0': 'Stop everything and quit',
    one: 'Stop {count} dwarf and quit',
    other: 'Stop {count} dwarfs and quit'
  },
  'stopEverything.incomplete.title': 'Some dwarfs could not be stopped',
  'stopEverything.incomplete.body':
    'Could not stop {names}. DwarfAI-Miners is still running and keeps watching them.',
  'stopEverything.incomplete.dismiss': 'Close',
  'stopEverything.unfinished.title': 'Stop everything did not finish',
  'stopEverything.unfinished.body':
    'Something went wrong while stopping. DwarfAI-Miners is still running, and you can try again.',
  'stopEverything.unfinished.dismiss': 'Close',

  // The tray menu (ADR-002 O-3; ADR-018 D5).
  'tray.open': 'Open DwarfAI-Miners',
  'tray.quit': 'Quit (dwarfs keep running)',
  'tray.stopEverything': 'Stop everything and quit…',

  // The "renderer crashed" message of UI main (ADR-019 item 11 open item, DG "renderer crashed"; DR-01).
  'rendererCrashed.message':
    'This window stopped working twice in a row. Your dwarfs are not affected.',
  'rendererCrashed.reload': 'Reload window',
  'rendererCrashed.dismiss': 'Close window',

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
  'outcomeLine.status.noReliableEnd': 'Gone quiet',
  'outcomeLine.part.steps': { one: '{count} step', other: '{count} steps' },
  'outcomeLine.part.stepsSoFar': { one: '{count} step so far', other: '{count} steps so far' },
  'outcomeLine.part.waitingQuestions': {
    one: '{count} question',
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

  // The first-run consent step (AMENDMENT-7, OQ-68; 07 machine 41; SCR-31; ADR-016 item 5).
  'welcome.step.title': 'Connect your tools',
  'welcome.step.body':
    "DwarfAI-Miners can connect with the tools below, so your dwarfs update instantly and their permission requests can be answered from the panel. Each one adds a small entry to that tool's own settings. Anything you leave off stays off; you can turn it on later in Settings › Integrations.",
  'welcome.option.claudeHooks': 'Claude Code · instant updates',
  'welcome.option.openCodePermissions': 'OpenCode · permission requests',
  'welcome.step.activate': 'Activate',
  'welcome.result.failure':
    'Could not change {names}. You can try again in Settings › Integrations.',
  'welcome.result.dismiss': 'Close',

  // The Add panel's OpenCode notice (ADR-011 item 7, O-14; 07 S5.02, S5.26; US-LAUNCH-001.AC13; ISSUE-228, ISSUE-235):
  // owner-approved copy, 2026-10-18.
  'addPanel.openCodeNotice.text':
    "OpenCode permission requests are off, so its asks won't show here.",
  'addPanel.openCodeNotice.action': 'Turn on',
  'addPanel.openCodeNotice.failure':
    "Couldn't turn on OpenCode permission requests. Try again from Settings.",

  // The Add panel's Jev card tooltip flag lines, in their fixed order (US-LAUNCH-008.AC04, the story's own text;
  // AMENDMENT-22 carries the trivial and large-context flags to the card).
  'jevCard.tip.trivial': 'Treated as a trivial prompt.',
  'jevCard.tip.largeContext': 'Large-context model preferred.',
  'jevCard.tip.trimmed': 'The prompt sent to Jev was trimmed to fit its request budget.'
} as const satisfies CopyCatalog
