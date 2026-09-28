/*
 * The redesigned portrait's options and what they decide (#635), `atoms/portrait` in the design:
 * the PO's painted face for a rank in a notched frame, its status a mark on the frame. An
 * interactive portrait is a button named after the dwarf and its state, with aria-pressed for
 * selection; a static one is an unnamed figure. The component draws; this decides.
 *
 * The status is the portrait's own vocabulary, the five the design draws, not the session status
 * on the wire: a screen that shows a dwarf decides which of these its dwarf is.
 */

export type PortraitStatus = 'working' | 'asking' | 'asleep' | 'done' | 'idle'
/** sm is 32px (tooltips, chat tabs, history), the default 40px, lg 48px, frame included. */
export type PortraitSize = 'sm' | 'lg'
/** A look forced without the pointer or the keyboard, as the UI kit's own states show it. */
export type PortraitState = 'hover' | 'active' | 'focus'

const MARK: Record<PortraitStatus, string> = {
  asking: '?',
  asleep: 'z',
  working: '',
  done: '✓',
  idle: ''
}

const STATUS_TEXT: Record<PortraitStatus, string> = {
  asking: 'needs you',
  asleep: 'asleep',
  working: 'working',
  done: 'done',
  idle: 'idle'
}

export function portraitMark(status: PortraitStatus): string {
  return MARK[status]
}

export function portraitStatusText(status: PortraitStatus): string {
  return STATUS_TEXT[status]
}

export function portraitClasses(options: { size?: PortraitSize; state?: PortraitState }): string[] {
  const classes = ['dm-portrait', 'm-mat']
  if (options.size) classes.push('dm-portrait--' + options.size)
  if (options.state) classes.push('is-' + options.state)
  return classes
}

export interface PortraitAttributes {
  'data-status': PortraitStatus
  type?: 'button'
  'aria-pressed'?: 'true' | 'false'
  'aria-label'?: string
}

export function portraitAttributes(options: {
  interactive: boolean
  status: PortraitStatus
  name: string
  selected?: boolean
}): PortraitAttributes {
  if (!options.interactive) return { 'data-status': options.status }
  return {
    type: 'button',
    'data-status': options.status,
    'aria-pressed': options.selected ? 'true' : 'false',
    'aria-label': options.name + ', ' + portraitStatusText(options.status)
  }
}
