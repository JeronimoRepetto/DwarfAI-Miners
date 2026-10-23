// Shared by the packaged checks that read inside the app (P-02, P-04) or start it (P-06): where the packed apps of an
// artifact folder are and what their `app.asar` holds. Reads files only. Not a check: the runner discovers only
// `p<nn>-<name>.packaged.mjs`.
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { listAsarFiles, parseAsarHeader, readAsarFile } from './asar.mjs'

/** Folders that never hold an app's own `app.asar`: the unpacked tree and the Chromium frameworks. */
const NOT_SEARCHED = new Set(['app.asar.unpacked', 'node_modules', 'Frameworks'])

/**
 * Every `app.asar` under `artifactDir` (each `win-*unpacked` and `linux-*unpacked` folder's `resources/`, each macOS
 * `.app`'s `Contents/Resources/`), sorted. Symbolic links are never followed.
 */
export async function findAppAsars(artifactDir) {
  const found = []
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory() && !NOT_SEARCHED.has(entry.name)) await walk(full)
      else if (entry.isFile() && entry.name === 'app.asar') found.push(full)
    }
  }
  await walk(artifactDir)
  return found.sort()
}

/** An archive read whole: its packed files' paths and a reader for one of them as UTF-8 text. */
export async function openAsar(file) {
  const buffer = await readFile(file)
  const parsed = parseAsarHeader(buffer)
  const files = listAsarFiles(parsed.header)
  return {
    files,
    paths: files.filter((entry) => !entry.unpacked).map((entry) => entry.path),
    text: (filePath) => readAsarFile(buffer, parsed, filePath).toString('utf8')
  }
}

/** `file` relative to `artifactDir`, with `/` separators, for a check's detail line. */
export function relativeTo(artifactDir, file) {
  return path.relative(artifactDir, file).split(path.sep).join('/')
}
