// P-08 (`20` §2.3; HR B1): artifact names contain no spaces, which holds while `productName` is `DwarfAI-Miners`.
// Every top-level entry of the artifact folder is checked, the installers and archives and whatever else
// electron-builder wrote beside them, and a folder with no artifact at all fails, so a broken build never passes.
import { readdir } from 'node:fs/promises'

export const id = 'P-08'

/** The file extensions of the artifacts of `20` §3.2, on every OS. */
const ARTIFACT = /\.(exe|zip|dmg|AppImage|deb)$/

export default async function check({ artifactDir }) {
  const entries = await readdir(artifactDir, { withFileTypes: true })
  const artifacts = entries.filter((entry) => entry.isFile() && ARTIFACT.test(entry.name))
  if (artifacts.length === 0) return { ok: false, detail: `no artifact in ${artifactDir}` }
  const spaced = entries
    .filter((entry) => /\s/.test(entry.name))
    .map((entry) => JSON.stringify(entry.name))
  if (spaced.length > 0) return { ok: false, detail: `names with a space: ${spaced.join(', ')}` }
  return { ok: true, detail: `${artifacts.length} artifact names without spaces` }
}
