import { describe, expect, it } from 'vitest'
import { defaultDwarf } from '../../testing/factories'
import { compactSilence, dwarfTip } from './dwarfTip'

describe('compactSilence', () => {
  it('writes a silence the way the design does: seconds, then minutes, then hours', () => {
    expect(compactSilence(12_000)).toBe('12s')
    expect(compactSilence(120_000)).toBe('2m')
    expect(compactSilence(41 * 60_000)).toBe('41m')
    expect(compactSilence(2 * 3_600_000)).toBe('2h')
  })

  // Never more silence than was observed (describeSilence's rule): every unit rounds down.
  it('rounds down, never claiming more silence than was observed', () => {
    expect(compactSilence(119_999)).toBe('1m')
    expect(compactSilence(3_599_999)).toBe('59m')
    expect(compactSilence(0)).toBe('0s')
    expect(compactSilence(-5)).toBe('0s')
  })
})

describe('dwarfTip', () => {
  it('says name, rank and provider, model and effort, silence and status', () => {
    const tip = dwarfTip(
      defaultDwarf({
        name: 'dwarfai-53',
        role: 'worker',
        provider: 'claude',
        model: 'opus',
        effort: 'high',
        silentForMs: 120_000,
        status: 'working'
      })
    )
    expect(tip).toEqual({
      name: 'dwarfai-53',
      rank: 'worker',
      provider: 'Claude',
      tuning: 'opus · high effort',
      silence: 'silent 2m · ',
      status: 'working',
      statusText: 'working'
    })
  })

  // RANK maps both worker ranks to "worker"; the foreman is his own (components.md, Dwarf tooltip).
  it('calls both worker ranks "worker" and the foreman "foreman"', () => {
    expect(dwarfTip(defaultDwarf({ role: 'worker2' })).rank).toBe('worker')
    expect(dwarfTip(defaultDwarf({ role: 'foreman' })).rank).toBe('foreman')
  })

  it('says "needs you" for an asking dwarf and "asleep" for a resting one', () => {
    expect(
      dwarfTip(defaultDwarf({ status: 'waiting', waitingReason: 'approval' })).statusText
    ).toBe('needs you')
    expect(dwarfTip(defaultDwarf({ status: 'waiting' })).statusText).toBe('asleep')
  })

  /*
   * An unknown fact prints nothing rather than a guess (today's tooltip, #47): no silence figure
   * where the provider keeps none, no effort where none was reported, and the model admitted
   * unknown rather than left blank.
   */
  it('leaves out what the provider does not know', () => {
    const tip = dwarfTip(
      defaultDwarf({ model: undefined, effort: undefined, silentForMs: undefined })
    )
    expect(tip.tuning).toBe('model unknown')
    expect(tip.silence).toBe('')
  })

  // The tools' own names, as people know them (copy.md, Name things); a held session is "hosted".
  it('names the provider as the tool calls itself', () => {
    expect(dwarfTip(defaultDwarf({ provider: 'codex' })).provider).toBe('Codex')
    expect(dwarfTip(defaultDwarf({ provider: 'opencode' })).provider).toBe('OpenCode')
    expect(dwarfTip(defaultDwarf({ provider: 'antigravity' })).provider).toBe('Antigravity')
    expect(dwarfTip(defaultDwarf({ provider: 'panel' })).provider).toBe('hosted')
  })

  // Claude's effort words are spelled out as today (describeEffort), in the line's lower case.
  it('spells the effort as the provider names it, lower case', () => {
    expect(dwarfTip(defaultDwarf({ provider: 'claude', effort: 'xhigh' })).tuning).toBe(
      'test-model · extra high effort'
    )
    expect(dwarfTip(defaultDwarf({ provider: 'codex', effort: 'medium' })).tuning).toBe(
      'test-model · medium effort'
    )
  })

  // Silence sits beside the status as a measurement, never inside it (today's tooltip, #47).
  it('still calls a long-silent dwarf working: silence is not a status', () => {
    const tip = dwarfTip(defaultDwarf({ status: 'working', silentForMs: 5 * 3_600_000 }))
    expect(tip.statusText).toBe('working')
    expect(tip.silence).toBe('silent 5h · ')
  })
})
