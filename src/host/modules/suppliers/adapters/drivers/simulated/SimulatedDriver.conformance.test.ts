// The reference run of the driver conformance suite (15 §4.12, §6; ISSUE-144 TC-144-01): the
// SimulatedDriver against `fixtures/simulated/simulated/1/`, one test per case C-01…C-29, each
// titled with its id. The cases its capabilities make inapplicable are declared in its options
// (`testing/driverConformance.simulated.ts`) and asserted at their fail-closed value.
import { driverConformance } from '../../../testing/driverConformance'
import {
  SIMULATED_OPTIONS,
  readReferenceFixtures,
  simulatedFactory
} from '../../../testing/driverConformance.simulated'

driverConformance(
  'SimulatedDriver conformance',
  simulatedFactory,
  readReferenceFixtures(),
  SIMULATED_OPTIONS
)
