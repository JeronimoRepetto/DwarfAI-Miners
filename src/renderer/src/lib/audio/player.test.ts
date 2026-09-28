// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElementAudioPlayer } from './player'

/**
 * The real player's one switch that the fake cannot prove on its behalf
 * (#637): whether the media element itself wraps.
 *
 * `Audio` is swapped for a factory handing back a plain jsdom `<audio>`, kept
 * so the test can read what the player set on it. Nothing is played — jsdom
 * has no media pipeline, and `play()` is never called here.
 */
describe('createElementAudioPlayer — looping (#637)', () => {
  let created: HTMLAudioElement[]

  beforeEach(() => {
    created = []
    vi.stubGlobal('Audio', function FakeAudio(src: string): HTMLAudioElement {
      const element = document.createElement('audio')
      element.src = src
      created.push(element)
      return element
    } as unknown as typeof Audio)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('never wraps a sound that did not ask to loop', () => {
    // The music's gap and the room tone's seam are both scheduled before the
    // end of the sound; an element that wraps on its own gives them nothing
    // to schedule from.
    createElementAudioPlayer().open('bed.mp3', { volume: 0.5 })
    expect(created[0]!.loop).toBe(false)
  })

  it('lets the element wrap a sound opened as a loop', () => {
    createElementAudioPlayer().open('walk.mp3', { volume: 0.5, loop: true })
    expect(created[0]!.loop).toBe(true)
  })
})
