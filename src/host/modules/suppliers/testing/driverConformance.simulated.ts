// The reference run's inputs (15 §4.12): the SimulatedDriver factory, its conformance options and
// its fixture set `fixtures/simulated/simulated/1/`. Shared by the reference run and the harness's
// own negative tests, whose broken drivers are built over the reference one.
import { fileURLToPath } from 'node:url'
import { SIMULATED_RECORD } from '../adapters/catalog/profiles'
import {
  SimulatedDriver,
  type SimulatedSession
} from '../adapters/drivers/simulated/SimulatedDriver'
import type { InstalledProvider } from '../ports/providerDriver'
import type { ConformanceOptions, DriverFactory } from './driverConformance'
import { readFixtureSet, type FixtureSet } from './fixtureSet'

const REFERENCE_DIR = fileURLToPath(
  new URL('../../../../../fixtures/simulated/simulated/1/', import.meta.url)
)

export function readReferenceFixtures(): FixtureSet {
  return readFixtureSet(REFERENCE_DIR)
}

export const simulatedFactory: DriverFactory = (rig) =>
  new SimulatedDriver({
    profile: SIMULATED_RECORD.profile,
    transport: 'acp',
    capabilities: SIMULATED_RECORD.ceiling,
    seed: 'conformance',
    clock: rig.clock,
    scheduler: rig.scheduler
  })

const INSTALL: InstalledProvider = {
  providerId: SIMULATED_RECORD.profile.id,
  binaryPath: 'simulated',
  version: '1',
  resolvedVia: 'path',
  statMtimeMs: 0
}

export const SIMULATED_OPTIONS: ConformanceOptions = {
  ceiling: SIMULATED_RECORD.ceiling,
  install: INSTALL,
  injectTransportLoss: (session) => (session as SimulatedSession).simulateTransportLoss()
}
