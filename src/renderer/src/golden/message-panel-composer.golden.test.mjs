import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { compareToReference } from '../../../../scripts/golden/compare.mjs'
import { decide, locateDesign, nodeFs } from '../../../../scripts/golden/design.mjs'
import { openPage, openRenderer } from '../../../../scripts/golden/renderer.mjs'
import { startGoldenServer } from '../../../../scripts/golden/server.mjs'
import { readStageCss } from '../../../../scripts/golden/stage.mjs'
import {
  accept,
  anatomyAttributes,
  anatomyRoot,
  anatomyTexts,
  applicableFraming,
  borrowedFraming,
  checkFraming,
  componentOf,
  expectation,
  framingFor,
  splitFraming,
  stageWidth
} from '../../../../scripts/golden/states.mjs'

/*
 * The MessagePanel composer and log golden (ISSUE-257), run by `pnpm test:golden` on the
 * maintainer's machine only: the composer's states (empty, and disabled with its reason) and the
 * MessagePanel's conversation and closed-session states — the hint line, the TODAY divider over
 * the log, the bubbles and their marks, and the closed-session sentence in the well — staged with
 * the real components and graded against the pinned design's reference, exactly as
 * scripts/golden/kit.golden.test.mjs grades each kit state, under one title that names the stories
 * the states prove. The harness checks themselves (renderer build, loopback) are the kit golden's.
 */

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const location = locateDesign({ checkout, env: process.env, fs: nodeFs })
const decision = decide(location, process.env)
if (decision.action === 'fail') throw new Error(decision.message)
const runnable = decision.action === 'run'
const referenceDir = runnable ? path.join(location.root, 'docs', 'reference') : ''
const manifest = runnable
  ? JSON.parse(readFileSync(path.join(referenceDir, 'manifest.json'), 'utf8'))
  : {}

const readDesign = (...parts) => readFileSync(path.join(location.root, ...parts), 'utf8')
/*
 * The states the three stories need on screen: the composer and its hint (US-MSG-001.AC12), the
 * log's TODAY divider (US-MSG-001.AC14), and the closed-session well (US-MSG-013.AC05).
 */
const NEEDED = [
  'molecules/composer#empty',
  'molecules/composer#disabled',
  'organisms/message-panel#conversation',
  'organisms/message-panel#not-delivered-copy-alone'
]
const states = JSON.parse(
  readFileSync(path.join(checkout, 'src', 'renderer', 'src', 'golden', 'states.json'), 'utf8')
).filter((state) => NEEDED.includes(state.key))

describe.runIf(runnable)('the MessagePanel composer golden (ISSUE-257)', () => {
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

  /** Stages one state on a fresh page and grades it, as the kit golden does. */
  async function grade(state) {
    const row = manifest[state.key]
    expect(row, state.key + ' is not in the manifest').toBeDefined()
    const anatomy = readDesign('docs', 'anatomy.md')
    const componentsMd = readDesign('docs', 'components.md')
    const root = anatomyRoot(anatomy, row.file)
    const framing = applicableFraming(
      [
        ...framingFor(componentsMd, componentOf(state.key)),
        ...borrowedFraming(componentsMd, componentOf(state.key), root)
      ],
      anatomyAttributes(anatomy, row.file)
    )
    const framingError = checkFraming(framing, root)
    if (framingError) return state.key + ': ' + framingError
    const split = splitFraming(framing)
    const frame = {
      id: state.key,
      css: readStageCss(location.root) + (split.css ? '\n' + split.css : ''),
      x: row.x,
      y: row.y,
      width: stageWidth(row),
      framing: split.root,
      texts: anatomyTexts(anatomy, row.file),
      attributes: anatomyAttributes(anatomy, row.file)
    }
    await page.navigate(server.url)
    await page.evaluate(
      'window.golden.loadSample(' +
        JSON.stringify(readDesign('prototype', 'data', 'sample-data.js')) +
        ')'
    )
    await page.evaluate('window.golden.mountState(' + JSON.stringify(frame) + ')')
    await page.settle(state.key)
    const measured = await page.evaluate('window.golden.measureState()')
    expect({ x: measured.box.x, y: measured.box.y }).toEqual({ x: row.x, y: row.y })
    expect(page.errors).toEqual([])
    const { verdict } = compareToReference(
      location.root,
      path.join(referenceDir, ...row.file.split('/')),
      await page.shot(measured.box),
      state.key
    )
    const outcome = expectation(state, accept(verdict, measured))
    console.log('golden: ' + outcome.message)
    return outcome.ok ? null : outcome.message
  }

  it('[US-MSG-001.AC12, US-MSG-001.AC14, US-MSG-013.AC05] the composer and log states match the pinned design', async () => {
    expect(states.map((state) => state.key)).toEqual(expect.arrayContaining(NEEDED))
    const failures = []
    for (const state of states) {
      const failure = await grade(state)
      if (failure !== null) failures.push(failure)
    }
    expect(failures).toEqual([])
  })
})
