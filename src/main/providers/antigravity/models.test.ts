import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  buildAgyModelsCommand,
  createAntigravityModelCatalog,
  parseAgyModelsOutput,
  type AgyModelsCommand
} from './models'

/*
 * Issue #282. `agy models` is a live, on-demand CLI answer — a different
 * subject from the PRIVATE on-disk transcript/history store `parse.test.ts`
 * covers, so it gets its own fixture (__fixtures__/antigravity/models.txt)
 * rather than reusing that one. Captured verbatim off Antigravity CLI 1.1.26,
 * 2026-09-07: a status line with no tab, then one `<id>\t<display name>` line
 * per model. The parser's job is the same discipline as the transcript one:
 * degrade to nothing readable rather than throw or half-parse.
 */

const FIXTURES = join(import.meta.dirname, '..', '__fixtures__', 'antigravity')
const modelsOutput = readFileSync(join(FIXTURES, 'models.txt'), 'utf8')

describe('parseAgyModelsOutput', () => {
  it("reads every model line off the CLI's own captured output", () => {
    const models = parseAgyModelsOutput(modelsOutput)
    expect(models).not.toBeNull()
    expect(models).toHaveLength(14)
    expect(models![0]).toEqual({
      value: 'gemini-3.8-flash-high',
      displayName: 'Gemini 3.8 Flash (High)'
    })
    expect(models![13]).toEqual({
      value: 'gpt-oss-120b-medium',
      displayName: 'GPT-OSS 120B (Medium)'
    })
  })

  it('skips the leading status line, which carries no tab', () => {
    const models = parseAgyModelsOutput(modelsOutput)
    expect(models!.some((model) => model.value.includes('Fetching'))).toBe(false)
  })

  /*
   * Never a hard-coded list, and never a half-parse: an answer this format
   * cannot be read as at all becomes null, which the port turns into a
   * refusal the caller (runtime.ts's listAgentModels) already knows how to
   * fall back to `none` from — see the port's own tests below.
   */
  it('answers null for garbage that names no model line at all', () => {
    expect(parseAgyModelsOutput('agy: command not found\n')).toBeNull()
    expect(parseAgyModelsOutput('')).toBeNull()
    expect(parseAgyModelsOutput('   \n  \n')).toBeNull()
  })

  it('keeps the valid lines of an otherwise-garbled answer, rather than refusing all of it', () => {
    // A half-written final line is the same bounded-read race parse.ts's own
    // transcript reader already tolerates.
    const half = 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.7-flash-hi'
    expect(parseAgyModelsOutput(half)).toEqual([
      { value: 'gemini-3.8-flash-high', displayName: 'Gemini 3.8 Flash (High)' }
    ])
  })

  it('trims CRLF line endings off the display name', () => {
    const crlf = 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\r\n'
    expect(parseAgyModelsOutput(crlf)).toEqual([
      { value: 'gemini-3.8-flash-high', displayName: 'Gemini 3.8 Flash (High)' }
    ])
  })

  it('drops a line whose id half is blank', () => {
    expect(parseAgyModelsOutput('\tNo id at all\n')).toBeNull()
  })
})

describe('buildAgyModelsCommand', () => {
  /*
   * The DETECTED path, never a bare 'agy' — the same rule every other spawn
   * off cliDetection.ts's verdict follows (a third-party shim on PATH can
   * answer a bare name wrongly).
   */
  it('spawns the exact detected binary with the models subcommand, never a bare name', () => {
    expect(buildAgyModelsCommand('/home/j/.local/bin/agy')).toEqual({
      command: '/home/j/.local/bin/agy',
      args: ['models']
    })
  })

  it('never goes through a shell: the path is the command, not part of a string', () => {
    const command = buildAgyModelsCommand('C:\\Users\\j\\AppData\\Local\\agy\\bin\\agy.exe')
    expect(command.command).toBe('C:\\Users\\j\\AppData\\Local\\agy\\bin\\agy.exe')
    expect(command.args).toEqual(['models'])
  })
})

describe('createAntigravityModelCatalog (#282)', () => {
  it("asks the detected binary and parses its stdout into the domain's shape", async () => {
    const run = vi
      .fn<(command: AgyModelsCommand) => Promise<string>>()
      .mockResolvedValue(modelsOutput)
    const port = createAntigravityModelCatalog({ run })

    const models = await port({ executablePath: '/home/j/.local/bin/agy' })

    expect(run).toHaveBeenCalledWith({ command: '/home/j/.local/bin/agy', args: ['models'] })
    expect(models).toHaveLength(14)
    expect(models[0]).toEqual({
      value: 'gemini-3.8-flash-high',
      displayName: 'Gemini 3.8 Flash (High)'
    })
  })

  /*
   * A failed OR unparseable run both take the same one path to the caller's
   * own fallback — see runtime.ts's listAgentModels, which already catches a
   * throw from Claude's port the same way and answers `source: 'none'` with
   * one warn line. Keeping the two failure kinds on one path here is what
   * makes that a single branch there rather than two.
   */
  it('rejects when the spawn itself fails, so the caller can fall back to none', async () => {
    const run = vi
      .fn<(command: AgyModelsCommand) => Promise<string>>()
      .mockRejectedValue(new Error('ENOENT'))
    const port = createAntigravityModelCatalog({ run })

    await expect(port({ executablePath: '/home/j/.local/bin/agy' })).rejects.toThrow('ENOENT')
  })

  it('rejects when the output cannot be read as a model list, on the same terms as a spawn failure', async () => {
    const run = vi
      .fn<(command: AgyModelsCommand) => Promise<string>>()
      .mockResolvedValue('not a model list')
    const port = createAntigravityModelCatalog({ run })

    await expect(port({ executablePath: '/home/j/.local/bin/agy' })).rejects.toThrow()
  })
})
