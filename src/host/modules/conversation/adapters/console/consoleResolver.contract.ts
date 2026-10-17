// `runConsoleResolverContract` (16 §4.6 table: `ConsoleResolver`, contract "no secret in args";
// 17 §1.3): the one suite `HostConsoleResolver` and `FakeConsoleResolver` both pass.
import { describe, expect, it } from 'vitest'
import type { DwarfId } from '../../../../kernel/domain/values'
import type { ConsoleResolver, ConsoleTarget } from '../../ports/consoleResolver'

export interface ConsoleResolverHarness {
  resolver: ConsoleResolver
  /** A dwarf DwarfAI launched. */
  launched: DwarfId
  /** An observed dwarf whose provider process identity was recorded. */
  observed: DwarfId
  /** An observed dwarf with no process identity. */
  observedNoProcess: DwarfId
  /** A dwarf the Host does not know. */
  unknown: DwarfId
  /** The process the observed dwarf's target must focus. */
  observedProcess: { pid: number; startTime: number }
  /** Every secret the resolver issued so far (per-view tokens): none may appear in a target. */
  secrets(): readonly string[]
}

const MODES: readonly ConsoleTarget['mode'][] = ['focus-terminal', 'attach', 'log']
const HEX_TOKEN = /[0-9a-f]{64}/i

export function runConsoleResolverContract(
  name: string,
  make: () => Promise<ConsoleResolverHarness> | ConsoleResolverHarness
): void {
  describe(`ConsoleResolver contract: ${name}`, () => {
    it('[ADR-031] every dwarf resolves to a console target, log at worst', async () => {
      const h = await make()
      for (const dwarfId of [h.launched, h.observed, h.observedNoProcess, h.unknown]) {
        const target = await h.resolver.targetFor(dwarfId)
        expect(MODES).toContain(target.mode)
        expect(target.command).toBeDefined()
        expect(target.credentialFile).toBeDefined()
      }
    })

    it('[ADR-031, S-031-1, S-031-3] a launched dwarf resolves to the log view, never attach', async () => {
      const h = await make()
      const target = await h.resolver.targetFor(h.launched)
      expect(target.mode).toBe('log')
      expect(target.focus).toBeUndefined()
    })

    it('[ADR-031] an observed dwarf resolves to focus-terminal with its process, log as fallback', async () => {
      const h = await make()
      const target = await h.resolver.targetFor(h.observed)
      expect(target.mode).toBe('focus-terminal')
      expect(target.focus).toEqual(h.observedProcess)
      expect(target.command?.args.at(-1)).toBe(target.credentialFile)
      expect((await h.resolver.targetFor(h.observedNoProcess)).mode).toBe('log')
    })

    it('[ADR-017, ADR-003] no target carries a token or secret in args, only the token file path', async () => {
      const h = await make()
      const targets = await Promise.all(
        [h.launched, h.observed, h.observedNoProcess, h.unknown].map((d) => h.resolver.targetFor(d))
      )
      const secrets = h.secrets()
      expect(secrets.length).toBeGreaterThan(0)
      for (const target of targets) {
        const args = target.command?.args ?? []
        expect(args).toHaveLength(2)
        expect(args[1]).toBe(target.credentialFile)
        const carried = [target.command?.program ?? '', target.command?.cwd ?? '', ...args]
        for (const value of [...carried, target.credentialFile ?? '']) {
          expect(value).not.toMatch(HEX_TOKEN)
          for (const secret of secrets) expect(value.includes(secret)).toBe(false)
        }
      }
    })
  })
}
