// How UI main was started (07 machine 10): a normal launch (S10.01), or a `--background` start by the OS login entry
// (ADR-027 item 7, S40.11) or by the Host (S12.C03), which is tray-only: the tray and the Host, no window (S10.03).
// Pure: the argv is read by the composition root.

/** The flag the login entry and the Host start the app with (ADR-027 item 7; ADR-018 D5). */
export const BACKGROUND_START_FLAG = '--background'

/** The arguments the login entry starts the app's launch path with (ADR-027 item 7). */
export const LOGIN_ENTRY_ARGS: readonly string[] = [BACKGROUND_START_FLAG]

export type UiStartKind = 'normal' | 'background'

/** What a start opens: the tray always; a window only on a normal launch, never on a background start (S10.03). */
export interface UiStartPlan {
  kind: UiStartKind
  tray: true
  window: boolean
}

/** The start of a process launched with `argv` (its own executable first). */
export function uiStartPlanOf(argv: readonly string[]): UiStartPlan {
  const background = argv.slice(1).includes(BACKGROUND_START_FLAG)
  return background
    ? { kind: 'background', tray: true, window: false }
    : { kind: 'normal', tray: true, window: true }
}
