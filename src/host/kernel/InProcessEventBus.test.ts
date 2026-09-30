import { describe } from 'vitest'
import { InProcessEventBus } from './InProcessEventBus'
import { runEventBusContract, type ContractEvent } from './testing/eventBus.contract'

describe('InProcessEventBus', () => {
  runEventBusContract((hooks) => new InProcessEventBus<ContractEvent>(hooks))
})
