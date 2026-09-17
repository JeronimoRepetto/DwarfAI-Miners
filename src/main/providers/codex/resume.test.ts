import { describe, expect, it } from 'vitest'
import { canResumeCodexThread } from './resume'

/**
 * The gate for #450's channel, and the half of the registry row `queue.ts`
 * refuses. Both are answered from `threads.source` and they never overlap:
 * exactly one of them can be true of a thread.
 */
describe('canResumeCodexThread', () => {
  it('accepts a headless exec thread, which is the shape the resume was measured on', () => {
    expect(canResumeCodexThread({ sourceTag: 'exec' })).toBe(true)
  })

  /*
   * A session somebody is sitting in front of takes turns already: resuming it
   * would start a second one underneath the person. That thread has the queue,
   * and this is where the two gates stay apart.
   */
  it('refuses a thread somebody is sitting in front of', () => {
    expect(canResumeCodexThread({ sourceTag: 'cli' })).toBe(false)
  })

  it('refuses the desktop app, which is neither', () => {
    expect(canResumeCodexThread({ sourceTag: 'vscode' })).toBe(false)
  })

  /*
   * Positive evidence only, on the same terms `isCodexOneShotThread` holds: a
   * sub-agent spawn blob carries no plain tag at all, and a tag this build has
   * never seen is not an exec run.
   */
  it('refuses a tag this build does not know, and no tag at all', () => {
    expect(canResumeCodexThread({ sourceTag: 'something-new' })).toBe(false)
    expect(canResumeCodexThread({})).toBe(false)
  })

  /**
   * No version floor, unlike the queue's (#97), and the reason is the failure
   * shape rather than a lower bar: a Codex with no `exec resume` refuses the
   * argv and dies at once, which the delivery tier reports as a failure — where
   * a queue that never drains exits 0 and loses the message in silence.
   */
  it('asks nothing about the build that opened the thread', () => {
    expect(canResumeCodexThread({ sourceTag: 'exec', cliVersion: '0.100.0' })).toBe(true)
  })
})
