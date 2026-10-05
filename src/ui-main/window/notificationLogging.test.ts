// layer: L7
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { t, type DwarfId, type MineId, type OsNotification } from '@dwarfai/contracts'
import { NodeLogFiles } from '../diagnostics/adapters/NodeLogFiles'
import { FakeClock } from '../diagnostics/ports/fakes/FakeClock'
import { createUiLogger } from '../diagnostics/uiLogger'
import {
  ElectronNotificationDisplay,
  type NotificationConstructorLike,
  type NotificationLike
} from './adapters/ElectronNotificationDisplay'
import { startNotificationPresenter } from './application/notificationPresenter'
import type { AttentionFrame } from './ports/hostClient'

// L7 (17 §1.7 "Log redaction canary"; ADR-018 item 9; ADR-026; 19 §1 "OS notification titles and bodies: never
// logged"): level-3 notifications go through the real presenter, the real ElectronNotificationDisplay over a stubbed
// Electron constructor (drawn, clicked, failed, refused, withdrawn, and dropped by the S-018-1 fallback) and the real
// UI logger over a temporary `logs/` folder; no segment written holds the title, the body or the dwarf's name.

const START = Date.parse('2026-10-02T09:00:00.000Z')
const MINE = '01890a5d-ac96-774b-bcce-b302099a8111' as MineId
const DWARF = '01890a5d-ac96-774b-bcce-b302099ad111' as DwarfId
/** A custom name and a mine name that nothing but a notification ever carries (plain words, so no writer rule refuses them by shape). */
const CANARY_NAME = 'Zarqwenvald'
const CANARY_MINE = 'Ulthar Deepforge'

function notification(index: number): OsNotification {
  return {
    key: `${DWARF}:question:ask-${index}`,
    kind: 'question',
    title: t('attention.level3Title.question', { dwarf: CANARY_NAME }),
    body: CANARY_MINE,
    mineId: MINE,
    dwarfId: DWARF,
    sensitive: true
  }
}

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('level-3 notification logging (ISSUE-113)', () => {
  it('[NFR-SEC-12] a canary title and body never reach a UI log segment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dwarfai-notification-canary-'))
    roots.push(root)
    const logDir = join(root, 'logs')
    const clock = new FakeClock(START)
    const log = createUiLogger({
      files: new NodeLogFiles(),
      logDir,
      clock,
      appVersion: '0.20.0',
      pid: 4242,
      level: 'debug'
    })

    // The stub platform: supported until told otherwise; the second notification's constructor throws with the
    // content in its message; the others are shown, clicked, failed and closed.
    let supported = true
    let built = 0
    const live: Array<{ emit: (event: string) => void }> = []
    class StubNotification implements NotificationLike {
      private readonly listeners = new Map<string, Array<() => void>>()
      constructor(options: { title: string; body: string }) {
        built += 1
        if (built === 2) throw new Error(`cannot show ${options.title} for ${options.body}`)
        live.push({ emit: (event) => this.listeners.get(event)?.forEach((l) => l()) })
      }
      show(): void {}
      close(): void {
        throw new Error(`already closed: ${CANARY_NAME}`)
      }
      on(event: 'click' | 'close' | 'failed', listener: () => void): void {
        this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
      }
      static isSupported(): boolean {
        return supported
      }
    }
    const display = new ElectronNotificationDisplay({
      notification: StubNotification as NotificationConstructorLike,
      platform: 'win32',
      setAppUserModelId: () => undefined,
      log
    })
    const handlers = new Set<(frame: AttentionFrame) => void>()
    let windowOpen = true
    const emit = (frame: AttentionFrame): void => {
      // Each record at its own time, so none is folded away unseen (ADR-026 item 6).
      clock.advance(60_001)
      for (const handler of handlers) handler(frame)
    }
    startNotificationPresenter({
      onAttentionFrame: (h) => {
        handlers.add(h)
        return () => handlers.delete(h)
      },
      display,
      drawsWithoutWindow: false,
      anyWindowOpen: () => windowOpen,
      log
    })

    emit({ name: 'attention.notify', data: notification(1) }) // drawn
    emit({ name: 'attention.notify', data: notification(2) }) // the constructor throws
    emit({ name: 'attention.notify', data: notification(3) }) // drawn, then failed
    clock.advance(60_001)
    live[0]?.emit('click')
    clock.advance(60_001)
    live[1]?.emit('failed')
    emit({ name: 'attention.withdraw', data: { keys: [notification(1).key] } }) // close throws
    supported = false
    emit({ name: 'attention.notify', data: notification(4) }) // refused by the platform
    windowOpen = false
    emit({ name: 'attention.notify', data: notification(5) }) // the S-018-1 fallback drops it
    await log.flush()

    const names = await readdir(logDir)
    expect(names.length).toBeGreaterThan(0)
    const output = (
      await Promise.all(names.map((name) => readFile(join(logDir, name), 'utf8')))
    ).join('')
    // Every path wrote its record by event name.
    for (const fragment of [
      '"outcome":"ok"',
      '"errCode":"build-threw"',
      '"errCode":"failed-event"',
      '"causeClass":"clicked"',
      '"errCode":"unsupported"',
      '"errCode":"window-only"'
    ]) {
      expect(output, fragment).toContain(fragment)
    }
    for (const content of [
      CANARY_NAME,
      CANARY_MINE,
      'has a question',
      'cannot show',
      'already closed'
    ]) {
      expect(output, content).not.toContain(content)
    }
  })
})
