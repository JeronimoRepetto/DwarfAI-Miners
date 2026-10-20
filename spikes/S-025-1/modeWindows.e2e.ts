import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { launchApp, type LaunchedApp } from '../../e2e/_harness/launchApp.ts'

/**
 * Spike S-025-1, L9 (testing strategy `17` §4; ADR-025 D1, D3; ADR-024 D3; spike register S-025-1).
 *
 * Question: when the UI main process hands a mode change from one frameless window to another (ADR-025 D3), do the two
 * windows move and animate together, at most one display frame apart, from a shared `t0` (UI main clock + 16 ms), and do
 * the draft, the caret and the selection the source window flushed come back in the target window's renderer?
 *
 * Inside the built app (the ISSUE-312 harness, E2E build profile), the case creates two small frameless windows of its
 * own (a stand-in source and target; the real mode windows are later: ISSUE-284, ISSUE-285), each with its own renderer
 * and in-memory session, shown inactive and not focusable, so the run never takes the keyboard focus. Then one
 * transition run, as ADR-025 D3 orders it:
 *
 * 1. the source page holds a draft with a backward selection; its view state (draft, `selectionStart`,
 *    `selectionEnd`, `selectionDirection`) is flushed to the main process and restored into the target page, before
 *    `t0`;
 * 2. the main process picks `t0` = its clock + 16 ms and hands it to both renderers;
 * 3. at `t0`, in one main-process tick, both windows are moved to their final bounds (`setBounds`) and both renderers
 *    play the same 270 ms motion (the motion spec's M) from `t0`, recording every frame's time;
 * 4. the measures: each window's first frame at or after `t0` (renderer clocks are put on the epoch through
 *    `performance.timeOrigin`), and the time each window reports its final bounds after the move was issued.
 *
 * One frame is `1000 / displayFrequency` of the primary display (60 Hz when Electron reports none, as under Xvfb).
 *
 * What this case cannot see, and the manual half (`spike-results/S-025-1.md`) records per OS: the OS's own show/hide
 * animation of a window (DWM transitions on Windows, the window animation on macOS) happens in the compositor, not in a
 * renderer frame or a window bound; and an IME composition needs a person typing through a real input method.
 *
 * The OS window animation switch of this case is `setBounds(bounds, animate)` with `OS_WINDOW_ANIMATION`: Electron
 * animates the move on macOS only and ignores the flag elsewhere. With the animation on, a macOS move does not reach its
 * final bounds within a frame, so the move-jitter half of the case fails (the load-bearing check, ISSUE-329).
 *
 * Set `S0251_REPORT=<file>` to write the measures as JSON (the spike record's raw output). Kept afterwards as the seed
 * of the ADR-025 E2E acceptance (`17` §4).
 */

/** The OS window animation of the move: off, as ADR-025 D1 requires. Turning it on must make the case fail. */
const OS_WINDOW_ANIMATION = false

/** The motion spec's cross-fade, M = 270 ms (ADR-025 Context). */
const MOTION_MS = 270
/** ADR-025 D3 step 2: `t0` is the UI main clock plus 16 ms. */
const T0_LEAD_MS = 16
/** The size of each stand-in window, and how far each one moves. */
const WINDOW_SIZE = { width: 160, height: 100 }
const MOVE_PX = 40

/** The draft and the selection the source window holds before the hand-off (a backward selection of "Veta"). */
const DRAFT = 'Hello Veta draft'
const SELECTION = { start: 6, end: 10, direction: 'backward' }

// One page for both windows. Page-side code is source text: this file is type-checked without the DOM library.
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>S-025-1</title>
<style>
  html, body { margin: 0; background: #1e1e1e; overflow: hidden; }
  #draft { width: 150px; height: 40px; }
  #motion { width: 40px; height: 40px; background: #d9a441; opacity: 0; will-change: transform, opacity; }
</style></head>
<body>
  <textarea id="draft"></textarea>
  <div id="motion"></div>
  <script>
    const draft = document.getElementById('draft')
    const motion = document.getElementById('motion')
    window.__spike = {
      frames: [],
      readViewState() {
        return {
          draft: draft.value,
          selectionStart: draft.selectionStart,
          selectionEnd: draft.selectionEnd,
          selectionDirection: draft.selectionDirection
        }
      },
      restoreViewState(state) {
        draft.value = state.draft
        draft.setSelectionRange(state.selectionStart, state.selectionEnd, state.selectionDirection)
        return window.__spike.readViewState()
      },
      // Plays the motion from t0 (epoch ms) for durationMs and records each frame's epoch time at or after t0.
      play(t0, durationMs) {
        const frames = []
        window.__spike.frames = frames
        return new Promise((resolve) => {
          const step = (stamp) => {
            const now = performance.timeOrigin + stamp
            if (now >= t0) {
              frames.push(now)
              const progress = Math.min(1, (now - t0) / durationMs)
              motion.style.opacity = String(progress)
              motion.style.transform = 'translateX(' + progress * 40 + 'px)'
              if (progress >= 1) {
                resolve(frames)
                return
              }
            }
            requestAnimationFrame(step)
          }
          requestAnimationFrame(step)
        })
      }
    }
  </script>
</body></html>
`

interface ViewState {
  draft: string
  selectionStart: number
  selectionEnd: number
  selectionDirection: string
}

/** What one transition run measured, in the main process and in both renderers. */
interface TransitionRun {
  displayFrequency: number
  t0: number
  moveIssuedAt: number
  /** Epoch ms at which each window first reported its final bounds after the move. */
  settledAt: { source: number | null; target: number | null }
  frames: { source: number[]; target: number[] }
  flushed: ViewState
  restored: ViewState
}

test.describe('S-025-1: mode windows moved in one transition run (ADR-025 D1, D3)', () => {
  let launched: LaunchedApp | undefined
  let workDir = ''

  test.beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'dwarfai-s0251-'))
  })

  test.afterEach(async () => {
    if (launched) {
      await launched.teardown()
      launched = undefined
    }
    rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  test('[S-025-1, ADR-025] two mode windows moved in one run differ by at most one frame and the caret and selection are restored after the hand-off', async () => {
    launched = await launchApp({ tracePath: test.info().outputPath('trace.zip') })
    const { app } = launched
    const pageFile = path.join(workDir, 'page.html')
    writeFileSync(pageFile, PAGE)

    const run = (await app.evaluate(
      async ({ BrowserWindow, screen }, args) => {
        const display = screen.getPrimaryDisplay()
        const area = display.workArea
        const epochNow = (): number => performance.timeOrigin + performance.now()
        // Bottom-right corner of the work area, away from where a person usually works.
        const start = (index: number) => ({
          x: area.x + area.width - (index + 1) * (args.size.width + 20) - args.movePx,
          y: area.y + area.height - args.size.height - 20,
          ...args.size
        })
        const open = async (index: number) => {
          const win = new BrowserWindow({
            ...start(index),
            show: false,
            frame: false,
            resizable: false,
            skipTaskbar: true,
            focusable: false,
            webPreferences: {
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false,
              backgroundThrottling: false,
              partition: 's0251-spike'
            }
          })
          await win.loadFile(args.page, { query: { w: String(index) } })
          return win
        }
        const source = await open(0)
        const target = await open(1)
        try {
          source.showInactive()
          // ADR-025 D3 step 1: the target is placed and shown before t0 (its content still at opacity 0).
          target.showInactive()

          // Step 4: the source flushes its view state; the target restores it before its content becomes visible.
          const flushed = (await source.webContents.executeJavaScript(
            `(() => {
              const draft = document.getElementById('draft')
              draft.value = ${JSON.stringify(args.draft)}
              draft.setSelectionRange(${args.selection.start}, ${args.selection.end}, '${args.selection.direction}')
              return window.__spike.readViewState()
            })()`
          )) as ViewState
          const restored = (await target.webContents.executeJavaScript(
            `window.__spike.restoreViewState(${JSON.stringify(flushed)})`
          )) as ViewState

          // Step 2: one t0 for both renderers.
          const t0 = epochNow() + args.t0LeadMs
          const playing = Promise.all([
            source.webContents.executeJavaScript(
              `window.__spike.play(${t0}, ${args.motionMs})`
            ) as Promise<number[]>,
            target.webContents.executeJavaScript(
              `window.__spike.play(${t0}, ${args.motionMs})`
            ) as Promise<number[]>
          ])

          // Step 3: at t0, both windows move in one main-process tick.
          await new Promise<void>((resolve) => {
            const wait = (): void => {
              if (epochNow() >= t0) resolve()
              else setTimeout(wait, 0)
            }
            wait()
          })
          const goal = (win: Electron.BrowserWindow) => {
            const bounds = win.getBounds()
            return { ...bounds, x: bounds.x + args.movePx }
          }
          const sourceGoal = goal(source)
          const targetGoal = goal(target)
          const moveIssuedAt = epochNow()
          source.setBounds(sourceGoal, args.animate)
          target.setBounds(targetGoal, args.animate)

          // A window has settled once it reports its final position (one pixel of rounding under display scaling).
          const settledAt: { source: number | null; target: number | null } = {
            source: null,
            target: null
          }
          const near = (win: Electron.BrowserWindow, want: { x: number; y: number }): boolean => {
            const now = win.getBounds()
            return Math.abs(now.x - want.x) <= 1 && Math.abs(now.y - want.y) <= 1
          }
          await new Promise<void>((resolve) => {
            const poll = (): void => {
              const now = epochNow()
              if (settledAt.source === null && near(source, sourceGoal)) settledAt.source = now
              if (settledAt.target === null && near(target, targetGoal)) settledAt.target = now
              const done = settledAt.source !== null && settledAt.target !== null
              if (done || now - moveIssuedAt > 2_000) resolve()
              else setTimeout(poll, 0)
            }
            poll()
          })

          const [sourceFrames, targetFrames] = await playing
          return {
            displayFrequency: display.displayFrequency,
            t0,
            moveIssuedAt,
            settledAt,
            frames: { source: sourceFrames, target: targetFrames },
            flushed,
            restored
          }
        } finally {
          source.destroy()
          target.destroy()
        }
      },
      {
        page: pageFile,
        size: WINDOW_SIZE,
        movePx: MOVE_PX,
        motionMs: MOTION_MS,
        t0LeadMs: T0_LEAD_MS,
        animate: OS_WINDOW_ANIMATION,
        draft: DRAFT,
        selection: SELECTION
      }
    )) as TransitionRun

    const frameMs = 1000 / (run.displayFrequency > 0 ? run.displayFrequency : 60)
    const firstFrame = (frames: number[]): number | null => frames[0] ?? null
    const sourceFirst = firstFrame(run.frames.source)
    const targetFirst = firstFrame(run.frames.target)
    const renderJitterMs =
      sourceFirst !== null && targetFirst !== null ? Math.abs(sourceFirst - targetFirst) : null
    const settleMs = (at: number | null): number | null =>
      at === null ? null : at - run.moveIssuedAt
    const moveJitterMs =
      run.settledAt.source !== null && run.settledAt.target !== null
        ? Math.abs(run.settledAt.source - run.settledAt.target)
        : null

    const report = process.env['S0251_REPORT']
    if (report) {
      writeFileSync(
        report,
        `${JSON.stringify(
          {
            platform: process.platform,
            electron: await app.evaluate(() => process.versions.electron),
            osWindowAnimation: OS_WINDOW_ANIMATION,
            displayFrequency: run.displayFrequency,
            frameMs,
            t0LeadMs: T0_LEAD_MS,
            motionMs: MOTION_MS,
            firstFrameAfterT0Ms: {
              source: sourceFirst === null ? null : sourceFirst - run.t0,
              target: targetFirst === null ? null : targetFirst - run.t0
            },
            renderJitterMs,
            framesRecorded: {
              source: run.frames.source.length,
              target: run.frames.target.length
            },
            moveSettledAfterIssueMs: {
              source: settleMs(run.settledAt.source),
              target: settleMs(run.settledAt.target)
            },
            moveJitterMs,
            viewState: { flushed: run.flushed, restored: run.restored }
          },
          null,
          2
        )}\n`
      )
    }

    // The renderers drew the motion: without frames this case proves nothing about jitter.
    expect(run.frames.source.length, 'the source window records frames from t0').toBeGreaterThan(0)
    expect(run.frames.target.length, 'the target window records frames from t0').toBeGreaterThan(0)
    // Both renderers start the shared motion within one frame of each other.
    expect(
      renderJitterMs,
      `the first frames after t0 differ by at most ${frameMs} ms`
    ).not.toBeNull()
    expect(renderJitterMs ?? Infinity).toBeLessThanOrEqual(frameMs)
    // Both windows reach their final bounds within one frame of the move, and of each other: the move does not animate.
    expect(
      settleMs(run.settledAt.source) ?? Infinity,
      'the source window settles within one frame'
    ).toBeLessThanOrEqual(frameMs)
    expect(
      settleMs(run.settledAt.target) ?? Infinity,
      'the target window settles within one frame'
    ).toBeLessThanOrEqual(frameMs)
    expect(
      moveJitterMs ?? Infinity,
      'the two moves settle within one frame of each other'
    ).toBeLessThanOrEqual(frameMs)
    // ADR-024 D3: the same draft, caret and selection in the target renderer.
    expect(run.flushed).toEqual({
      draft: DRAFT,
      selectionStart: SELECTION.start,
      selectionEnd: SELECTION.end,
      selectionDirection: SELECTION.direction
    })
    expect(run.restored, 'the target restores the flushed view state').toEqual(run.flushed)
  })
})
