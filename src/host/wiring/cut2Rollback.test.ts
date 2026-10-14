// layer: L2
// The cut-2 rollback choices (ISSUE-141, lead decision 2026-10-14; 21 §2 cut 2 row "Rollback", §1 items 4 and 8): a
// cut-2 rollback build withdraws A-N31 and A-N32 and composes today's Claude hook installer again, so its Host never
// offers the first-run step (which could not be answered there) and never writes the Claude hook entry.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { RecordingDiagnosticsLog } from '../kernel/fakes/RecordingDiagnosticsLog'
import type { ChannelToken, ExternalConfigWriter } from '../modules/preferences'
import { cut2RollbackChoices } from './cut2Rollback'

const installed = { installed: () => ['claude-hooks' as const] }

function recordingWriter() {
  const calls: string[] = []
  const writer: ExternalConfigWriter = {
    install: (target) => {
      calls.push(`install ${target}`)
      return Promise.resolve({ ok: true, value: { verified: true, backupPath: null } })
    },
    verify: (target) => {
      calls.push(`verify ${target}`)
      return Promise.resolve('absent')
    },
    revert: (target) => {
      calls.push(`revert ${target}`)
      return Promise.resolve({ ok: true, value: undefined })
    },
    findLegacy: (target) => {
      calls.push(`findLegacy ${target}`)
      return Promise.resolve(false)
    }
  }
  return { writer, calls }
}

const TOKEN = 'token' as ChannelToken

describe('the cut-2 rollback choices (ISSUE-141)', () => {
  it('[US-SET-012.AC08, ADR-016] a rollback build offers no first-run option, so the step is not due', () => {
    expect(cut2RollbackChoices(true).installedTools(installed).installed()).toEqual([])
  })

  it('[ADR-016] a rollback build refuses every install, so the Host writes no Claude hook entry, and logs why', async () => {
    const { writer, calls } = recordingWriter()
    const log = new RecordingDiagnosticsLog()
    const result = await cut2RollbackChoices(true)
      .externalConfig(writer, log)
      .install('claude-hooks', TOKEN, 'settings', 'ab')
    expect(result).toEqual({ ok: false, error: 'io' })
    expect(calls).toEqual([])
    expect(log.byEvent('config.write')).toMatchObject([
      { subsystem: 'claude-hooks', outcome: 'failed', causeClass: 'cut-2-rollback' }
    ])
  })

  it('[ADR-016] a rollback build still verifies, reverts and probes, which write no entry', async () => {
    const { writer, calls } = recordingWriter()
    const chosen = cut2RollbackChoices(true).externalConfig(writer, new RecordingDiagnosticsLog())
    await chosen.verify('claude-hooks')
    await chosen.revert('claude-hooks')
    await chosen.findLegacy('claude-hooks')
    expect(calls).toEqual(['verify claude-hooks', 'revert claude-hooks', 'findLegacy claude-hooks'])
  })

  // ADDED for ISSUE-141 (verifier finding, 2026-10-14): the old app's entry is today's installer's in a rollback build,
  // so the Host's revert and boot settlement must not remove it (ClaudeHooksConfigWriter `keepOldAppEntries`).
  it('[ADR-016] a rollback build keeps the old app entries out of the Host reach, a normal build does not', () => {
    expect(cut2RollbackChoices(true).keepsOldAppEntries).toBe(true)
    expect(cut2RollbackChoices(false).keepsOldAppEntries).toBe(false)
  })

  it('[US-SET-012.AC01] a normal build keeps the installed tools and the writer as they are', async () => {
    const { writer, calls } = recordingWriter()
    const choices = cut2RollbackChoices(false)
    expect(choices.installedTools(installed).installed()).toEqual(['claude-hooks'])
    await choices
      .externalConfig(writer, new RecordingDiagnosticsLog())
      .install('claude-hooks', TOKEN, 'settings', 'ab')
    expect(calls).toEqual(['install claude-hooks'])
  })
})

const HOST = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Every production `.ts` file under `src/host`, tests and test-only folders excluded. */
function productionFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name)
    if (entry.isDirectory()) {
      return ['fakes', 'testing'].includes(entry.name) ? [] : productionFiles(path)
    }
    return entry.name.endsWith('.ts') && !/\.(test|contract|os\.test)\.ts$/.test(entry.name)
      ? [path]
      : []
  })
}

describe('the cut-2 rollback setting in the Host (ISSUE-141)', () => {
  it('[ADR-016] only host/wiring/cut2Rollback.ts reads the cut-2 rollback setting inside the Host', () => {
    const readers = productionFiles(HOST)
      .filter((path) => /CUT_2_ROLLBACK\b/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(HOST, path).split('\\').join('/'))
    expect(readers).toEqual(['wiring/cut2Rollback.ts'])
  })

  it('[ADR-016] host/main.ts takes the first-run installed tools and the config writer through the cut-2 choices', () => {
    const main = readFileSync(join(HOST, 'main.ts'), 'utf8')
    expect(main).toContain('installedTools: CUT_2_ROLLBACK_CHOICES.installedTools(')
    expect(main).toContain('externalConfig: CUT_2_ROLLBACK_CHOICES.externalConfig(')
    expect(main).toContain('keepOldAppEntries: CUT_2_ROLLBACK_CHOICES.keepsOldAppEntries')
  })
})
