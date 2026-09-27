import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { compareRegion } from './compare.mjs'
import { decide, locateDesign, nodeFs } from './design.mjs'
import { openPage, openRenderer, rendererMismatch, recordedRenderer } from './renderer.mjs'
import {
  clusterSummary,
  coveredError,
  isScreenState,
  pickTarget,
  restPoint,
  screenPlan,
  workArea
} from './screens.mjs'
import { startGoldenServer } from './server.mjs'
import { expectation } from './states.mjs'

/*
 * Full-screen goldens (#635), run by `pnpm test:golden` on the maintainer's machine only. Each is
 * one `screens-full/<screen>#<state>` row of the design's manifest: the prototype's screen page
 * driven by a recipe of real clicks and key presses, captured whole, with the box of every app
 * window it shows (docs/README.md, Full-screen references).
 *
 * Here the real App is mounted, on the bridge api.ts answers from the design's sample, in a page
 * sized to the app's window: the work area of the reference's screen, whose height the Panel's
 * window spans and whose docked edge it rests against. The renderer packs the dock against that
 * edge and leaves the free side transparent, so the whole work area stands in for the window
 * without moving a pixel of it (App.vue, .panel-dock). The recipe's steps are replayed with the
 * design's own click rules, the page is held still as a reference capture holds it, and each
 * window box is captured and graded against the reference cut to the same box. The desktop the
 * prototype draws around them is not the app's, and is never compared. Every window must pass.
 *
 * A state marked `red` is an expected failure that must flip, as a kit state's is (states.mjs).
 */

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const location = locateDesign({ checkout, env: process.env, fs: nodeFs })
const decision = decide(location, process.env)
if (decision.action === 'fail') throw new Error(decision.message)
const runnable = decision.action === 'run'
const referenceDir = runnable ? path.join(location.root, 'docs', 'reference') : ''
const manifest = runnable
  ? JSON.parse(readFileSync(path.join(referenceDir, 'manifest.json'), 'utf8'))
  : {}
// The recipes' key codes, from the design's own driver: never copied here.
const KEYS = runnable
  ? createRequire(import.meta.url)(path.join(location.root, 'tools', 'lib', 'screen-refs.js')).KEYS
  : {}

const readDesign = (...parts) => readFileSync(path.join(location.root, ...parts), 'utf8')
const screens = JSON.parse(
  readFileSync(path.join(checkout, 'src', 'renderer', 'src', 'golden', 'states.json'), 'utf8')
).filter((s) => isScreenState(s.key))

describe.runIf(runnable)('full-screen goldens', () => {
  let server
  let renderer
  let page

  beforeAll(async () => {
    server = await startGoldenServer(checkout)
    renderer = await openRenderer(location.root)
    page = await openPage(renderer)
  })

  afterAll(async () => {
    await renderer?.browser.close()
    await server?.close()
  })

  it('renders with the browser build the references were taken with', () => {
    const mismatch = rendererMismatch(renderer.version, recordedRenderer(location.root))
    if (mismatch) throw new Error(mismatch)
  })

  const click = async (key, n, step) => {
    const found = pickTarget(
      await page.evaluate('window.golden.candidates(' + JSON.stringify(step.click) + ')'),
      step.text ?? null
    )
    const where = key + ' step ' + n + ' (click ' + step.click + '): '
    if (found.error) throw new Error(where + found.error)
    const hit = await page.evaluate(
      'window.golden.hitTest(' +
        [JSON.stringify(step.click), found.index, found.x, found.y].join(', ') +
        ')'
    )
    const covered = coveredError(hit, found.x, found.y)
    if (covered) throw new Error(where + covered)
    await page.mouse('mouseMoved', found.x, found.y)
    await page.mouse('mousePressed', found.x, found.y, {
      button: 'left',
      buttons: 1,
      clickCount: 1
    })
    await page.mouse('mouseReleased', found.x, found.y, {
      button: 'left',
      buttons: 0,
      clickCount: 1
    })
  }

  const press = async (key, n, name) => {
    const code = KEYS[name]
    if (!code) throw new Error(key + ' step ' + n + ': the design has no key code for ' + name)
    const event = {
      key: name,
      code: code.code,
      windowsVirtualKeyCode: code.vk,
      nativeVirtualKeyCode: code.vk
    }
    await page.key('rawKeyDown', event)
    await page.key('keyUp', event)
  }

  for (const state of screens) {
    const title = state.red ? state.key + ' (red: ' + state.red + ')' : state.key
    it(title, async () => {
      const row = manifest[state.key]
      const area = workArea(row.viewport)
      await page.resize(area.width, area.height)
      await page.navigate(server.url)
      await page.evaluate(
        'window.golden.loadSample(' +
          JSON.stringify(readDesign('prototype', 'data', 'sample-data.js')) +
          ')'
      )
      const plan = screenPlan(state.key, row, await page.evaluate('window.golden.sampleSets()'))
      if (plan.sample)
        await page.evaluate('window.golden.useSample(' + JSON.stringify(plan.sample) + ')')
      await page.evaluate('window.golden.mountScreen()')
      // Whatever the app scheduled as it started, as the design's driver lets the page boot.
      await page.settleStep()
      const rest = restPoint(area, plan.windows)
      await page.mouse('mouseMoved', rest.x, rest.y)
      for (const [i, step] of plan.steps.entries()) {
        if (step.key) await press(state.key, i + 1, step.key)
        else await click(state.key, i + 1, step)
        await page.settleStep()
      }
      await page.mouse('mouseMoved', rest.x, rest.y)
      await page.settleScreen()
      expect(page.errors).toEqual([])

      const file = path.join(referenceDir, ...row.file.split('/'))
      // One shot of the whole work area, cut per window: shooting each box on its own would let
      // one capture disturb the page the next one takes.
      const screen = await page.shot(
        { x: 0, y: 0, width: area.width, height: area.height },
        { beyond: false }
      )
      const failures = []
      // The state's figure is its worst window's.
      let worst = 0
      for (const w of plan.windows) {
        const box = { x: w.x, y: w.y, width: w.width, height: w.height }
        const { stats, verdict, clusters } = compareRegion(
          location.root,
          file,
          screen,
          box,
          state.key + '@' + w.selector
        )
        console.log(
          'golden: ' +
            state.key +
            ' window ' +
            w.name +
            ' (' +
            [w.x, w.y, w.width, w.height].join(',') +
            '): ' +
            verdict.percent.toFixed(3) +
            '% differing, ' +
            (stats.differing + stats.uncovered) +
            ' of ' +
            stats.total +
            ' pixels; clusters (window coordinates): ' +
            clusterSummary(clusters)
        )
        if (!verdict.pass) failures.push(w.name + ': ' + verdict.reasons.join('; '))
        worst = Math.max(worst, verdict.percent)
      }
      const outcome = expectation(state, {
        pass: failures.length === 0,
        percent: worst,
        reasons: failures
      })
      console.log('golden: ' + outcome.message)
      if (!outcome.ok) throw new Error(outcome.message)
    })
  }
})

// Run straight through vitest on CI without a design: say why, rather than an empty file.
if (!runnable) {
  describe('full-screen goldens', () => {
    it.skip(decision.message, () => {})
  })
}
