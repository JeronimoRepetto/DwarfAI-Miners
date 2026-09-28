/*
 * The UI kit stage every reference image is framed by, built at run time from the design
 * repository's own `prototype/kit.css` and `prototype/foundations/tokens.css`. Never copied into
 * this repository (PO ruling G-04, 2026-09-26): the design's docs ("How a reference image is
 * framed") name the stage rule and the framing classes, and this reads exactly those rules.
 *
 * Token references are written in place as their values, so the stage paints the design's rock
 * while no design custom property is declared anywhere a component under test could inherit it:
 * a golden must grade the app's own tokens, not the design's leaking in through the frame.
 * A missing rule or an undefined token throws: the design repository changed shape, and a stage
 * framed from a guess would grade against nothing.
 */
import fs from 'node:fs'
import path from 'node:path'

export const FRAMING_SELECTORS = [
  '.kit-stage',
  '.kit-scene',
  '.kit-row',
  '.kit-plate',
  '.kit-swatches',
  '.kit-swatch',
  '.kit-swatch__chip',
  '.kit-tokens',
  '.kit-token'
]

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '')
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function tokens(tokensCss) {
  const map = new Map()
  for (const m of stripComments(tokensCss).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    map.set(m[1], m[2].trim())
  }
  return map
}

function resolve(value, map, seen = new Set()) {
  return value.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_, name) => {
    if (!map.has(name) || seen.has(name)) {
      throw new Error('stage CSS: the token ' + name + ' is not defined in tokens.css')
    }
    return resolve(map.get(name), map, new Set([...seen, name]))
  })
}

export function stageCss(kitCss, tokensCss) {
  const kit = stripComments(kitCss)
  const map = tokens(tokensCss)
  return FRAMING_SELECTORS.map((selector) => {
    const m = new RegExp('(?:^|[}\\n])\\s*' + escape(selector) + '\\s*\\{([^}]*)\\}').exec(kit)
    if (!m) throw new Error('stage CSS: kit.css has no ' + selector + ' rule')
    const body = m[1]
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => '  ' + resolve(d, map) + ';')
      .join('\n')
    return selector + ' {\n' + body + '\n}'
  }).join('\n')
}

export function readStageCss(designRoot) {
  const read = (...parts) => fs.readFileSync(path.join(designRoot, ...parts), 'utf8')
  return stageCss(read('prototype', 'kit.css'), read('prototype', 'foundations', 'tokens.css'))
}
