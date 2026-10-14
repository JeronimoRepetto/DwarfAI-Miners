// layer: L2 (the board change through today's runtime pushes), L7 (the static bridge check)
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultDwarf, defaultMine, type Mine } from '../main/domain/types'
import { decideNotifications, emptyNotifyMemory } from '../main/notifications/notifyDecision'
import { MATERIALS, type MaterialTotals } from '../shared/contracts'
import { legacyRuntimePushes } from './LegacyRuntimeRoute'

/**
 * The cut-1 notifier retirement (ISSUE-125; 21 §2 cut 1 "Retired at the end"; ADR-018 items 1, 7): today's notifier
 * (`notifyDecision` → Electron `Notification`) is no longer composed by the bridges whatever the route table, so the
 * Host's attention policy is the only way to an OS notification. The `notifications/*` files stay until cut 5.
 */
const BRIDGES = resolve(import.meta.dirname)

/** No ore of any material: the board change carries no crediting. */
const NO_ORE = Object.fromEntries(MATERIALS.map((material) => [material, 0])) as MaterialTotals

/** Every production file under src/legacy-bridge (a test may still read a legacy module to prove a behaviour). */
function productionFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(folder, entry.name)
    if (entry.isDirectory()) return productionFiles(path)
    return /\.ts$/.test(entry.name) && !/\.(test|contract)\.ts$/.test(entry.name) ? [path] : []
  })
}

/** A board with one mine whose dwarf asks a question, or waits quietly. */
function board(asking: boolean): Mine[] {
  return [
    {
      ...defaultMine(),
      id: 'm1',
      name: 'Forge',
      dwarfs: [
        {
          ...defaultDwarf(),
          id: 'd1',
          role: 'foreman',
          status: 'waiting',
          ...(asking
            ? {
                pendingQuestion: {
                  toolUseId: 'ask-1',
                  channel: 'held',
                  questions: [{ question: 'Which branch?', multiSelect: false, options: [] }]
                }
              }
            : {})
        }
      ]
    }
  ]
}

describe('cut-1 notifier retirement (21 §2 cut 1)', () => {
  it('[ADR-018] no file under src/legacy-bridge constructs the legacy notifyDecision fold or an Electron Notification', () => {
    const files = productionFiles(BRIDGES)
    expect(files.length).toBeGreaterThan(0)
    const constructors = files.flatMap((path) => {
      const source = readFileSync(path, 'utf8')
      const name = path
        .slice(BRIDGES.length + 1)
        .split('\\')
        .join('/')
      return [
        /from '(\.\.\/)+main\/notifications\/(notifier|notifyDecision|electronNotifications)'/.test(
          source
        )
          ? [`${name} imports today's notifier`]
          : [],
        /\bnew\s+Notification\b/.test(source) ? [`${name} constructs a Notification`] : []
      ].flat()
    })
    expect(constructors).toEqual([])
  })

  it('[ADR-018] a legacy board change that would have notified before produces no OS notification', () => {
    // Today's fold over the same two boards decides a notification: this change notified before the retirement.
    const quiet = decideNotifications(emptyNotifyMemory(), {
      mines: board(false),
      focus: { panelVisible: false, openMineId: null },
      enabled: true,
      now: 1_000
    })
    const asked = decideNotifications(quiet.memory, {
      mines: board(true),
      focus: { panelVisible: false, openMineId: null },
      enabled: true,
      now: 2_000
    })
    expect(asked.decision.show.map((shown) => shown.title)).toEqual([
      'A question is waiting in Forge'
    ])

    // Today's runtime publishes the same change through the pushes the route composes: nothing reaches the panel, and
    // nothing asks whether it is on screen (the legacy notifier's focus rule), so no notification is decided or drawn.
    const reached: string[] = []
    const panel = {
      send: (channel: string) => void reached.push(`send ${channel}`),
      visible: () => {
        reached.push('visible')
        return false
      },
      show: () => void reached.push('show'),
      showOpenDialog: async () => ({ canceled: true, filePaths: [] })
    }
    const pushes = legacyRuntimePushes(panel)
    pushes.onMinesUpdated(board(false), NO_ORE)
    pushes.onMinesUpdated(board(true), NO_ORE)
    expect(reached).toEqual([])
  })
})
