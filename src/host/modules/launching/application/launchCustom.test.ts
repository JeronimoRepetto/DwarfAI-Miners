// layer: L1
// The "Other…" launch's own steps (ISSUE-165; ADR-020 item 3; 18 C-17): the typed command parsed
// with no shell into the argv the driver gets, or refused with the parser's sentence as detail and
// no argv at all; and the install whose program is the argv's first element. TC-165-02 (refusals
// spawn nothing; the flow half is wiring/flows/launchOther.test.ts).
import { describe, expect, it } from 'vitest'
import type { ProviderId } from '../../../kernel/domain/values'
import { SHELL_METACHARACTER_REFUSAL, SHIM_REFUSAL } from '../domain/hostedCommand'
import { checkCustomCommand, customInstall } from './launchCustom'

const OTHER = 'other' as ProviderId

describe('launchCustom steps', () => {
  it('[US-OBS-007.AC05, NFR-SEC-09] a valid command keeps what was typed and the argv as an array, quotes grouped and nothing expanded', () => {
    expect(checkCustomCommand('my-agent --dir "C:\\two words" *')).toEqual({
      ok: true,
      command: {
        raw: 'my-agent --dir "C:\\two words" *',
        argv: ['my-agent', '--dir', 'C:\\two words', '*']
      }
    })
  })

  it('[US-OBS-007.AC05, S5.17] a refused command keeps no argv and carries the parser sentence as detail', () => {
    expect(checkCustomCommand('my-agent | tee log.txt')).toEqual({
      ok: false,
      command: { raw: 'my-agent | tee log.txt', argv: [] },
      detail: SHELL_METACHARACTER_REFUSAL
    })
    expect(checkCustomCommand('C:\\tools\\agent.cmd')).toMatchObject({
      ok: false,
      detail: SHIM_REFUSAL
    })
  })

  it('[ADR-008, US-OBS-007.AC05] the install of a custom launch is its own program, with no detected version', () => {
    expect(customInstall(OTHER, ['/opt/agent/bin/agent', '--once'])).toEqual({
      providerId: OTHER,
      binaryPath: '/opt/agent/bin/agent',
      version: null,
      resolvedVia: 'path',
      statMtimeMs: 0
    })
  })
})
