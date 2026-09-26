import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, test } from 'vitest'
import { compareToReference } from './compare.mjs'
import { decide, locateDesign, nodeFs } from './design.mjs'
import { openPage, openRenderer, recordedRenderer, rendererMismatch } from './renderer.mjs'
import { startGoldenServer } from './server.mjs'
import { readStageCss } from './stage.mjs'
import {
  accept,
  anatomyRoot,
  anatomyTexts,
  checkFraming,
  checkStates,
  componentOf,
  expectation,
  framingFor,
  stageWidth
} from './states.mjs'

/*
 * Golden UI tests for the redesigned kit (#634), run by `pnpm test:golden` on the maintainer's
 * machine only. Each golden stages one state on src/renderer/golden.html, captures it with the
 * browser build and the capture code that took the design repository's references, and grades it
 * with that repository's compare-ref.js by the PO's acceptance rule.
 *
 * Before any state is trusted, the harness proves itself: the renderer must be the recorded one
 * (PO ruling G-01), and a reference shown as a plain image must capture back at 0% difference.
 * If the loopback is not exact, the harness moves pixels by itself, and no golden below it means
 * anything.
 *
 * Then each state in src/renderer/src/golden/states.json is the real component (renders.ts), with
 * props built from the design's sample data, mounted on a stage framed like its reference and
 * graded. A state marked `red` is an expected failure that must flip: it fails the run once it
 * passes (states.mjs). Every manifest state no golden covers yet is listed as a todo, so the run
 * doubles as the rebuild's coverage list. State ids appear here; nothing of the design itself does.
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

const readDesign = (...parts) => readFileSync(path.join(location.root, ...parts), 'utf8')
const states = JSON.parse(
  readFileSync(path.join(checkout, 'src', 'renderer', 'src', 'golden', 'states.json'), 'utf8')
)
// States a golden covers. Every other manifest state is a todo below.
const COVERED = new Set(states.map((s) => s.key))
// A visible (never held-out) kit reference with no scaled art: the loopback image.
const LOOPBACK_STATE = 'foundations/colour#materials'

describe.runIf(runnable)('golden harness', () => {
  let server
  let renderer
  let page

  beforeAll(async () => {
    server = await startGoldenServer(checkout)
    renderer = await openRenderer(location.root)
    page = await openPage(renderer)
    await page.navigate(server.url)
  })

  afterAll(async () => {
    await renderer?.browser.close()
    await server?.close()
  })

  it('renders with the browser build the references were taken with', () => {
    const mismatch = rendererMismatch(renderer.version, recordedRenderer(location.root))
    if (mismatch) throw new Error(mismatch)
  })

  it('captures a reference shown as an image back at 0% difference', async () => {
    const row = manifest[LOOPBACK_STATE]
    expect(row, LOOPBACK_STATE + ' is not in the manifest').toBeDefined()
    const file = path.join(referenceDir, ...row.file.split('/'))
    const src = 'data:image/png;base64,' + readFileSync(file).toString('base64')
    const box = await page.evaluate(
      'window.golden.showImage(' + JSON.stringify(src) + ', ' + row.x + ', ' + row.y + ')'
    )
    expect(box).toEqual({ x: row.x, y: row.y, width: row.width, height: row.height })
    await page.settle()
    const { stats, verdict } = compareToReference(
      location.root,
      file,
      await page.shot(box),
      'loopback'
    )
    expect(stats.differing + stats.uncovered).toBe(0)
    expect(verdict.pass).toBe(true)
    expect(page.errors).toEqual([])
  })

  it('frames a stage from the design CSS at the page position of every reference', async () => {
    // The width, padding included, is the manifest row's, never a cell width written here.
    const { x, y, width } = manifest[LOOPBACK_STATE]
    const frame = { css: readStageCss(location.root), x, y, width }
    const box = await page.evaluate('window.golden.frameStage(' + JSON.stringify(frame) + ')')
    // An empty stage is its minimum height, 96px.
    expect(box).toEqual({ x, y, width, height: 96 })
    expect(page.errors).toEqual([])
  })

  it('loads the sample data from the design repository into the page', async () => {
    const found = await page.evaluate(
      'window.golden.loadSample(' +
        JSON.stringify(readDesign('prototype', 'data', 'sample-data.js')) +
        ')'
    )
    expect(found.mines).toBeGreaterThan(0)
    expect(found.dwarfs).toBeGreaterThan(0)
    expect(page.errors).toEqual([])
  })

  it('lists only states the manifest has, each at most once', () => {
    expect(checkStates(states, manifest)).toEqual([])
  })

  for (const state of states) {
    const title = state.red ? state.key + ' (red: ' + state.red + ')' : state.key
    it(title, async () => {
      const row = manifest[state.key]
      const framing = framingFor(readDesign('docs', 'components.md'), componentOf(state.key))
      const framingError = checkFraming(
        framing,
        anatomyRoot(readDesign('docs', 'anatomy.md'), row.file)
      )
      if (framingError) throw new Error(framingError)
      const frame = {
        id: state.key,
        css: readStageCss(location.root),
        x: row.x,
        y: row.y,
        width: stageWidth(row),
        framing: framing.map((r) => r.declarations),
        // The texts its tree shows, for a specimen's captions: read here, never committed.
        texts: anatomyTexts(readDesign('docs', 'anatomy.md'), row.file)
      }
      await page.evaluate('window.golden.mountState(' + JSON.stringify(frame) + ')')
      await page.settle()
      const measured = await page.evaluate('window.golden.measureState()')
      // Where the stage sits is the harness's to get right, red or not.
      expect({ x: measured.box.x, y: measured.box.y }).toEqual({ x: row.x, y: row.y })
      expect(page.errors).toEqual([])
      const file = path.join(referenceDir, ...row.file.split('/'))
      const { stats, verdict } = compareToReference(
        location.root,
        file,
        await page.shot(measured.box),
        state.key
      )
      const outcome = expectation(state, accept(verdict, measured))
      console.log(
        'golden: ' +
          outcome.message +
          ' [' +
          stats.candWidth +
          'x' +
          stats.candHeight +
          ' against ' +
          stats.refWidth +
          'x' +
          stats.refHeight +
          '; ' +
          (stats.differing + stats.uncovered) +
          ' of ' +
          stats.total +
          ' pixels; ' +
          stats.clusters +
          ' clusters]'
      )
      if (!outcome.ok) throw new Error(outcome.message)
    })
  }
})

describe.runIf(runnable)('golden coverage', () => {
  for (const key of Object.keys(manifest)) if (!COVERED.has(key)) test.todo(key)
})

// Run straight through vitest on CI without a design: say why, rather than an empty file.
if (!runnable) {
  describe('golden', () => {
    it.skip(decision.message, () => {})
  })
}
