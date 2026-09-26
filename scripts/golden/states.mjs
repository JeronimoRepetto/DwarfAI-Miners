/*
 * The golden states contract (#634). `src/renderer/src/golden/states.json` lists every state a
 * golden covers: its manifest key and, while the app has not rebuilt it yet, a `red` reason.
 * `renders.ts` beside it draws the real component for each key. Where the stage sits and how wide
 * it is come from the key's manifest row alone, so a cell the design resizes needs no edit here.
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

const STATE_FIELDS = new Set(['key', 'red'])

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
    const unused = Object.keys(state).filter((f) => !STATE_FIELDS.has(f))
    if (unused.length) {
      problems.push(state.key + ' has a field states.json does not use: ' + unused.join(', '))
    }
    if ('red' in state && !(typeof state.red === 'string' && state.red.trim())) {
      problems.push(state.key + ' is marked red without a reason')
    }
  }
  return problems
}

// A widened stage was let out to its content's width (the design's "Widened"): null asks the page
// for max-content instead of the width the row records.
export function stageWidth(row) {
  return row.widened ? null : row.width
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

// The lines of the state's element tree: the text block after the line linking its image.
function anatomyTree(anatomyMd, file) {
  const lines = anatomyMd.split(/\r?\n/)
  const at = lines.findIndex((l) => l.includes('(reference/' + file + ')'))
  const open = at < 0 ? -1 : lines.findIndex((l, i) => i > at && l.startsWith('```'))
  const close = open < 0 ? -1 : lines.findIndex((l, i) => i > open && l.startsWith('```'))
  if (close < 0) throw new Error('anatomy.md has no element tree for reference/' + file)
  return lines.slice(open + 1, close)
}

// Past the `tag.class` selector and an optional `[attributes]` block, whose quoted values may
// hold a bracket: where a line's text, if any, starts.
function afterSelector(line) {
  let i = line.search(/\s|$/)
  if (line[i + 1] !== '[') return i
  let quoted = false
  for (i += 2; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted
    else if (line[i] === ']' && !quoted) return i + 1
  }
  return i
}

// Every text a state's tree shows, in DOM order, for the specimen captions the golden harness
// hands in at run time (the design lead's ruling on the tokens-port questions: no caption is
// committed). A plain text is `{ text }`; content the tree prints as `(innerHTML "…")`, a JSON
// string, is `{ html }`. A line ending `×N` stands for N identical siblings.
export function anatomyTexts(anatomyMd, file) {
  const texts = []
  for (const raw of anatomyTree(anatomyMd, file)) {
    const line = raw.trim()
    if (!line) continue
    const rest = line.startsWith('"') ? line : line.slice(afterSelector(line)).trim()
    const repeat = /\s×(\d+)$/.exec(rest)
    const body = repeat ? rest.slice(0, repeat.index).trim() : rest
    const html = /^\(innerHTML (".*")\)$/.exec(body)
    const text = /^"(.*)"$/.exec(body)
    const entry = html ? { html: JSON.parse(html[1]) } : text ? { text: text[1] } : null
    if (entry) for (let n = repeat ? Number(repeat[1]) : 1; n > 0; n--) texts.push({ ...entry })
  }
  return texts
}

// Every element of a state's tree with the attributes it prints, in DOM order, for a form
// control's design text (a placeholder, a value, an accessible name), handed in at run time like
// the texts so none is committed (#635). `name=value` and `name="quoted value"` keep their value;
// a bare name is present with no value, as `disabled` or an empty `placeholder` is. A line
// ending `×N` stands for N identical siblings.
export function anatomyAttributes(anatomyMd, file) {
  const elements = []
  for (const raw of anatomyTree(anatomyMd, file)) {
    const line = raw.trim()
    if (!line || line.startsWith('"')) continue
    const element = line.split(/\s/)[0]
    const end = afterSelector(line)
    const open = line.indexOf('[', element.length)
    const block = open >= 0 && open < end ? line.slice(open + 1, end - 1) : ''
    const attributes = {}
    for (const m of block.matchAll(/([^\s=]+)(?:=(?:"([^"]*)"|(\S+)))?/g)) {
      attributes[m[1]] = m[2] ?? m[3] ?? ''
    }
    const repeat = /\s×(\d+)$/.exec(line)
    for (let n = repeat ? Number(repeat[1]) : 1; n > 0; n--) {
      elements.push({ element, attributes: { ...attributes } })
    }
  }
  return elements
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
