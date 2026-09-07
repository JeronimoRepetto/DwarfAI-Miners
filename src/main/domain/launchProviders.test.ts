import { describe, expect, it } from 'vitest'
import { DWARF_PROVIDERS, type DwarfProvider } from './types'
import {
  LAUNCHABLE_PROVIDERS,
  NOT_LAUNCHABLE,
  agentProviderList,
  type CliPresence
} from './launchProviders'

// AMENDED for #237 (was: 'claude' | 'codex'). Widened to the provider table
// itself so an observer-only identity can be handed in as a detection.
const found = (cli: DwarfProvider): CliPresence => ({ cli, installed: true })
const missing = (cli: DwarfProvider, reason: string): CliPresence => ({
  cli,
  installed: false,
  reason
})

describe('agentProviderList', () => {
  it('reports every known provider, found or not, so nothing is silently omitted', () => {
    const list = agentProviderList([found('claude'), missing('codex', 'not on PATH')])

    // AMENDED for #237 (was: ['claude', 'codex'] / [true, false]). The list is
    // ordered by DWARF_PROVIDERS, so an observer-only provider joins it the
    // moment its identity exists — reported absent here, because this call
    // handed in no detection for it.
    expect(list.providers.map((entry) => entry.provider)).toEqual([
      'claude',
      'codex',
      'antigravity'
    ])
    expect(list.providers.map((entry) => entry.installed)).toEqual([true, false, false])
  })

  it('marks a detected provider the engine can start as launchable, with no reason', () => {
    const [claude] = agentProviderList([found('claude')]).providers

    expect(claude).toEqual({ provider: 'claude', installed: true, launchable: true })
  })

  /*
   * #168 gave Codex a launch path — a detached `codex exec` in the mine's
   * folder, discovered afterwards by the poll — so the chip that used to refuse
   * now starts something. It carries no refusal reason for the same purpose the
   * Claude one carries none: there is nothing left to explain.
   */
  it('marks a detected Codex launchable now that the engine can start it', () => {
    const [, codex] = agentProviderList([found('claude'), found('codex')]).providers

    expect(codex).toEqual({ provider: 'codex', installed: true, launchable: true })
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

  it('names every provider a launch can actually be started for (#168)', () => {
    // Unchanged by #237 on purpose: Antigravity is an OBSERVER first, and a
    // name here that no launch path answers is a chip that responds to Enter
    // with a session nobody starts.
    expect([...LAUNCHABLE_PROVIDERS]).toEqual(['claude', 'codex'])
  })

  /*
   * The condition `NOT_LAUNCHABLE` was written for, finally reached (#237).
   * Its comment said nothing in the build could get there because every
   * detected provider was launchable — true until a provider arrived that this
   * app can only read. An installed Antigravity says so out loud instead of
   * offering a chip with nothing behind it.
   */
  it('refuses to start a detected provider whose launch path does not exist yet', () => {
    const [, , antigravity] = agentProviderList([found('antigravity')]).providers

    expect(antigravity).toEqual({
      provider: 'antigravity',
      installed: true,
      launchable: false,
      reason: NOT_LAUNCHABLE
    })
  })

  it('offers no refusal copy for an Antigravity nobody has installed', () => {
    // An absent CLI is not offered as a chip at all, so explaining that it
    // cannot be started would answer a question the panel is not asking.
    const [, , antigravity] = agentProviderList([missing('antigravity', 'nowhere')]).providers

    expect(antigravity?.installed).toBe(false)
    expect(antigravity?.launchable).toBe(false)
    expect(antigravity?.reason).toBeUndefined()
  })

  /*
   * The invariant that survived the widening: this list is not free to grow on
   * its own. Every name in it must be one the engine has a verified invocation
   * for, or the chip answers Enter with a session nobody starts.
   */
  it('never names a provider this build does not have', () => {
    for (const provider of LAUNCHABLE_PROVIDERS) {
      expect(DWARF_PROVIDERS).toContain(provider)
    }
  })

  it('still refuses an absent Codex, detected or not', () => {
    const [, codex] = agentProviderList([found('claude'), missing('codex', 'nowhere')]).providers

    expect(codex?.installed).toBe(false)
    expect(codex?.launchable).toBe(false)
  })
})
