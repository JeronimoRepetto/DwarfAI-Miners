// The reference run's inputs (15 §4.12): the SimulatedDriver factory, its conformance options and
// its fixture set `fixtures/simulated/simulated/1/`. Shared by the reference run and the harness's
// own negative tests, whose broken drivers are built over the reference one.
import { fileURLToPath } from 'node:url'
import { SIMULATED_CAPABILITIES, SIMULATED_RECORD } from '../adapters/catalog/profiles'
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
    capabilities: SIMULATED_CAPABILITIES,
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

const NO_SPAWN =
  'SimulatedDriver never calls ProcessControl.spawn: its identity is synthetic, reported through onSpawned'
const NO_ASK = 'permission and question are none: the simulated world opens no ask'

export const SIMULATED_OPTIONS: ConformanceOptions = {
  ceiling: SIMULATED_RECORD.ceiling,
  install: INSTALL,
  injectTransportLoss: (session) => (session as SimulatedSession).simulateTransportLoss(),
  cases: {
    // Lead decision (2026-10-14, ISSUE-144): the SimulatedDriver never calls ProcessControl.spawn
    // (a synthetic identity through onSpawned), so the spawn cases are declared inapplicable on
    // the reference run, asserted at their fail-closed value (no spawn at all), and proven by
    // broken-driver tests over the recording spawn in driverConformance.test.ts. C-04 (an exit
    // timed from the spawn) is a spawn case too: no simulated process can exit before readiness.
    'C-02': { inapplicable: NO_SPAWN },
    'C-03': { inapplicable: NO_SPAWN },
    'C-04': { inapplicable: NO_SPAWN },
    'C-23': { inapplicable: NO_SPAWN },
    'C-24': { inapplicable: NO_SPAWN },
    'C-06': { inapplicable: NO_ASK },
    'C-07': { inapplicable: NO_ASK },
    'C-09': { inapplicable: NO_ASK },
    'C-10': { inapplicable: NO_ASK },
    'C-11': { inapplicable: NO_ASK },
    'C-12': { inapplicable: 'answeredElsewhere is false' },
    'C-14': { inapplicable: NO_ASK },
    'C-15': { inapplicable: NO_ASK },
    'C-16': { inapplicable: 'resume is none' },
    'C-17': { inapplicable: 'adopt is false' },
    'C-21': { inapplicable: 'usage fidelity is 0: the simulated world reports no usage' },
    'C-22': { inapplicable: 'no policy-only permission mode is offered' },
    'C-26': { inapplicable: 'the simulated driver is not a stream-json driver' },
    'C-27': { inapplicable: 'the simulated profile has no answer-channel gate' }
  }
}
