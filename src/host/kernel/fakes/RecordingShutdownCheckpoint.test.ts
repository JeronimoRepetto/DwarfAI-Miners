import { describe, expect, it } from 'vitest'
import { RecordingShutdownCheckpoint } from './RecordingShutdownCheckpoint'

describe('RecordingShutdownCheckpoint', () => {
  it('[ADR-002] keeps every flush and markClean call in order, in its calls and in the journal', () => {
    const journal: string[] = []
    const checkpoint = new RecordingShutdownCheckpoint(journal)

    checkpoint.flush()
    checkpoint.markClean('os-session-end')

    expect(checkpoint.calls).toEqual([
      { kind: 'flush' },
      { kind: 'markClean', reason: 'os-session-end' }
    ])
    expect(journal).toEqual(['checkpoint.flush', 'checkpoint.markClean:os-session-end'])
  })
})
