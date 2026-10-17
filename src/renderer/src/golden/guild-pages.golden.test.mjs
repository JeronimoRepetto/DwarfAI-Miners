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
 * The guild golden (ISSUE-265), run by `pnpm test:golden` on the maintainer's machine only: the
 * three guild pages and the nav both without the Guild group (the flag's default) and with it,
 * each graded against the pinned design's reference the way kit.golden.test.mjs grades every
 * state, plus the paintings compared byte for byte with the files the PO supplied.
 *
 * The states are the ones states.json and renders.ts already wire; this file adds none. A state
 * marked `red` there keeps its expected-failure meaning here (states.mjs `expectation`).
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

const GUILD_STATES = [
  'organisms/nav#default',
  'organisms/nav#guild-revealed',
  'organisms/guild-page#lab',
  'organisms/guild-page#market',
  'organisms/guild-page#laboral-union'
]
const AREAS = ['lab', 'market', 'laboral-union']

const states = JSON.parse(
  readFileSync(path.join(checkout, 'src', 'renderer', 'src', 'golden', 'states.json'), 'utf8')
)

/** One state staged as its reference frames it, captured and graded (kit.golden's steps). */
async function grade(page, server, state) {
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
  if (framingError) throw new Error(framingError)
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
  const file = path.join(referenceDir, ...row.file.split('/'))
  const { verdict } = compareToReference(
    location.root,
    file,
    await page.shot(measured.box),
    state.key
  )
  const outcome = expectation(state, accept(verdict, measured))
  if (!outcome.ok) throw new Error(outcome.message)
}

describe.runIf(runnable)('guild pages (ISSUE-265 golden)', () => {
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

  it('[US-GUILD-001.AC04, US-GUILD-002.AC01] the guild pages and the nav without them match the pinned design', async () => {
    for (const area of AREAS) {
      const supplied = readFileSync(
        path.join(location.root, 'prototype', 'assets', 'guild', area + '.png')
      )
      const bundled = readFileSync(
        path.join(checkout, 'src', 'renderer', 'src', 'assets', 'art', area, area + '.png')
      )
      expect(
        bundled.equals(supplied),
        area + ': the bundled painting differs from the supplied one'
      ).toBe(true)
    }
    for (const key of GUILD_STATES) {
      const state = states.find((one) => one.key === key)
      expect(state, key + ' is not wired in states.json').toBeDefined()
      await grade(page, server, state)
    }
  })
})
