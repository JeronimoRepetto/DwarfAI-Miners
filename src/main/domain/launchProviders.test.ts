import { describe, expect, it } from 'vitest'
import {
  LAUNCHABLE_PROVIDERS,
  NOT_LAUNCHABLE,
  agentProviderList,
  type CliPresence
} from './launchProviders'

const found = (cli: 'claude' | 'codex'): CliPresence => ({ cli, installed: true })
const missing = (cli: 'claude' | 'codex', reason: string): CliPresence => ({
  cli,
  installed: false,
  reason
})

describe('agentProviderList', () => {
  it('reports every known provider, found or not, so nothing is silently omitted', () => {
    const list = agentProviderList([found('claude'), missing('codex', 'not on PATH')])

    expect(list.providers.map((entry) => entry.provider)).toEqual(['claude', 'codex'])
    expect(list.providers.map((entry) => entry.installed)).toEqual([true, false])
  })

  it('marks a detected provider the engine can start as launchable, with no reason', () => {
    const [claude] = agentProviderList([found('claude')]).providers

    expect(claude).toEqual({ provider: 'claude', installed: true, launchable: true })
  })

  it('states why a detected provider the engine cannot start yet is refused', () => {
    const [, codex] = agentProviderList([found('claude'), found('codex')]).providers

    expect(codex?.launchable).toBe(false)
    expect(codex?.reason).toBe(NOT_LAUNCHABLE)
  })

  it('never calls an absent CLI launchable, even one the engine drives', () => {
    const [claude] = agentProviderList([missing('claude', 'nowhere')]).providers

    expect(claude?.installed).toBe(false)
    expect(claude?.launchable).toBe(false)
  })

  /*
   * The detector's own reasons name install locations — `~/.local/bin`, and a
   * configured override verbatim. Those are this machine's filesystem, and the
   * wire is where they must stop (docs/privacy.md, #59). What crosses is this
   * app's own fixed refusal copy and nothing read off a disk.
   */
  it('never carries a detection reason across the wire', () => {
    const list = agentProviderList([
      missing('claude', 'configured path not found: /home/someone/bin/claude')
    ])

    expect(JSON.stringify(list)).not.toContain('/home/someone')
    expect(list.providers[0]?.reason).toBeUndefined()
  })

  it('keeps a stable provider order, so chips do not reshuffle between polls', () => {
    const forwards = agentProviderList([found('claude'), found('codex')])
    const backwards = agentProviderList([found('codex'), found('claude')])

    expect(backwards).toEqual(forwards)
  })

  it('names Claude as the only provider a launch can be started for today', () => {
    expect([...LAUNCHABLE_PROVIDERS]).toEqual(['claude'])
  })
})
