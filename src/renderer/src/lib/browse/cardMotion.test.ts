import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MINE_CARD_ENTER, MINE_CARD_EXIT } from './cardMotion'

const css = readFileSync(join(import.meta.dirname, '../../assets/design-tokens.css'), 'utf8')
/** A token's value at rest, outside the reduced-motion block. */
const token = (name: string): string =>
  new RegExp('--' + name + ':\\s*([^;]+);').exec(css.slice(0, css.indexOf('@media')))![1]!.trim()
const ms = (name: string): number => Number.parseFloat(token(name))
const bezier = (name: string): number[] =>
  /cubic-bezier\(([^)]+)\)/.exec(token(name))![1]!.split(',').map(Number)

/*
 * #635, PANEL-QUESTIONS 9 (design lead ruling 2026-09-27): an added mine's card enters rising
 * --rise 6px from transparent over --dur-base with --ease-out; a removed mine's card leaves sliding
 * 8px left to transparent over --dur-fast with --ease-in. Transform and opacity only.
 */
describe('the mine card enters and leaves', () => {
  it('enters: opacity 0 to 1, rising --rise, over --dur-base with --ease-out', () => {
    expect(MINE_CARD_ENTER.keyframes).toEqual({
      opacity: [0, 1],
      y: [Number.parseFloat(token('rise')), 0]
    })
    expect(MINE_CARD_ENTER.transition).toEqual({
      duration: ms('dur-base') / 1000,
      ease: bezier('ease-out')
    })
  })

  it('leaves: opacity 1 to 0, sliding 8px left, over --dur-fast with --ease-in', () => {
    expect(MINE_CARD_EXIT.keyframes).toEqual({ opacity: [1, 0], x: [0, -8] })
    expect(MINE_CARD_EXIT.transition).toEqual({
      duration: ms('dur-fast') / 1000,
      ease: bezier('ease-in')
    })
  })
})
