import { describe, expect, it } from 'vitest'
import { messageSurfaceMotion } from './surfaceMotion'

/*
 * Which motion a change of surface calls for (#389).
 *
 * The choice this file pins is the CUT: a panel that swaps the dwarf it is open
 * on, or hands the Add Panel over to the MessagePanel, moves nothing. Only the
 * window arriving and the window leaving are motion.
 */
describe('messageSurfaceMotion', () => {
  it('rises when a surface opens on a window that was showing none', () => {
    expect(messageSurfaceMotion('none', 'message')).toBe('enter')
    expect(messageSurfaceMotion('none', 'launch')).toBe('enter')
  })

  it('settles when the last surface closes', () => {
    expect(messageSurfaceMotion('message', 'none')).toBe('leave')
    expect(messageSurfaceMotion('launch', 'none')).toBe('leave')
  })

  it('cuts between two surfaces of one open window, rather than crossfading', () => {
    // The window is re-placed at the new surface's own height, so a crossfade
    // would dissolve one panel into another while main resizes the window
    // around both — the resize painted THROUGH the motion, which is the very
    // thing the shell's fold exists to avoid (#388).
    expect(messageSurfaceMotion('message', 'message')).toBe('cut')
    expect(messageSurfaceMotion('launch', 'message')).toBe('cut')
    expect(messageSurfaceMotion('message', 'launch')).toBe('cut')
  })

  it('has nothing to do when nothing was open and nothing opened', () => {
    expect(messageSurfaceMotion('none', 'none')).toBe('cut')
  })
})
