// layer: L7
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { extractTraceability } from './extract.mjs'

/**
 * The traceability extractor (17 §3.2) over the small repository tree in
 * `__fixtures__/repo/`: test files under `src/`, `scripts/`, `e2e/` and `spikes/`, a file that is
 * not a test, a test file under a `__fixtures__/` folder, and a test file that throws at import.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureRoot = path.join(here, '__fixtures__', 'repo')
const extractorPath = path.join(here, 'extract.mjs')

const SEND_MESSAGE = 'src/host/modules/conversation/application/sendMessage.test.ts'
const DELIVERED =
  '[US-MSG-001.AC03, NFR-TIM-05] marks the message delivered when the channel accepts it'
const NO_RETRY = "[ BR-17 ,US-MSG-003.AC01 ] doesn't retry on its own"
const SECOND_MARK = '[US-MSG-001.AC04] shows the second mark when the dwarf acts'
const PROCESS_CONTROL = 'src/host/platform/process/processControl.os.test.ts'
const TREE_KILL = '[ADR-014, FM-001, CH-01] ends the child and the grandchild'
const THROWS_AT_IMPORT = 'src/renderer/src/lib/throwsAtImport.test.ts'
const SP_02 = 'spikes/SP-02/hostSurvivesJob.os.test.ts'
const HOST_SURVIVES = '[SP-02, ADR-002] the Host survives the end of the UI job'
const S_030_1 = 'spikes/S-030-1/caseFolding.os.test.ts'

const entry = (file, title, layer) => ({ file, title, layer })

/** The whole expected mapping of the fixture tree, written by hand from 17 §2.2 and §3.2. */
const EXPECTED = {
  'ADR-002': [entry(SP_02, HOST_SURVIVES, 'L8')],
  'ADR-005': [
    entry(
      'src/host/kernel/ports/fileSystem.contract.ts',
      '[ADR-005] reads back what it wrote',
      'L3'
    )
  ],
  'ADR-014': [entry(PROCESS_CONTROL, TREE_KILL, 'L8')],
  'BR-17': [entry(SEND_MESSAGE, NO_RETRY, 'L2')],
  'C-05': [
    entry(
      'src/host/modules/suppliers/adapters/drivers/claude-stream-json.conformance.test.ts',
      '[C-05] ends the turn once',
      'L4'
    )
  ],
  'CH-01': [entry(PROCESS_CONTROL, TREE_KILL, 'L8')],
  'FM-001': [entry(PROCESS_CONTROL, TREE_KILL, 'L8')],
  'INV-01': [
    entry(
      'src/host/modules/mines/domain/mine.test.ts',
      '[INV-01] gives a new mine a surrogate id',
      'L1'
    )
  ],
  'INV-02': [
    entry(
      'src/host/platform/sqlite/schema.contract.test.ts',
      '[INV-02] rejects a second mine for the same folder',
      'L5'
    )
  ],
  'NFR-A11Y-06': [
    entry(
      'src/renderer/src/lib/keyboardMap.test.ts',
      '[NFR-A11Y-06] maps every key of the Panel',
      'L12'
    )
  ],
  'NFR-TIM-05': [entry(SEND_MESSAGE, DELIVERED, 'L2')],
  R1: [
    entry('scripts/tools/layered.test.ts', '[R1] reads its layer from the comment at the top', 'L7')
  ],
  R12: [
    entry(
      'src/renderer/src/lib/untagged.test.ts',
      '[R12] has no layer from its path, and its layer comment is not at the top',
      null
    )
  ],
  'S-030-1': [entry(S_030_1, '[S-030-1] detects a case-insensitive volume', 'L8')],
  'SP-02': [entry(SP_02, HOST_SURVIVES, 'L8')],
  'US-LAUNCH-005.AC01': [
    entry('e2e/launch/launch.e2e.ts', '[US-LAUNCH-005.AC01] sends the dwarf in', 'L9')
  ],
  'US-MSG-001.AC03': [entry(SEND_MESSAGE, DELIVERED, 'L2')],
  'US-MSG-001.AC04': [entry(SEND_MESSAGE, SECOND_MARK, 'L2')],
  'US-MSG-003.AC01': [entry(SEND_MESSAGE, NO_RETRY, 'L2')],
  'US-OBS-001.AC01': [entry(THROWS_AT_IMPORT, '[US-OBS-001.AC01] is still read', null)]
}

let tempRoots = []

afterEach(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true })
  tempRoots = []
})

/** Every mapped entry, flattened, as `file › title` lines. */
const mappedTitles = (map) =>
  Object.values(map)
    .flat()
    .map(({ file, title }) => `${file} › ${title}`)

describe('traceability extractor (17 §3.2)', () => {
  it('[ADR-001] the extractor maps every bracket id of every it and test title to its file, title and layer', () => {
    const outDir = mkdtempSync(path.join(tmpdir(), 'trace-extract-'))
    tempRoots.push(outDir)
    const out = path.join(outDir, 'traceability.json')

    const run = spawnSync(process.execPath, [extractorPath, '--root', fixtureRoot, '--out', out], {
      encoding: 'utf8'
    })

    expect(run.status, run.stderr).toBe(0)
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(EXPECTED)
  })

  it('[ADR-001] the extractor never executes a test file', () => {
    const map = extractTraceability(fixtureRoot)

    expect(map['US-OBS-001.AC01']).toEqual([
      entry(THROWS_AT_IMPORT, '[US-OBS-001.AC01] is still read', null)
    ])
  })

  it('[ADR-001] ids are split on commas and trimmed; titles without brackets map nothing', () => {
    const map = extractTraceability(fixtureRoot)

    expect(map['BR-17']).toEqual([entry(SEND_MESSAGE, NO_RETRY, 'L2')])
    expect(map['US-MSG-003.AC01']).toEqual([entry(SEND_MESSAGE, NO_RETRY, 'L2')])
    expect(Object.keys(map).filter((id) => id !== id.trim() || id === '')).toEqual([])
    expect(mappedTitles(map)).not.toContain(`${SEND_MESSAGE} › keeps the draft when the send fails`)
    // Neither a file that is not a test file nor test data under __fixtures__/ is read.
    expect(map['US-OBS-001.AC02']).toBeUndefined()
    expect(map['INV-20']).toBeUndefined()
  })

  it("[ADR-001] the layer comes from the path and suffix, else from the file's layer comment", () => {
    const layers = Object.fromEntries(
      Object.values(extractTraceability(fixtureRoot))
        .flat()
        .map(({ file, layer }) => [file, layer])
    )

    expect(layers).toEqual({
      'e2e/launch/launch.e2e.ts': 'L9',
      'scripts/tools/layered.test.ts': 'L7',
      [S_030_1]: 'L8',
      [SP_02]: 'L8',
      'src/host/kernel/ports/fileSystem.contract.ts': 'L3',
      [SEND_MESSAGE]: 'L2',
      'src/host/modules/mines/domain/mine.test.ts': 'L1',
      'src/host/modules/suppliers/adapters/drivers/claude-stream-json.conformance.test.ts': 'L4',
      [PROCESS_CONTROL]: 'L8',
      'src/host/platform/sqlite/schema.contract.test.ts': 'L5',
      'src/renderer/src/lib/keyboardMap.test.ts': 'L12',
      [THROWS_AT_IMPORT]: null,
      'src/renderer/src/lib/untagged.test.ts': null
    })
  })

  it('[ADR-001] a titled test under spikes/ is extracted with its SP- or S- id and layer L8', () => {
    const map = extractTraceability(fixtureRoot)

    expect(map['SP-02']).toEqual([entry(SP_02, HOST_SURVIVES, 'L8')])
    expect(map['S-030-1']).toEqual([
      entry(S_030_1, '[S-030-1] detects a case-insensitive volume', 'L8')
    ])
  })
})
