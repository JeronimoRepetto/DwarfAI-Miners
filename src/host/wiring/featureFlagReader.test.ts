// L3 (17 §1.3) and L2: the Host's FeatureFlagReader over a FakeFs holding the userData config file,
// an explicit env object (never the real `process.env`) and a recording log (16 §4.12, INV-110).
import { join } from 'node:path'
import { CHANNELS, HOST_METHOD_SCHEMAS, TODAY_SHAPES } from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import { FakeFs } from '../kernel/fakes/FakeFs'
import { RecordingDiagnosticsLog } from '../kernel/fakes/RecordingDiagnosticsLog'
import { runFeatureFlagReaderContract } from '../modules/preferences/testing/featureFlagReader.contract'
import {
  FEATURE_FLAG_INVALID_EVENT,
  createFeatureFlagReader,
  featureFlagConfigFilePath
} from './featureFlagReader'

const HOST_DATA_DIR = join('fake-user-data', 'host')
const CONFIG_FILE = featureFlagConfigFilePath(HOST_DATA_DIR)

function invalidKeys(log: RecordingDiagnosticsLog): string[] {
  return log.byEvent(FEATURE_FLAG_INVALID_EVENT).map((entry) => entry.causeClass ?? '')
}

describe('createFeatureFlagReader', () => {
  runFeatureFlagReaderContract(async (layers) => {
    const fs = new FakeFs()
    if (layers.file !== null) fs.addFile(CONFIG_FILE, JSON.stringify(layers.file))
    const log = new RecordingDiagnosticsLog()
    const reader = await createFeatureFlagReader({
      env: layers.env,
      fs,
      configFilePath: CONFIG_FILE,
      log
    })
    return { reader, warnedKeys: () => invalidKeys(log) }
  })

  it('[INV-110] reads the config file UI main reads: config-v1.json in the userData folder above the Host data folder', () => {
    expect(CONFIG_FILE).toBe(join('fake-user-data', 'config-v1.json'))
  })

  it('[US-GUILD-002.AC03, INV-110] a config file or environment changed after creation changes nothing it answers', async () => {
    const fs = new FakeFs()
    fs.addFile(CONFIG_FILE, JSON.stringify({ GUILD_AREAS_ENABLED: 'true' }))
    const env: Record<string, string | undefined> = {}
    const reader = await createFeatureFlagReader({
      env,
      fs,
      configFilePath: CONFIG_FILE,
      log: new RecordingDiagnosticsLog()
    })

    fs.addFile(CONFIG_FILE, JSON.stringify({ GUILD_AREAS_ENABLED: 'false', BOOST_ENABLED: 'true' }))
    env.BOOST_ENABLED = '1'

    expect(reader.read()).toStrictEqual({ guildAreasEnabled: true, boostEnabled: false })
  })

  it('[INV-110] the warning names the key and never carries the invalid value', async () => {
    const log = new RecordingDiagnosticsLog()
    await createFeatureFlagReader({
      env: { GUILD_AREAS_ENABLED: 'secret-looking-junk' },
      fs: new FakeFs(),
      configFilePath: CONFIG_FILE,
      log
    })

    expect(log.refused).toStrictEqual([])
    expect(log.entries).toHaveLength(1)
    expect(log.entries[0]).toMatchObject({
      level: 'warn',
      event: FEATURE_FLAG_INVALID_EVENT,
      subsystem: 'preferences',
      outcome: 'degraded',
      causeClass: 'GUILD_AREAS_ENABLED'
    })
    expect(JSON.stringify(log.entries)).not.toContain('secret-looking-junk')
  })

  it('[INV-110] a flag the file holds as a JSON boolean is an invalid value: the default applies and its key is named', async () => {
    const fs = new FakeFs()
    fs.addFile(CONFIG_FILE, '{ "BOOST_ENABLED": true, "GUILD_AREAS_ENABLED": "1" }')
    const log = new RecordingDiagnosticsLog()
    const reader = await createFeatureFlagReader({ env: {}, fs, configFilePath: CONFIG_FILE, log })

    expect(reader.read()).toStrictEqual({ guildAreasEnabled: true, boostEnabled: false })
    expect(invalidKeys(log)).toStrictEqual(['BOOST_ENABLED'])
  })

  it('[INV-110] a malformed config file reads as no file, and only the flags are read from it', async () => {
    const fs = new FakeFs()
    fs.addFile(CONFIG_FILE, '{ not json')
    const log = new RecordingDiagnosticsLog()
    const malformed = await createFeatureFlagReader({
      env: { BOOST_ENABLED: 'true' },
      fs,
      configFilePath: CONFIG_FILE,
      log
    })
    expect(malformed.read()).toStrictEqual({ guildAreasEnabled: false, boostEnabled: true })

    // A bad value of another setting is UI main's to judge; the Host reads only its two flags.
    fs.addFile(
      CONFIG_FILE,
      JSON.stringify({ POLL_INTERVAL_MS: 'abc', GUILD_AREAS_ENABLED: 'true' })
    )
    const other = await createFeatureFlagReader({ env: {}, fs, configFilePath: CONFIG_FILE, log })
    expect(other.read()).toStrictEqual({ guildAreasEnabled: true, boostEnabled: false })
    expect(log.entries).toStrictEqual([])
  })
})

/**
 * Every object key and every enum or literal string a schema accepts, found by walking its zod
 * definition: whatever a caller could put in a request is in this set.
 */
function namesIn(
  schema: unknown,
  seen = new Set<unknown>(),
  names = new Set<string>()
): Set<string> {
  if (schema === null || typeof schema !== 'object' || seen.has(schema)) return names
  seen.add(schema)
  const def = (schema as { _def?: Record<string, unknown> })._def
  if (def === undefined) return names
  const shape = def.shape
  if (typeof shape === 'function') {
    for (const [key, field] of Object.entries((shape as () => Record<string, unknown>)())) {
      names.add(key)
      namesIn(field, seen, names)
    }
  }
  if (Array.isArray(def.values)) for (const value of def.values) names.add(String(value))
  if (typeof def.value === 'string') names.add(def.value)
  if (typeof def.getter === 'function') namesIn((def.getter as () => unknown)(), seen, names)
  for (const [field, value] of Object.entries(def)) {
    if (field === 'shape' || field === 'getter') continue
    const children: unknown[] =
      value instanceof Map ? [...value.values()] : Array.isArray(value) ? value : [value]
    for (const child of children) namesIn(child, seen, names)
  }
  return names
}

const FLAG_NAMES = ['guildAreasEnabled', 'boostEnabled', 'GUILD_AREAS_ENABLED', 'BOOST_ENABLED']

// 14 §8 I-07: `boostEnabled` stays Host-side; A-29 only reads `guildAreasEnabled`. This scan sits
// with the reader because a preferences application test may not import `contracts` (R3/R9 lint).
describe('the seam registries', () => {
  it('[US-GUILD-002.AC03] no seam-B method or seam-A channel writes a feature flag', () => {
    // The walk sees keys and enum values: A-29's response carries the flag it reads, and the
    // preferences setter's params name its writable keys.
    expect(namesIn(CHANNELS['app:features'].response)).toContain('guildAreasEnabled')
    expect(namesIn(HOST_METHOD_SCHEMAS['preferences.set'].params)).toContain('subagentDelegationOn')

    const requests: Array<[string, unknown]> = [
      ...Object.entries(HOST_METHOD_SCHEMAS).map(([name, s]): [string, unknown] => [
        `seam B ${name}`,
        s.params
      ]),
      ...Object.entries(CHANNELS).map(([name, s]): [string, unknown] => [
        `seam A ${name}`,
        s.request
      ]),
      ...Object.entries(TODAY_SHAPES).map(([name, s]): [string, unknown] => [
        `seam A today ${name}`,
        s.request
      ])
    ]
    expect(requests.length).toBeGreaterThan(50)

    const writers = requests.filter(([, schema]) => {
      const names = namesIn(schema)
      return FLAG_NAMES.some((flag) => names.has(flag))
    })
    expect(writers.map(([name]) => name)).toStrictEqual([])
  })
})
