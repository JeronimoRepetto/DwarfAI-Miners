import { describe, expect, it, vi } from 'vitest'
import { FakeFs } from '../../adapters/fakeFs'
import {
  buildOpenCodeModelsCommand,
  createOpenCodeModelCatalog,
  parseOpenCodeModelsOutput,
  type OpenCodeModelsCommand
} from './models'

/*
 * Issue #534. `opencode models --verbose` is a live, on-demand CLI answer —
 * measured 2026-09-21 (M1, the measurement report this task's writer was
 * handed, since folded into docs/opencode-format.md): one bare
 * `provider/model` id line, then a `{ ... }` JSON object, repeated per model,
 * with the same key set on every block (`id, providerID, name, family, api,
 * status, headers, options, cost, limit, capabilities, release_date,
 * variants`).
 *
 * This fixture is a REPRESENTATIVE reconstruction built from M1's own
 * documented key set and its two verbatim `variants` examples — never a
 * literal captured file the way `__fixtures__/antigravity/models.txt` is,
 * because the measurement report quotes the shape and two snippets rather
 * than a full 34-model dump. `opencode-go/glm-5.3`'s `variants` map below is
 * M1's own example, byte for byte; `opencode/big-pickle`'s empty `variants:
 * {}` is the model M1 names as the variant-less case, on this run's real
 * machine.
 */
const MODELS_VERBOSE = [
  'opencode-go/glm-5.3',
  '{',
  '  "id": "glm-5.3",',
  '  "providerID": "opencode-go",',
  '  "name": "GLM 5.3",',
  '  "family": "glm",',
  '  "api": "https://api.opencode-go.example/v1",',
  '  "status": "active",',
  '  "headers": {},',
  '  "options": {},',
  '  "cost": { "input": 0, "output": 0, "cache": { "read": 0, "write": 0 } },',
  '  "limit": { "context": 200000, "output": 8192 },',
  '  "capabilities": { "reasoning": true },',
  '  "release_date": "2026-01-01",',
  '  "variants": {',
  '    "low":  { "reasoningEffort": "low" },',
  '    "high": { "reasoningEffort": "high" },',
  '    "max":  { "reasoningEffort": "max" }',
  '  }',
  '}',
  'opencode/big-pickle',
  '{',
  '  "id": "big-pickle",',
  '  "providerID": "opencode",',
  '  "name": "Big Pickle",',
  '  "family": "pickle",',
  '  "api": "https://api.opencode.example/v1",',
  '  "status": "active",',
  '  "headers": {},',
  '  "options": {},',
  '  "cost": { "input": 0, "output": 0, "cache": { "read": 0, "write": 0 } },',
  '  "limit": { "context": 128000, "output": 4096 },',
  '  "capabilities": { "reasoning": true },',
  '  "release_date": "2026-02-01",',
  '  "variants": {}',
  '}',
  ''
].join('\n')

/** npm's cmd-shim for opencode, in the same shape `launchRunner.test.ts`'s Codex fixture is. */
const SHIM_DIR = 'C:\\Users\\x\\AppData\\Roaming\\npm'
const SHIM_PATH = `${SHIM_DIR}\\opencode.cmd`
const SHIM_ENTRY = `${SHIM_DIR}\\node_modules\\opencode-ai\\bin\\opencode.js`
const SHIM_TEXT = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\opencode-ai\\bin\\opencode.js" %*'
].join('\r\n')

/*
 * AMENDED for #547 (was: `{value, displayName, effortLevels}` only — the
 * three fields `ModelOption` needs). The parser now keeps the richer
 * `OpenCodeCatalogueModel` shape a Jev capability entry needs too
 * (`opencodeDerived.ts`): `status`, `releaseDate`, `cost`, `limit`,
 * `capabilities.reasoning`, read straight off the same fixture block above,
 * which already carried them (the fixture's own comment already advertised
 * this key set — #547 is the first thing that reads past the first three).
 */
describe('parseOpenCodeModelsOutput', () => {
  it('reads a model with a non-empty variants map, keyed by its own effort levels (M1)', () => {
    const models = parseOpenCodeModelsOutput(MODELS_VERBOSE)
    expect(models[0]).toEqual({
      value: 'opencode-go/glm-5.3',
      displayName: 'GLM 5.3',
      effortLevels: ['low', 'high', 'max'],
      status: 'active',
      releaseDate: '2026-01-01',
      cost: { input: 0, output: 0, cacheRead: 0 },
      limit: { context: 200000, output: 8192 },
      capabilities: { reasoning: true }
    })
  })

  it('reads a model with an empty variants map as no effort levels at all', () => {
    const models = parseOpenCodeModelsOutput(MODELS_VERBOSE)
    expect(models[1]).toEqual({
      value: 'opencode/big-pickle',
      displayName: 'Big Pickle',
      effortLevels: [],
      status: 'active',
      releaseDate: '2026-02-01',
      cost: { input: 0, output: 0, cacheRead: 0 },
      limit: { context: 128000, output: 4096 },
      capabilities: { reasoning: true }
    })
  })

  it('reads cost.output above zero and no cache figure as an omitted cacheRead (#547)', () => {
    const paid = [
      'opencode-go/paid-model',
      '{',
      '  "id": "paid-model",',
      '  "providerID": "opencode-go",',
      '  "name": "Paid Model",',
      '  "status": "active",',
      '  "cost": { "input": 3, "output": 15 },',
      '  "limit": { "context": 1048576, "output": 131072 },',
      '  "capabilities": { "reasoning": true },',
      '  "release_date": "2026-07-16",',
      '  "variants": { "max": { "reasoningEffort": "max" } }',
      '}',
      ''
    ].join('\n')
    const [model] = parseOpenCodeModelsOutput(paid)
    expect(model).toEqual({
      value: 'opencode-go/paid-model',
      displayName: 'Paid Model',
      effortLevels: ['max'],
      status: 'active',
      releaseDate: '2026-07-16',
      cost: { input: 3, output: 15 },
      limit: { context: 1048576, output: 131072 },
      capabilities: { reasoning: true }
    })
    expect(model).not.toHaveProperty('cost.cacheRead')
  })

  it('reads every model line off the output', () => {
    expect(parseOpenCodeModelsOutput(MODELS_VERBOSE)).toHaveLength(2)
  })

  /*
   * Unlike Antigravity's parseAgyModelsOutput (returns null for its own
   * caller to fold into a refusal), this parser throws directly — the task's
   * own instruction, and consistent because a JSON block this cannot read is
   * evidence of a format change or an error message printed instead of the
   * list, never "this provider honestly has zero models".
   */
  it('throws for output naming no id line at all', () => {
    expect(() => parseOpenCodeModelsOutput('opencode: command not found\n')).toThrow()
    expect(() => parseOpenCodeModelsOutput('')).toThrow()
    expect(() => parseOpenCodeModelsOutput('   \n  \n')).toThrow()
  })

  it('throws when an id line is not followed by a JSON block at all', () => {
    expect(() => parseOpenCodeModelsOutput('opencode/big-pickle\n')).toThrow()
  })

  it('throws on an unbalanced JSON block, rather than half-parsing it', () => {
    const broken = 'opencode/big-pickle\n{\n  "id": "big-pickle"\n'
    expect(() => parseOpenCodeModelsOutput(broken)).toThrow()
  })

  it('throws on a block that brace-matches but is not valid JSON', () => {
    const broken = 'opencode/big-pickle\n{ this is not json }\n'
    expect(() => parseOpenCodeModelsOutput(broken)).toThrow()
  })
})

describe('buildOpenCodeModelsCommand', () => {
  it('appends models --verbose to whatever resolveProgram already resolved (POSIX shape)', () => {
    expect(
      buildOpenCodeModelsCommand({ command: '/home/j/.local/bin/opencode', args: [] })
    ).toEqual({
      command: '/home/j/.local/bin/opencode',
      args: ['models', '--verbose']
    })
  })

  it("carries a shim's node-entry argv ahead of the subcommand, on win32", () => {
    expect(buildOpenCodeModelsCommand({ command: 'node', args: [SHIM_ENTRY] })).toEqual({
      command: 'node',
      args: [SHIM_ENTRY, 'models', '--verbose']
    })
  })
})

describe('createOpenCodeModelCatalog (#534)', () => {
  it('asks the bare detected path directly on POSIX, no shim to read', async () => {
    const run = vi
      .fn<(command: OpenCodeModelsCommand) => Promise<string>>()
      .mockResolvedValue(MODELS_VERBOSE)
    const port = createOpenCodeModelCatalog({ fs: new FakeFs(), run })

    const models = await port({ executablePath: '/home/j/.local/bin/opencode' })

    expect(run).toHaveBeenCalledWith({
      command: '/home/j/.local/bin/opencode',
      args: ['models', '--verbose']
    })
    expect(models).toHaveLength(2)
    // AMENDED for #547 (was: {value, displayName, effortLevels} only) — see
    // parseOpenCodeModelsOutput's own AMENDED note above for why.
    expect(models[0]).toEqual({
      value: 'opencode-go/glm-5.3',
      displayName: 'GLM 5.3',
      effortLevels: ['low', 'high', 'max'],
      status: 'active',
      releaseDate: '2026-01-01',
      cost: { input: 0, output: 0, cacheRead: 0 },
      limit: { context: 200000, output: 8192 },
      capabilities: { reasoning: true }
    })
  })

  it('reads a win32 npm shim through its own node entry, never a bare .cmd', async () => {
    const fs = new FakeFs()
    fs.addFile(SHIM_PATH, SHIM_TEXT)
    const run = vi
      .fn<(command: OpenCodeModelsCommand) => Promise<string>>()
      .mockResolvedValue(MODELS_VERBOSE)
    const port = createOpenCodeModelCatalog({ fs, run })

    await port({ executablePath: SHIM_PATH })

    expect(run).toHaveBeenCalledWith({
      command: 'node',
      args: [SHIM_ENTRY, 'models', '--verbose']
    })
  })

  it('rejects when the spawn itself fails, so the caller can fall back to none', async () => {
    const run = vi
      .fn<(command: OpenCodeModelsCommand) => Promise<string>>()
      .mockRejectedValue(new Error('ENOENT'))
    const port = createOpenCodeModelCatalog({ fs: new FakeFs(), run })

    await expect(port({ executablePath: '/home/j/.local/bin/opencode' })).rejects.toThrow('ENOENT')
  })

  it('rejects when the output cannot be read as a model list, on the same terms as a spawn failure', async () => {
    const run = vi
      .fn<(command: OpenCodeModelsCommand) => Promise<string>>()
      .mockResolvedValue('not a model list')
    const port = createOpenCodeModelCatalog({ fs: new FakeFs(), run })

    await expect(port({ executablePath: '/home/j/.local/bin/opencode' })).rejects.toThrow()
  })

  it('rejects when the detected binary is a shim this build cannot read', async () => {
    const fs = new FakeFs()
    fs.addFile(SHIM_PATH, '@echo off\r\nrem nothing to run here\r\n')
    const run = vi.fn<(command: OpenCodeModelsCommand) => Promise<string>>()
    const port = createOpenCodeModelCatalog({ fs, run })

    await expect(port({ executablePath: SHIM_PATH })).rejects.toThrow()
    expect(run).not.toHaveBeenCalled()
  })
})
