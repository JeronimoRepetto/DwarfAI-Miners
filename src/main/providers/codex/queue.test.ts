import { describe, expect, it } from 'vitest'
import {
  CODEX_QUEUE_MIN_VERSION,
  canQueueToCodexThread,
  meetsCodexQueueVersionFloor
} from './queue'

describe('meetsCodexQueueVersionFloor', () => {
  it('names the release that introduced codex queue', () => {
    expect(CODEX_QUEUE_MIN_VERSION).toBe('0.149.0')
  })

  it('accepts the floor itself and anything above it', () => {
    expect(meetsCodexQueueVersionFloor('0.149.0')).toBe(true)
    expect(meetsCodexQueueVersionFloor('0.149.1')).toBe(true)
    expect(meetsCodexQueueVersionFloor('0.151.0')).toBe(true)
    expect(meetsCodexQueueVersionFloor('1.0.0')).toBe(true)
  })

  it('rejects a build that predates the subcommand', () => {
    expect(meetsCodexQueueVersionFloor('0.148.9')).toBe(false)
    expect(meetsCodexQueueVersionFloor('0.99.0')).toBe(false)
    expect(meetsCodexQueueVersionFloor('0.0.1')).toBe(false)
  })

  // Numeric ordering, never string ordering: '0.99.0' sorts after '0.149.0' as
  // text and is an older Codex in fact.
  it('compares components as numbers rather than as text', () => {
    expect(meetsCodexQueueVersionFloor('0.150.0')).toBe(true)
    expect(meetsCodexQueueVersionFloor('0.9.0')).toBe(false)
  })

  /**
   * A version nobody stated is not a version that passes. `cli_version` is a
   * NOT NULL DEFAULT '' column, so an unwritten one arrives as absent — and a
   * queue offered on an assumed version is exactly the exit-0-shaped lie the
   * capability matrix exists to prevent.
   */
  it('refuses an absent, blank or unparseable version', () => {
    expect(meetsCodexQueueVersionFloor(undefined)).toBe(false)
    expect(meetsCodexQueueVersionFloor('')).toBe(false)
    expect(meetsCodexQueueVersionFloor('unknown')).toBe(false)
    expect(meetsCodexQueueVersionFloor('0.149')).toBe(false)
  })

  it('reads the numeric triple out of a suffixed build string', () => {
    expect(meetsCodexQueueVersionFloor('0.151.0-alpha.3')).toBe(true)
    expect(meetsCodexQueueVersionFloor('0.100.0-rc.1')).toBe(false)
  })
})

describe('canQueueToCodexThread', () => {
  /**
   * The one configuration the live 2026-09-02 experiment proved: a plain
   * `source = 'cli'` TUI thread drains its queue at the next idle boundary
   * with no app-server daemon involved.
   */
  it('accepts a cli-source thread on a new enough Codex', () => {
    expect(canQueueToCodexThread({ sourceTag: 'cli', cliVersion: '0.151.0' })).toBe(true)
  })

  /**
   * Desktop-app threads are UNPROVEN, not disproven — nobody has watched one
   * drain. They stay out until someone runs the same ten minutes against one:
   * absent, never guessed.
   */
  it('refuses a desktop-app thread however new the Codex is', () => {
    expect(canQueueToCodexThread({ sourceTag: 'vscode', cliVersion: '0.151.0' })).toBe(false)
  })

  it('refuses a thread whose source the row never stated', () => {
    expect(canQueueToCodexThread({ cliVersion: '0.151.0' })).toBe(false)
  })

  /**
   * A sub-agent thread's `threads.source` carries the spawn blob instead of a
   * plain tag, so it has no source tag at all — and a Codex worker owns no
   * queue anyone has watched drain.
   */
  it('refuses a sub-agent thread, whose source is the spawn blob', () => {
    expect(canQueueToCodexThread({ sourceTag: undefined, cliVersion: '0.151.0' })).toBe(false)
  })

  /**
   * The floor is enforced PER THREAD, not per machine: a session started by an
   * older Codex is honestly unreachable even where the installed CLI is new
   * enough, because the queue the older session opened has no drain.
   */
  it('refuses a cli thread started by a Codex that predates the subcommand', () => {
    expect(canQueueToCodexThread({ sourceTag: 'cli', cliVersion: '0.148.0' })).toBe(false)
  })

  it('refuses a cli thread with no recorded version', () => {
    expect(canQueueToCodexThread({ sourceTag: 'cli' })).toBe(false)
  })
})
