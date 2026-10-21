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
  'jevCard.tip.trimmed': 'The prompt sent to Jev was trimmed to fit its request budget.',

  // The Veta grip (US-VETA-002; ISSUE-286): the design's own copy (DS/docs/copy.md, Veta strip, aria-label and title).
  'veta.grip.label':
    'Veta. Press for the menu; drag, or use the arrow keys, to move it to another edge',
  'veta.grip.title': 'Drag to move · click for the menu',

  // Veta's strip and its closed entrance (US-VETA-001, US-VETA-010, US-VETA-011; ISSUE-287): the design's own copy
  // (DS/docs/copy.md, Veta strip, Mine chamber and Mine entrance; the first-run name is also 07 machine 20's). The
  // chamber's name is the design's run-time `Mine {name}, {tier}, {count} dwarf[s][, {asking} needs | need you]`, its
  // asking tail a second entry since one entry counts one number.
  'veta.region.label': 'Veta',
  'veta.expand.label': 'Open the Panel',
  'veta.entrance.label': 'No sessions running. Open the Panel',
  'veta.entrance.title': 'No sessions · open the Panel',
  'veta.entrance.firstRun.label': 'No mines yet. Add your first mine',
  'veta.entrance.firstRun.title': 'Add your first mine',
  'veta.chamber.label': {
    one: 'Mine {name}, {tier}, {count} dwarf',
    other: 'Mine {name}, {tier}, {count} dwarfs'
  },
  'veta.chamber.asking': { one: '{count} needs you', other: '{count} need you' },

  // A dwarf in a Veta chamber (US-VETA-005; 07 machine 24; ISSUE-290): its name as a target, the design's run-time
  // `<name>, <status>, silent <silence>` (DS/docs/copy.md, Veta strip, each dwarf's aria-label), and its one-line hover
  // label "`<name>` · `<status>` · silent `<silence>`" (DS/docs/components.md, Mine chamber, Anatomy; US-VETA-005.AC01,
  // PO #54). The status words are the design's: working, needs you, asleep and idle. A silence nobody measured prints
  // nothing rather than a guess (the dwarf tooltip's rule), so each line has a form without it.
  'veta.dwarf.label': '{name}, {status}, silent {silence}',
  'veta.dwarf.label.unmeasured': '{name}, {status}',
  'veta.dwarf.tip': '{name} · {status} · silent {silence}',
  'veta.dwarf.tip.unmeasured': '{name} · {status}',
  'veta.dwarf.status.working': 'working',
  'veta.dwarf.status.asking': 'needs you',
  'veta.dwarf.status.asleep': 'asleep',
  'veta.dwarf.status.idle': 'idle',

  // A chamber's mine tab (US-VETA-004; 07 machine 23; ISSUE-289): its two icon buttons' names and titles, the design's
  // own copy (DS/docs/copy.md, Mine tab, "Built at run time"; DS/docs/accessibility.md, the Veta mine tab).
  'veta.tab.open': 'Open {name} in the Panel',
  'veta.tab.newDwarf': 'New dwarf in {name}',

  // The grip menu (US-VETA-003; 07 machine 22; ISSUE-288): the design's own copy (DS/docs/screens/veta.md, the grip
  // menu in order; DS/docs/copy.md, Veta strip, "Also in the code"). "New dwarf in…" carries the hint ▸.
  'veta.menu.openPanel': 'Open Panel',
  'veta.menu.openValle': 'Open Valle',
  'veta.menu.newDwarf': 'New dwarf in…',
  'veta.menu.newDwarf.hint': '▸',
  'veta.menu.hide': 'Hide window',

  // The mine picker (US-LAUNCH-007; 07 machine 22; ISSUE-288): the design's own copy (DS/docs/copy.md, Mine picker,
  // its strings, "Built at run time" and "Also in the code").
  'minePicker.label': 'Choose a mine',
  'minePicker.title': 'New dwarf in…',
  'minePicker.search': 'Search mines',
  'minePicker.list.label': 'Mines',
  'minePicker.noMatch': 'No mine matches.',
  'minePicker.empty': 'No mines yet. Add a project folder to start.',
  'minePicker.add': 'Add a mine',
  'minePicker.crew': '{count} at work',
  'minePicker.nobody': 'nobody here',
  'minePicker.cannotEnter': 'Cannot be entered'
} as const satisfies CopyCatalog
