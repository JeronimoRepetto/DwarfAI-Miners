/*
 * The golden states contract (#634). `src/renderer/src/golden/states.json` lists every state a
 * golden covers: its manifest key, its UI kit cell, and, while the app has not rebuilt it yet, a
 * `red` reason. `renders.ts` beside it draws the real component for each key.
 *
 * A red state is an expected failure that must flip: it passes the run while its verdict fails,
 * reporting why, and FAILS the run the moment its verdict passes, so a rebuilt state cannot stay
 * marked red. Removing `red` is the flip.
 *
 * The framing a state needs beyond the stage (a component's "UI kit framing" rules, such as a
 * fixed height the kit gives a column) is read from the design's docs at run time, like the stage
 * CSS, and only for the component's root element: a rule for any other element is refused rather
 * than placed by guess. Pure; the golden test reads the files and calls these.
 */

export const CELL_WIDTHS = { standard: 404, wide: 822, full: 1240 }

export function checkStates(states, manifest) {
  const problems = []
  const seen = new Set()
  const repeated = new Set()
  for (const state of states) {
    const row = manifest[state.key]
    if (seen.has(state.key)) {
      if (!repeated.has(state.key)) problems.push(state.key + ' is listed more than once')
      repeated.add(state.key)
      continue
    }
    seen.add(state.key)
    if (!row) {
      problems.push(state.key + ' is not in the manifest')
      continue
    }
    const width = CELL_WIDTHS[state.cell]
    if (width === undefined) {
      problems.push(state.key + ' has an unknown cell ' + JSON.stringify(state.cell))
    } else if (!row.widened && row.width !== width) {
      problems.push(
        state.key +
          ' is ' +
          row.width +
          'px wide in the manifest, not a ' +
          state.cell +
          ' cell (' +
          width +
          'px)'
      )
    }
    if ('red' in state && !(typeof state.red === 'string' && state.red.trim())) {
      problems.push(state.key + ' is marked red without a reason')
    }
  }
  return problems
}

// A widened stage was let out to its content's width (the design's "Widened"): null asks the page
// for max-content instead of a cell width.
export function stageWidth(state, row) {
  return row.widened ? null : CELL_WIDTHS[state.cell]
}

export function componentOf(key) {
  return key.split('#')[0]
}

// The component's section of components.md runs from its anchor to the next level-3 heading after
// its own; its "UI kit framing" table lists `| \`selector\` | declarations |` rows.
export function framingFor(componentsMd, component) {
  const anchor = '<a id="' + component.replace(/\//g, '-') + '"></a>'
  const start = componentsMd.indexOf(anchor)
  if (start < 0) throw new Error('framing: components.md does not describe ' + component)
  const heading = componentsMd.indexOf('\n### ', start)
  const next = heading < 0 ? -1 : componentsMd.indexOf('\n### ', heading + 1)
  const section = componentsMd.slice(start, next < 0 ? undefined : next)
  const at = section.indexOf('**UI kit framing**')
  if (at < 0) return []
  const rules = []
  for (const line of section.slice(at).split(/\r?\n/).slice(1)) {
    if (!line.trim()) {
      if (rules.length) break
      continue
    }
    const m = /^\|\s*`([^`]+)`\s*\|\s*(.*?)\s*\|\s*$/.exec(line)
    if (m) rules.push({ selector: m[1], declarations: m[2] })
    else if (!line.startsWith('|')) break
  }
  return rules
}

// anatomy.md gives each state's element tree in a text block after the line linking its image.
export function anatomyRoot(anatomyMd, file) {
  const lines = anatomyMd.split(/\r?\n/)
  const at = lines.findIndex((l) => l.includes('(reference/' + file + ')'))
  const fence = at < 0 ? -1 : lines.findIndex((l, i) => i > at && l.startsWith('```'))
  if (fence < 0 || !lines[fence + 1]) {
    throw new Error('framing: anatomy.md has no element tree for reference/' + file)
  }
  return lines[fence + 1].trim()
}

export function checkFraming(framing, rootLine) {
  const classes = rootLine.split(/\s/)[0].split('.').slice(1)
  const stray = framing.filter(
    (r) => !/^\.[\w-]+$/.test(r.selector) || !classes.includes(r.selector.slice(1))
  )
  if (!stray.length) return null
  return (
    'framing: ' +
    stray.map((r) => r.selector).join(', ') +
    ' frames an element other than the root (' +
    rootLine +
    '); the harness places framing on the root only'
  )
}

const plural = (n, one, many = one + 's') => n + ' ' + (n === 1 ? one : many)

// The acceptance rule's third half (zero guess notes) and the capture's own validity (nothing the
// image cannot show), added to the pixel verdict.
export function accept(verdict, { notes, escaped, outside }) {
  const reasons = [...verdict.reasons]
  if (notes) reasons.push(plural(notes, 'guess note') + ' (.dm-note) on the build')
  if (escaped) reasons.push(plural(escaped, 'element') + ' drawn outside the stage')
  if (outside) reasons.push(plural(outside, 'element') + ' added to the page outside the stage')
  return { pass: reasons.length === 0, percent: verdict.percent, reasons }
}

const describeVerdict = (v) =>
  v.percent.toFixed(3) + '% differing' + (v.reasons.length ? '; ' + v.reasons.join('; ') : '')

export function expectation(state, verdict) {
  if (state.red) {
    return verdict.pass
      ? {
          ok: false,
          message:
            state.key +
            ' is marked red but now passes (' +
            describeVerdict(verdict) +
            '): remove "red" from states.json to flip it to green.'
        }
      : { ok: true, message: state.key + ' is red as expected: ' + describeVerdict(verdict) }
  }
  return verdict.pass
    ? { ok: true, message: state.key + ' passes: ' + describeVerdict(verdict) }
    : { ok: false, message: state.key + ' fails: ' + describeVerdict(verdict) }
}
