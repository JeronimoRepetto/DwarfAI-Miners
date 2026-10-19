// The FeatureFlagReader conformance suite (16 §4.12 "precedence env → file → default"; 17 §1.3):
// run on `FakeFeatureFlagReader` and on the `host/wiring` reader over a FakeFs and a recording log.
// The flags follow the most specific layer that sets them (a blank value sets nothing), both are off
// by default, each is independent of the other, and an invalid value becomes the default with one
// warning that names its key (INV-110). Never imported by production code (R14).
import { describe, expect, it } from 'vitest'
import type { FeatureFlagReader } from '../ports/featureFlagReader'

/** The layers a reader is built over, keyed by the documented variable names. */
export interface FeatureFlagLayers {
  /** The process environment: raw text per variable (never the real `process.env` in a test). */
  env: Record<string, string | undefined>
  /** The userData config file's settings, or `null` when there is no file. */
  file: Record<string, string> | null
}

export interface FeatureFlagReaderSubject {
  reader: FeatureFlagReader
  /** The keys named by the invalid-value warnings the reader logged, in order. */
  warnedKeys(): string[]
}

const GUILD = 'GUILD_AREAS_ENABLED'
const BOOST = 'BOOST_ENABLED'

export function runFeatureFlagReaderContract(
  makeSubject: (
    layers: FeatureFlagLayers
  ) => FeatureFlagReaderSubject | Promise<FeatureFlagReaderSubject>
): void {
  describe('FeatureFlagReader contract', () => {
    it('[INV-110] the environment wins over the config file and the file over the defaults, which are false', async () => {
      const defaults = await makeSubject({ env: {}, file: null })
      expect(defaults.reader.read()).toStrictEqual({
        guildAreasEnabled: false,
        boostEnabled: false
      })

      const fromFile = await makeSubject({ env: {}, file: { [GUILD]: 'true', [BOOST]: '1' } })
      expect(fromFile.reader.read()).toStrictEqual({
        guildAreasEnabled: true,
        boostEnabled: true
      })

      const envOverFile = await makeSubject({
        env: { [GUILD]: 'false', [BOOST]: '0' },
        file: { [GUILD]: 'true', [BOOST]: 'true' }
      })
      expect(envOverFile.reader.read()).toStrictEqual({
        guildAreasEnabled: false,
        boostEnabled: false
      })

      const envOnly = await makeSubject({ env: { [GUILD]: ' TRUE ', [BOOST]: '1' }, file: {} })
      expect(envOnly.reader.read()).toStrictEqual({ guildAreasEnabled: true, boostEnabled: true })

      // A blank environment value sets nothing: it falls through to the file, not past it.
      const blankEnv = await makeSubject({
        env: { [GUILD]: '   ', [BOOST]: '' },
        file: { [GUILD]: 'true', [BOOST]: 'true' }
      })
      expect(blankEnv.reader.read()).toStrictEqual({ guildAreasEnabled: true, boostEnabled: true })

      for (const subject of [defaults, fromFile, envOverFile, envOnly, blankEnv]) {
        expect(subject.warnedKeys()).toStrictEqual([])
      }
    })

    it('[US-GUILD-003.AC03] turning one flag on in any layer leaves the other at its own value', async () => {
      const guildInEnv = await makeSubject({ env: { [GUILD]: 'true' }, file: null })
      expect(guildInEnv.reader.read()).toStrictEqual({
        guildAreasEnabled: true,
        boostEnabled: false
      })

      const boostInFile = await makeSubject({ env: {}, file: { [BOOST]: 'true' } })
      expect(boostInFile.reader.read()).toStrictEqual({
        guildAreasEnabled: false,
        boostEnabled: true
      })

      // One flag from each layer: neither reaches the other.
      const mixed = await makeSubject({ env: { [BOOST]: '1' }, file: { [GUILD]: 'false' } })
      expect(mixed.reader.read()).toStrictEqual({ guildAreasEnabled: false, boostEnabled: true })
    })

    it('[INV-110] an invalid value becomes the default and one warning names its key', async () => {
      const invalidEnv = await makeSubject({
        env: { [BOOST]: 'yes', [GUILD]: 'true' },
        file: { [BOOST]: 'true' }
      })
      expect(invalidEnv.reader.read()).toStrictEqual({
        guildAreasEnabled: true,
        boostEnabled: false
      })
      expect(invalidEnv.warnedKeys()).toStrictEqual([BOOST])

      const invalidFile = await makeSubject({ env: {}, file: { [GUILD]: 'on' } })
      expect(invalidFile.reader.read()).toStrictEqual({
        guildAreasEnabled: false,
        boostEnabled: false
      })
      expect(invalidFile.warnedKeys()).toStrictEqual([GUILD])

      // Read again: the value was settled once, so no second warning.
      invalidFile.reader.read()
      expect(invalidFile.warnedKeys()).toStrictEqual([GUILD])
    })
  })
}
