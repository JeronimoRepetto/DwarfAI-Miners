/*
 * The fixture read models of the Control-room mosaic (ISSUE-298, S-034-1): N mines, each with the
 * same crew of three, one working, one idle and one asleep, so every column keeps its sprites on
 * the frame clock (the shift cycle, the idle loop and the sleep). Test data only: no Host, no
 * provider, no path of this machine.
 */
import {
  defaultDwarf,
  defaultMaterials,
  defaultMine
} from '../../../src/renderer/src/testing/factories'
import type { BoardDwarf } from '../../../src/renderer/src/lib/scene/boardDwarf'
import type { Mine, MineTier } from '../../../src/renderer/src/types'

const TIERS: readonly MineTier[] = ['bronze', 'copper', 'silver', 'gold', 'uranium']

/** The crew of mine `index`: a worker at the rock, a second worker idle and the foreman asleep. */
function crewOf(index: number): BoardDwarf[] {
  const session = `fixture-session-${index}`
  return [
    defaultDwarf({
      id: `fixture-${index}-worker`,
      role: 'worker',
      name: 'Worker',
      status: 'working',
      sessionId: session
    }),
    {
      ...defaultDwarf({
        id: `fixture-${index}-worker2`,
        role: 'worker2',
        name: 'Second worker',
        status: 'waiting',
        sessionId: session
      }),
      hostStatus: 'idle'
    },
    {
      ...defaultDwarf({
        id: `fixture-${index}-foreman`,
        role: 'foreman',
        name: 'Foreman',
        status: 'waiting',
        sessionId: session
      }),
      hostStatus: 'asleep'
    }
  ]
}

/** `count` open mines for the mosaic, in column order. */
export function fixtureMines(count: number): Mine[] {
  return Array.from({ length: count }, (_, index) =>
    defaultMine({
      id: `fixture-mine-${index}`,
      path: `/fixture/mine-${index}`,
      name: `Mine ${index + 1}`,
      tier: TIERS[index % TIERS.length]!,
      dwarfs: crewOf(index),
      materials: defaultMaterials()
    })
  )
}
