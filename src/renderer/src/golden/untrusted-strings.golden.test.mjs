import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { decide, locateDesign, nodeFs } from '../../../../scripts/golden/design.mjs'
import { openPage, openRenderer } from '../../../../scripts/golden/renderer.mjs'
import { startGoldenServer } from '../../../../scripts/golden/server.mjs'
import { untrustedText } from '../lib/text/untrustedText.ts'

/*
 * The C-08 golden (18 §6, ISSUE-251), run by `pnpm test:golden` on the maintainer's machine only:
 * the same pinned browser build the design references were captured with, the same golden page.
 *
 * jsdom has no layout, so the unit tests can prove what the rule REMOVES but not what a real text
 * engine then DRAWS. This file draws each hostile string the way a call site does (the rule's
 * output as one text node inside a `<bdi>`, inside a sentence of the Panel's own) and reads the
 * caret positions back from the browser:
 *
 * - every hostile control is gone from what is drawn (U+202E, U+2066 to U+2069, NUL, ESC [31m);
 * - the command's characters are drawn left to right in the order they are written, so a
 *   right-to-left override cannot show "exe.txt" where "txt.exe" is written;
 * - the Panel's own words after the string start to the right of it: nothing inside the
 *   isolate reorders what surrounds it.
 *
 * The design names no reference state for these strings yet, so this golden grades the rule in
 * the pinned browser rather than against a picture; a state joins states.json once the design
 * pins one.
 */

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const location = locateDesign({ checkout, env: process.env, fs: nodeFs })
const decision = decide(location, process.env)
if (decision.action === 'fail') throw new Error(decision.message)
const runnable = decision.action === 'run'

/** The characters C-08 names, none of which may reach the screen. */
const HOSTILE_CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202A-\u202E\u2066-\u2069]/

const CASES = [
  { id: 'right-to-left override', raw: 'rm -rf ~/\u202Eexe.txt', drawn: 'rm -rf ~/exe.txt' },
  {
    id: 'isolate controls U+2066 to U+2069',
    raw: 'git \u2066push\u2069 \u2067--force\u2069 \u2068origin\u2069',
    drawn: 'git push --force origin'
  },
  { id: 'NUL', raw: 'report\u0000.txt', drawn: 'report.txt' },
  { id: 'ANSI colour escape', raw: '\u001b[31mnpm test\u001b[0m', drawn: 'npm test' }
]

/*
 * Runs in the page. Builds `<p>Allow <bdi>{text}</bdi> now?</p>` from text nodes only, then
 * reports what was drawn and where each character of the isolate and the first character after
 * it sit on the line.
 */
const MEASURE = `(text) => {
  const sentence = document.createElement('p')
  sentence.style.cssText = 'position:absolute;left:16px;top:16px;margin:0;white-space:pre;font:16px monospace'
  const isolate = document.createElement('bdi')
  isolate.textContent = text
  sentence.append(document.createTextNode('Allow '), isolate, document.createTextNode(' now?'))
  document.body.append(sentence)
  const leftOf = (node, offset) => {
    const range = document.createRange()
    range.setStart(node, offset)
    range.setEnd(node, offset + 1)
    return range.getBoundingClientRect().left
  }
  const inside = isolate.firstChild
  const lefts = []
  for (let i = 0; i < inside.length; i++) if (inside.data[i] !== ' ') lefts.push(leftOf(inside, i))
  const after = leftOf(sentence.lastChild, 1)
  const isolateRight = isolate.getBoundingClientRect().right
  const drawn = isolate.textContent
  sentence.remove()
  return { drawn, lefts, after, isolateRight }
}`

describe.runIf(runnable)('C-08 untrusted strings (18 §6 golden)', () => {
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

  it('[NFR-SEC-07] strings with U+202E, U+2066 to U+2069, NUL and an ANSI colour escape render isolated or stripped as the pinned design shows', async () => {
    for (const hostile of CASES) {
      const text = untrustedText(hostile.raw)
      const measured = await page.evaluate('(' + MEASURE + ')(' + JSON.stringify(text) + ')')

      expect(measured.drawn, hostile.id + ': what is drawn').toBe(hostile.drawn)
      expect(
        HOSTILE_CONTROLS.test(measured.drawn),
        hostile.id + ': a control reached the screen'
      ).toBe(false)
      const reordered = measured.lefts.findIndex(
        (left, i) => i > 0 && left <= measured.lefts[i - 1]
      )
      expect(reordered, hostile.id + ': characters drawn out of written order').toBe(-1)
      expect(
        measured.after,
        hostile.id + ': the words after the string moved into it'
      ).toBeGreaterThanOrEqual(measured.isolateRight)
    }
    expect(page.errors).toEqual([])
  })
})
