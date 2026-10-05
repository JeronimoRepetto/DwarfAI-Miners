// `revealDwarfChat`: the reveal a level-3 notification click runs in UI main (ISSUE-114; ADR-018 item 6, OQ-34 C,
// OQ-45, PO #96; ADR-025 item 8; 16 §4.14 `ShellModeController.revealDwarfChat`; 07 S10.10–S10.12; 12 UC-064). It
// replaces today's click → `onShowMine` (A-P5, the rejected option A); the Host is told nothing here (the presenter
// sends `attention.clicked` for a counter, S17.06) and never raises or "shows" anything.
//
// - The mode is the person's, never switched (S10.10): the mode of the window that exists, a hidden or minimized one
//   included, which is restored in its own mode (S10.11; "Mode at launch" is not used then, lead decision R4B-13).
// - With no window open (tray only), the app first opens the way any launch does, per "Mode at launch" (US-SHELL-006;
//   S10.12), and the reveal runs in the mode that open answers.
// - The dwarf is looked up on the board read model: one that left meanwhile is revealed as its mine with no chat
//   (`dwarfId: null`, `'mine-only'`; S24.16, S39.07).
// - The window is then asked to come to the front (`WindowRaiser`, S-018-2). A refusal (Windows' foreground rules)
//   leaves the reveal done and is logged by event name only (`window.raise`, 19 §9; 13 FM-049); there is no foreground
//   workaround (S-018-2 Decision).
// - Reveals run one after another: a second click while the first is still opening the app finds the window the first
//   opened, so the app is never opened twice. The raise is outside that order, so one the OS keeps waiting never holds
//   back the next click.
//
// Each mode's reveal is its own (`ModeReveal`): the Panel's pushes A-N16 to the Panel window (adapters/panelReveal.ts);
// Veta's unfolds a chamber folded into "+N" and Valle's scrolls the zone into view, with their epics (EPIC-19, EPIC-20).
// A mode with no reveal is not built, so it is never open (hidden until built, 21 §1 item 8); reaching one is a
// composition fault and fails the reveal loudly. A click during a mode transition is held by the `ModeCoordinator`
// (S27.14), which is not built yet: the Panel is the one mode until then.
import {
  dwarfIdSchema,
  type DwarfId,
  type MineId,
  type RevealDwarfChatPush
} from '@dwarfai/contracts'
import type { UiLog } from '../../diagnostics/uiLogger'
import type { HostClient } from '../ports/hostClient'

/** What a mode window is told to reveal (A-N16's payload, 14 §3.8): `dwarfId` null when the dwarf left. */
export type RevealTarget = RevealDwarfChatPush

/** One mode's reveal (Panel: `adapters/panelReveal.ts`; Veta and Valle with their epics, ADR-025 item 8). */
export interface ModeReveal {
  reveal(target: RevealTarget): void
}

/** The modes a reveal can run in (14 §3.9 `WindowMode` without `hidden`). */
export type RevealMode = 'panel' | 'veta' | 'valle'

/** What the reveal came to (16 §4.14): the chat open, or the mine with no chat because the dwarf left. */
export type RevealOutcome = 'chat-open' | 'mine-only'

/**
 * The `revealDwarfChat` member of 16 §4.14 `ShellModeController`, with its signature as written there. The port's
 * other member, `moveTo`, is the `ModeCoordinator`'s, which lands with the mode switch (EPIC-19).
 */
export interface DwarfChatRevealer {
  revealDwarfChat(t: { mineId: MineId; dwarfId: DwarfId }): Promise<RevealOutcome>
}

/** The mode windows, as the reveal needs them (composed by the UI-main root over the window module). */
export interface RevealWindows {
  /** The mode of the mode window that exists, shown, hidden or minimized; null when none is open (tray only). */
  existing(): RevealMode | null
  /** Shows the existing window of `mode` again, unminimized, in its own mode (S10.11); a shown one stays as it is. */
  restore(mode: RevealMode): void
  /** Opens the app as any launch does, per "Mode at launch" (US-SHELL-006; S10.12), and answers the mode it opened. */
  openAtLaunch(): Promise<RevealMode>
  /** Asks the window of `mode` to come to the front (`WindowRaiser`, S-018-2): false when the OS refused (FM-049). */
  raise(mode: RevealMode): Promise<boolean>
}

export interface RevealDwarfChatDeps {
  windows: RevealWindows
  /** The reveal of each mode built in this version. */
  reveals: Readonly<Partial<Record<RevealMode, ModeReveal>>>
  /** Whether the dwarf is still in the mine, on the board read model UI main holds. */
  dwarfPresent(t: { mineId: MineId; dwarfId: DwarfId }): boolean
  log: UiLog
}

export function createRevealDwarfChat(deps: RevealDwarfChatDeps): DwarfChatRevealer {
  const { windows, reveals, log } = deps
  /** The reveal running now, so the next one starts after it settled. */
  let running: Promise<unknown> = Promise.resolve()

  const modeToRevealIn = async (): Promise<RevealMode> => {
    const open = windows.existing()
    if (open === null) return windows.openAtLaunch()
    windows.restore(open)
    return open
  }

  /** Finds the mode and pushes the reveal there; the part that runs one click at a time. */
  const revealInMode = async (t: {
    mineId: MineId
    dwarfId: DwarfId
  }): Promise<{ mode: RevealMode; present: boolean }> => {
    const mode = await modeToRevealIn()
    const modeReveal = reveals[mode]
    if (modeReveal === undefined) throw new Error(`revealDwarfChat: no reveal is built for ${mode}`)
    const present = deps.dwarfPresent(t)
    modeReveal.reveal({ mineId: t.mineId, dwarfId: present ? t.dwarfId : null })
    return { mode, present }
  }

  /** Asks the window to the front after the reveal; a refusal is logged and changes nothing (FM-049). */
  const raise = async (mode: RevealMode): Promise<void> => {
    let raised = false
    try {
      raised = await windows.raise(mode)
    } catch {
      // A raise that failed is a raise the OS refused: the reveal is done either way.
    }
    if (!raised)
      log.record({ level: 'warn', event: 'window.raise', subsystem: 'window', outcome: 'failed' })
  }

  return {
    async revealDwarfChat(t) {
      // Only the mode and the push are serialized: a raise the OS keeps waiting never holds back the next click.
      const shown = running.then(() => revealInMode(t))
      running = shown.catch(() => undefined)
      const { mode, present } = await shown
      await raise(mode)
      return present ? 'chat-open' : 'mine-only'
    }
  }
}

/**
 * The board presence a reveal reads (ISSUE-114): whether a dwarf is still in its mine, as far as UI main has heard. A
 * dwarf counts as present until the Host's `dwarf.departed` frame for it arrives (14 §3.5; INV-34, 07 S2.04), the same
 * frame the UI session store drops a dwarf's entries on. The conservative reading: UI main keeps no fuller board until
 * the cut-1 switch routes the Host board (ISSUE-123), so a dwarf never heard of is not declared gone, and the Panel's
 * own board check still opens no chat for a dwarf it does not draw (`App.vue`).
 */
export interface DepartedDwarfs {
  present(t: { mineId: MineId; dwarfId: DwarfId }): boolean
  dispose(): void
}

export function createDepartedDwarfs(host: Pick<HostClient, 'subscribe'>): DepartedDwarfs {
  const departed = new Set<DwarfId>()
  const unsubscribe = host.subscribe((event) => {
    if (event.kind !== 'frame') return
    const name: string = event.frame.name
    if (name !== 'dwarf.departed') return
    const data = event.frame.data as { dwarfId?: unknown } | null
    const dwarfId = dwarfIdSchema.safeParse(data?.dwarfId)
    if (dwarfId.success) departed.add(dwarfId.data)
  })
  return { present: ({ dwarfId }) => !departed.has(dwarfId), dispose: unsubscribe }
}
