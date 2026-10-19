import { describe, expect, it } from 'vitest'
import type { DwarfId } from '../../../contracts/wire'
import { runStopAllContract } from '../testing/stopAll.contract'
import { RecordingStopAll } from './RecordingStopAll'

const ENDED = '01890a5d-ac96-774b-bcce-b302099a8061' as DwarfId
const FAILED = '01890a5d-ac96-774b-bcce-b302099a8062' as DwarfId

describe('RecordingStopAll', () => {
  runStopAllContract(() => {
    const owned = [ENDED, FAILED]
    return { port: new RecordingStopAll({ owned, failing: [FAILED] }), owned }
  })

  it('[INV-121] it ends every owned dwarf except the scripted failures and records each requestId', async () => {
    const journal: string[] = []
    const port = new RecordingStopAll({ owned: [ENDED, FAILED], failing: [FAILED], journal })

    const outcome = await port.stopAll('01890a5d-ac96-774b-bcce-b302099a8057')

    expect(outcome).toEqual({ ended: [ENDED], failed: [FAILED] })
    expect(port.calls).toEqual(['01890a5d-ac96-774b-bcce-b302099a8057'])
    expect(journal).toEqual(['stopAll:01890a5d-ac96-774b-bcce-b302099a8057'])
  })
})
