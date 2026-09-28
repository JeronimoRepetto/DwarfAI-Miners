/*
 * The full-screen goldens' pure rules (#635): the design's full-screen references
 * (`docs/reference/screens-full/`, docs/README.md "Full-screen references") driven on the real
 * App instead of the prototype's screen page.
 *
 * A reference is the prototype's page driven by a recipe of real clicks and key presses, captured
 * whole, with a `windows` list giving each app window's box in the image. The app renders only
 * its own window, never the desktop the prototype draws around it, so a golden compares each of
 * those boxes and nothing else, cut out of the reference as `tools/compare-ref.js --region` cuts
 * it. The click semantics are the design's own (`tools/lib/screen-refs.js`, locateInPage): the
 * selector must match exactly one visible element, optionally narrowed to an exact trimmed text,
 * the click lands on its centre on whole pixels, and nothing may cover that centre.
 *
 * A step that clicks the prototype's own chrome (a selector under one of the row's `hidden`
 * selectors, such as the Panel page's controls plate) is not a step on the screen: it swaps the
 * prototype's sample set. The app has no such control, so the golden stands the sample set it
 * names in for it at mount and drops the click. Only a sample switch has a stand-in, and only
 * before any step on the app: anything else is refused rather than skipped. The switch swaps the
 * data under a running app and relaunches nothing, so the app still opens on the launch the booted
 * sample remembers (golden/sample.ts, swapSample); the first-run references show exactly that.
 *
 * Pure; screens.golden.test.mjs reads the files and drives the browser.
 */

/**
 * The taskbar the prototype draws under every full-screen page: the work area ends this far above
 * the screen's bottom (docs/README.md, Comparing your build, "Same screen").
 */
export const TASKBAR = 40

export const isScreenState = (key) => key.startsWith('screens-full/')

/** The app's window spans the work area: the screen less the drawn taskbar. */
export function workArea(viewport) {
  return { width: viewport.width, height: viewport.height - TASKBAR }
}

const whole = (v) => Number.isInteger(v) && v >= 0

function controlSelectors(hidden) {
  return (hidden ?? []).flatMap((list) =>
    list
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  )
}

const labelOf = (selector) => /\[aria-label="([^"]*)"\]/.exec(selector)?.[1]

export function screenPlan(key, row, samples) {
  const controls = controlSelectors(row.hidden)
  const steps = []
  let sample = null
  row.steps.forEach((step, i) => {
    const at = key + ' step ' + (i + 1)
    if (step.key !== undefined) {
      steps.push({ key: step.key })
      return
    }
    const first = step.click.trim().split(/\s+/)[0]
    if (controls.includes(first)) {
      const found = samples.find((s) => s.label === labelOf(step.click))
      if (!found) {
        throw new Error(
          at +
            ' clicks a prototype control (' +
            step.click +
            ') that names no sample set: the harness has no stand-in for it'
        )
      }
      if (steps.length) {
        throw new Error(
          at +
            ' switches the sample set after a step on the app; the golden hands the board in at ' +
            'mount, so a switch must come before every other step'
        )
      }
      sample = found.id
      return
    }
    steps.push(
      step.text === undefined ? { click: step.click } : { click: step.click, text: step.text }
    )
  })
  const windows = row.windows ?? []
  if (!windows.length) throw new Error(key + ' has no window to compare')
  const area = workArea(row.viewport)
  for (const w of windows) {
    const fits =
      [w.x, w.y, w.width, w.height].every(whole) &&
      w.width > 0 &&
      w.height > 0 &&
      w.x + w.width <= area.width &&
      w.y + w.height <= area.height
    if (!fits) {
      throw new Error(
        key +
          ': the window ' +
          w.name +
          ' (' +
          [w.x, w.y, w.width, w.height].join(',') +
          ') is not on whole pixels or lies outside the work area (' +
          area.width +
          'x' +
          area.height +
          ')'
      )
    }
  }
  return { sample, steps, windows }
}

/**
 * The element a click lands on, from every element its selector matches (their boxes and trimmed
 * texts, in document order): exactly one visible match, its centre rounded to whole pixels.
 */
export function pickTarget(candidates, text) {
  const list = candidates
    .map((c, index) => ({ ...c, index }))
    .filter((c) => c.width > 0 && c.height > 0 && (!text || c.text.trim() === text))
  if (list.length !== 1) return { error: list.length + ' visible elements match' }
  const [c] = list
  return {
    index: c.index,
    x: Math.round(c.left + c.width / 2),
    y: Math.round(c.top + c.height / 2)
  }
}

/** What the page found at a click's centre: the target or a part of it, or what covers it. */
export function coveredError(hit, x, y) {
  if (hit.inside) return null
  return 'its centre (' + x + ', ' + y + ') is covered by ' + (hit.html ?? 'nothing')
}

/**
 * Where the pointer rests before the capture, so nothing in it is hovered. The references rest it
 * on the drawn taskbar, which the app does not draw; the page's own ground beside the windows has
 * no hover state either.
 */
export function restPoint(area, windows) {
  const left = Math.min(...windows.map((w) => w.x))
  const right = Math.max(...windows.map((w) => w.x + w.width))
  const y = Math.floor(area.height / 2)
  if (left >= 1) return { x: Math.floor(left / 2), y }
  if (right <= area.width - 1) return { x: right + Math.floor((area.width - right) / 2), y }
  throw new Error('golden: there is no point in the work area outside every window to rest on')
}

/** One box of a decoded image as an image of its own: compare-ref's --region crop. */
export function cropImage(img, r, name) {
  if (r.x + r.width > img.width || r.y + r.height > img.height) {
    throw new Error(
      '--region ' +
        [r.x, r.y, r.width, r.height].join(',') +
        ' does not fit inside ' +
        name +
        ' (' +
        img.width +
        'x' +
        img.height +
        ')'
    )
  }
  const out = Buffer.alloc(r.width * r.height * 4)
  for (let y = 0; y < r.height; y++) {
    const from = ((r.y + y) * img.width + r.x) * 4
    img.data.copy(out, y * r.width * 4, from, from + r.width * 4)
  }
  return { width: r.width, height: r.height, data: out }
}

/** compare-ref's clusters, largest first, where they lie in the window: for a failing state. */
export function clusterSummary(found, limit = 3) {
  if (!found.length) return 'none'
  const shown = found
    .slice(0, limit)
    .map((c) => c.pixels + 'px in ' + c.width + 'x' + c.height + ' at x ' + c.x + ', y ' + c.y)
  const more = found.length - shown.length
  return shown.join('; ') + (more > 0 ? '; and ' + more + ' more' : '')
}
