import { describe, expect, it } from 'vitest'
import { withSessionPwd } from './sessionEnv'

describe('withSessionPwd', () => {
  it('sets PWD to the given cwd', () => {
    expect(withSessionPwd({}, 'C:\\mines\\a').PWD).toBe('C:\\mines\\a')
  })

  /**
   * The exact shape of #640: a shell's own PWD survives on this app's
   * inherited environment (buildRelayEnv only ever touches PATH), and
   * OpenCode's `run` reads THAT instead of the process's real cwd.
   */
  it('overrides an inherited PWD that names a different folder', () => {
    const env = withSessionPwd({ PWD: 'C:\\Users\\jero\\DwarfAI-Miners' }, 'C:\\mines\\a')
    expect(env.PWD).toBe('C:\\mines\\a')
  })

  it('keeps every other key untouched', () => {
    const env = withSessionPwd({ PATH: '/usr/bin', FOO: 'bar' }, '/mine')
    expect(env.PATH).toBe('/usr/bin')
    expect(env.FOO).toBe('bar')
  })

  /** A new object, never a mutation — this app's own process.env must survive untouched. */
  it('never mutates the env object handed in', () => {
    const original = { PWD: '/somewhere/else' }
    withSessionPwd(original, '/mine')
    expect(original.PWD).toBe('/somewhere/else')
  })
})
