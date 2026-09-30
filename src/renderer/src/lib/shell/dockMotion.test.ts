import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dockReplaceMotion, dockWindowMotion } from './dockMotion'

const css = readFileSync(join(import.meta.dirname, '../../assets/design-tokens.css'), 'utf8')
/** A token's value at rest, outside the reduced-motion block. */
const token = (name: string): string =>
  new RegExp('--' + name + ':\\s*([^;]+);').exec(css.slice(0, css.indexOf('@media')))![1]!.trim()
const ms = (name: string): number => Number.parseFloat(token(name))
const bezier = (name: string): number[] =>
  /cubic-bezier\(([^)]+)\)/.exec(token(name))![1]!.split(',').map(Number)

/*
 * #635, motion.md, "MessagePanel window (Panel)": the dock's window slot opens fading in from 12px
 * on its far side, away from the shell, over --dur-panel with --ease-out, and closes fading out 8px
 * toward the shell over --dur-fast with --ease-in. "Toward the edge" mirrors when the Panel docks
 * left, and the slot stands on the plate's outer side, so the far side is the free one on both.
 */
describe('the dock window opens and closes', () => {
  it('opens from 12px on its far side, docked right: from the left, over --dur-panel', () => {
    expect(dockWindowMotion(false, 'right')).toEqual({
      keyframes: { opacity: [0, 1], x: [-12, 0] },
      transition: { duration: ms('dur-panel') / 1000, ease: bezier('ease-out') }
    })
  })

  it('closes 8px toward the shell, docked right: to the right, over --dur-fast', () => {
    expect(dockWindowMotion(true, 'right')).toEqual({
      keyframes: { opacity: [1, 0], x: [0, 8] },
      transition: { duration: ms('dur-fast') / 1000, ease: bezier('ease-in') }
    })
  })

  it('mirrors both for a left dock, where the shell stands on the slot’s left', () => {
    expect(dockWindowMotion(false, 'left').keyframes).toEqual({ opacity: [0, 1], x: [12, 0] })
    expect(dockWindowMotion(true, 'left').keyframes).toEqual({ opacity: [1, 0], x: [0, -8] })
    expect(dockWindowMotion(false, 'left').transition).toEqual(
      dockWindowMotion(false, 'right').transition
    )
    expect(dockWindowMotion(true, 'left').transition).toEqual(
      dockWindowMotion(true, 'right').transition
    )
  })
})

/*
 * #635, motion.md, "Mine column leaves": an open window closes at once — "removed at once", 0ms,
 * no travel — and only then does the column fade and the rest FLIP back.
 */
describe('the dock window when its mine closes', () => {
  it('is removed at once, with no travel and no duration', () => {
    for (const edge of ['right', 'left'] as const) {
      expect(dockWindowMotion(true, edge, { withMine: true })).toEqual({
        keyframes: { opacity: [1, 0] },
        transition: { duration: 0 }
      })
    }
  })

  it('still closes toward the shell when the mine stays open', () => {
    expect(dockWindowMotion(true, 'right', { withMine: false })).toEqual(
      dockWindowMotion(true, 'right')
    )
  })
})

/*
 * APPENDED (#635, the MessagePanel slice), motion.md, "MessagePanel window (Panel)": what an open
 * slot holds replaced — a chat for the history, the Add panel for a chat — is a fade in with no
 * travel over --dur-base with --ease-out, the old content removed at once.
 */
describe('the dock window when what it holds is replaced', () => {
  it('fades the new content in with no travel, over --dur-base', () => {
    expect(dockReplaceMotion(false)).toEqual({
      keyframes: { opacity: [0, 1] },
      transition: { duration: ms('dur-base') / 1000, ease: bezier('ease-out') }
    })
  })

  it('removes the old content at once', () => {
    expect(dockReplaceMotion(true)).toEqual({
      keyframes: { opacity: [1, 0] },
      transition: { duration: 0 }
    })
  })
})
