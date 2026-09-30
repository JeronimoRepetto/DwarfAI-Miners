/// <reference types="vite/client" />
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * R9 and R8 for `contracts/text` (05 §5.1): every production module here imports only its own
 * folder and `zod`, and nothing in it needs Node or Electron, so the renderer can import it.
 *
 * The sources come in through Vite's own glob rather than `node:fs`, so this test itself stays
 * free of Node. The TypeScript scanner reads the imports, so a specifier inside a comment or a
 * string never counts and a dynamic `import()` or a `require()` always does.
 */
const sources: Record<string, string> = import.meta.glob(['./*.ts', '!./*.test.ts'], {
  query: '?raw',
  import: 'default',
  eager: true
})

const EXPECTED_MODULES = [
  './accelerator.ts',
  './consoleText.ts',
  './externalLink.ts',
  './heldSessionText.ts',
  './index.ts',
  './jsonText.ts',
  './truncate.ts'
]

/** Globals only Node provides: a module that reads one cannot run in the renderer. */
const NODE_ONLY_GLOBALS = new Set([
  'process',
  'Buffer',
  'require',
  'module',
  'exports',
  '__dirname',
  '__filename',
  'global',
  'setImmediate',
  'clearImmediate'
])

function specifiersOf(source: string): string[] {
  return ts.preProcessFile(source, true, true).importedFiles.map((file) => file.fileName)
}

function isOwnOrZod(specifier: string): boolean {
  return specifier === 'zod' || /^\.\/[^/]+$/.test(specifier)
}

function needsNodeOrElectron(specifier: string): boolean {
  return (
    specifier.startsWith('node:') || specifier === 'electron' || specifier.startsWith('electron/')
  )
}

/**
 * Identifiers that name a Node-only global. A member name (`x.process`) or an object key is not
 * one; a local binding that shadows such a global still counts, on purpose: it reads as one.
 */
function nodeGlobalsReadBy(fileName: string, source: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && NODE_ONLY_GLOBALS.has(node.text)) {
      const parent = node.parent
      const isMemberName = ts.isPropertyAccessExpression(parent) && parent.name === node
      const isKey =
        (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) && parent.name === node
      if (!isMemberName && !isKey) found.push(node.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

describe('contracts/text purity (R9)', () => {
  it('[R9] scans every module of the folder', () => {
    expect(Object.keys(sources).sort()).toEqual(EXPECTED_MODULES)
  })

  it('[R9] contracts/text imports nothing but zod and its own files', () => {
    const outside = Object.entries(sources).flatMap(([file, source]) =>
      specifiersOf(source)
        .filter((specifier) => !isOwnOrZod(specifier))
        .map((specifier) => `${file} -> ${specifier}`)
    )
    expect(outside).toEqual([])
  })

  it('[R8] every contracts/text module is importable by the renderer: no node:* and no electron import', () => {
    const offending = Object.entries(sources).flatMap(([file, source]) => [
      ...specifiersOf(source)
        .filter(needsNodeOrElectron)
        .map((specifier) => `${file} -> ${specifier}`),
      ...nodeGlobalsReadBy(file, source).map((name) => `${file} reads ${name}`)
    ])
    expect(offending).toEqual([])
  })
})
