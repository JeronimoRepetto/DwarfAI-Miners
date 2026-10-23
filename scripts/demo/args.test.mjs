import { describe, expect, it } from 'vitest'
import { parseDemoArgs } from './args.mjs'

describe('the demo command line', () => {
  it('runs the showcase once, visible, at normal speed and disposes its profile by default', () => {
    expect(parseDemoArgs([])).toEqual({
      ok: true,
      options: {
        scenario: 'showcase',
        keep: false,
        speed: 1,
        shots: false,
        out: null,
        sound: false,
        notifications: false,
        help: false,
        duration: null
      }
    })
  })

  it('takes --scenario, --keep and --speed in both spellings', () => {
    const parsed = parseDemoArgs(['--scenario', 'showcase', '--keep', '--speed=2.5'])
    expect(parsed).toMatchObject({
      ok: true,
      options: { scenario: 'showcase', keep: true, speed: 2.5 }
    })
    expect(parseDemoArgs(['--speed', '0.5'])).toMatchObject({ ok: true, options: { speed: 0.5 } })
  })

  it('takes --shots with an --out folder, and --out only with --shots', () => {
    expect(parseDemoArgs(['--shots', '--out', 'shots-here'])).toMatchObject({
      ok: true,
      options: { shots: true, out: 'shots-here' }
    })
    expect(parseDemoArgs(['--out', 'shots-here'])).toEqual({
      ok: false,
      error: '--out is only for --shots'
    })
  })

  it('refuses an unknown scenario, a speed out of range and an unknown option, naming each', () => {
    expect(parseDemoArgs(['--scenario', 'nowhere'])).toEqual({
      ok: false,
      error: 'unknown scenario "nowhere" (known: showcase)'
    })
    for (const speed of ['0', '-1', 'fast', '11']) {
      expect(parseDemoArgs(['--speed', speed])).toEqual({
        ok: false,
        error: `--speed takes a number from 0.25 to 10, not "${speed}"`
      })
    }
    expect(parseDemoArgs(['--speed'])).toEqual({ ok: false, error: '--speed needs a value' })
    expect(parseDemoArgs(['--loud'])).toEqual({ ok: false, error: 'unknown option "--loud"' })
  })

  it('ends the demo by itself after --duration seconds, a whole number from 10, or never by default', () => {
    expect(parseDemoArgs(['--duration', '90'])).toMatchObject({
      ok: true,
      options: { duration: 90 }
    })
    expect(parseDemoArgs([])).toMatchObject({ ok: true, options: { duration: null } })
    for (const duration of ['5', '1.5', 'soon']) {
      expect(parseDemoArgs(['--duration', duration])).toEqual({
        ok: false,
        error: `--duration takes whole seconds, at least 10, not "${duration}"`
      })
    }
  })

  it('keeps the app muted and its OS notifications recorded unless asked otherwise', () => {
    expect(parseDemoArgs(['--sound', '--notifications'])).toMatchObject({
      ok: true,
      options: { sound: true, notifications: true }
    })
    expect(parseDemoArgs(['--help'])).toMatchObject({ ok: true, options: { help: true } })
  })
})
