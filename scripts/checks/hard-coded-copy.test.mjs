import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { parse as parseSfc } from 'vue/compiler-sfc'
import { describe, expect, it } from 'vitest'

/**
 * L7 static check of the copy dictionary (owner rule 2026-10-02): the files migrated to the dictionary
 * (`src/contracts/text/copy/`) show no hard-coded user-visible string. Every user-visible string there is a `t(key)`
 * lookup, so a change of language never has to hunt for text in a component or a menu builder.
 *
 * What counts as user-visible text, read with the TypeScript and Vue compilers so comments never count:
 * - a string or template literal holding a `⟦COPY NEEDED` marker, two words, or one capitalized word (`Cancel`);
 * - a Vue template's text with a letter in it, or a static `aria-label`, `title`, `placeholder`, `alt` or `label`.
 * Keys (`hostState.crashLoop.title`), ids (`stop-everything`), CSS classes and an Error's message (a developer's
 * diagnostic, never shown as copy) are none of these.
 *
 * Add a file here once its strings are migrated; the list only grows. The legacy screens migrate as each is rebuilt.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const MIGRATED = [
  'src/renderer/src/lib/hostConnection/hostStateMessage.ts',
  'src/renderer/src/components/hostConnection/HostStateMessage.vue',
  'src/renderer/src/composables/useHostConnection.ts',
  'src/renderer/src/composables/useStopEverything.ts',
  'src/renderer/src/components/stopEverything/StopEverythingConfirmation.vue',
  'src/ui-main/window/application/trayMenu.ts',
  'src/ui-main/window/adapters/ElectronWindows.ts'
]

const USER_VISIBLE_ATTRIBUTES = new Set(['aria-label', 'title', 'placeholder', 'alt', 'label'])

function isProse(text) {
  return text.includes('⟦') || /\p{L}\s+\p{L}/u.test(text) || /^\p{Lu}\p{Ll}+$/u.test(text.trim())
}

/** Whether a literal is a module name, a type or an Error's message (a developer's diagnostic), which no UI shows. */
function isCodeOnly(node) {
  const parent = node.parent
  return (
    ts.isImportDeclaration(parent) ||
    ts.isExportDeclaration(parent) ||
    ts.isExternalModuleReference(parent) ||
    ts.isLiteralTypeNode(parent) ||
    (ts.isNewExpression(parent) && /Error$/.test(parent.expression.getText())) ||
    (ts.isCallExpression(parent) &&
      parent.expression.kind === ts.SyntaxKind.ImportKeyword &&
      parent.arguments[0] === node)
  )
}

/** The user-visible literals of a script, as `line: text`. */
function proseInScript(fileName, source, lineOffset = 0) {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const found = []
  const visit = (node) => {
    const literal =
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    if (literal && !isCodeOnly(node) && isProse(node.text)) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
      found.push(`${line + 1 + lineOffset}: ${node.text}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

const NODE_ELEMENT = 1
const NODE_TEXT = 2
const NODE_ATTRIBUTE = 6

/** The user-visible text of a Vue template: text nodes and the static attributes a person reads or hears. */
function proseInTemplate(ast) {
  const found = []
  const visit = (node) => {
    if (node.type === NODE_TEXT && /\p{L}/u.test(node.content)) {
      found.push(`${node.loc.start.line}: ${node.content.trim()}`)
    }
    if (node.type === NODE_ELEMENT) {
      for (const prop of node.props) {
        if (
          prop.type === NODE_ATTRIBUTE &&
          USER_VISIBLE_ATTRIBUTES.has(prop.name) &&
          prop.value !== undefined &&
          /\p{L}/u.test(prop.value.content)
        ) {
          found.push(`${prop.loc.start.line}: ${prop.name}="${prop.value.content}"`)
        }
      }
    }
    for (const child of node.children ?? []) visit(child)
  }
  visit(ast)
  return found
}

/** Every user-visible string `source` hard-codes, as `line: text`. */
export function hardCodedCopy(fileName, source) {
  if (!fileName.endsWith('.vue')) return proseInScript(fileName, source)
  const { descriptor } = parseSfc(source, { filename: fileName })
  const found = []
  for (const block of [descriptor.script, descriptor.scriptSetup]) {
    if (block) found.push(...proseInScript(fileName, block.content, block.loc.start.line - 1))
  }
  if (descriptor.template?.ast) found.push(...proseInTemplate(descriptor.template.ast))
  return found
}

describe('hard-coded copy (owner rule 2026-10-02)', () => {
  it('finds what a person would read, in a script and in a template, and nothing in comments, keys or ids', () => {
    const script = [
      '// A comment: ⟦COPY NEEDED: never counts⟧',
      "import { t } from '@dwarfai/contracts'",
      "type Kind = 'two words'",
      "export const ok = [t('dialog.cancel'), 'stop-everything', 'dm-host-state__body', 'danger']",
      "export const label = 'Cancel'",
      'export const words = `Stop everything ${1}`',
      "export const marker = '⟦COPY NEEDED: open item label⟧'",
      "export function fail(): never { throw new Error('the Veta window is not built yet') }"
    ].join('\n')
    expect(hardCodedCopy('sample.ts', script)).toEqual([
      '5: Cancel',
      '6: Stop everything ',
      '7: ⟦COPY NEEDED: open item label⟧'
    ])

    const vue = [
      '<script setup lang="ts">',
      "const title = 'Host is down'",
      '</script>',
      '<template>',
      '  <p class="dm-x">{{ title }}</p>',
      '  <button aria-label="Close" data-x="two words">Retry</button>',
      '</template>'
    ].join('\n')
    expect(hardCodedCopy('Sample.vue', vue)).toEqual([
      '2: Host is down',
      '6: aria-label="Close"',
      '6: Retry'
    ])
  })

  it('the files migrated to the copy dictionary hard-code no user-visible string', () => {
    const found = MIGRATED.flatMap((file) =>
      hardCodedCopy(file, readFileSync(path.join(repoRoot, file), 'utf8')).map(
        (hit) => `${file}:${hit}`
      )
    )
    expect(found).toEqual([])
  })
})
