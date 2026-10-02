import { describe } from 'vitest'
import { FakeFeatureFlagReader } from '../ports/fakes/FakeFeatureFlagReader'
import { runFeatureFlagReaderContract } from './featureFlagReader.contract'

// L3 (17 §1.3): the double runs the same contract as the `host/wiring` reader.
describe('FakeFeatureFlagReader', () => {
  runFeatureFlagReaderContract((layers) => {
    const reader = FakeFeatureFlagReader.fromLayers(layers)
    return { reader, warnedKeys: () => [...reader.warnedKeys] }
  })
})
