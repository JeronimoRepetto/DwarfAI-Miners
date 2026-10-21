#!/usr/bin/env node
// The `gh release create` flags of a release tag (20 §2.1 `release`; ISSUE-278; owner decision 2026-10-20).
//
//   node scripts/release/release-tag.mjs <tag>   prints the flags for <tag>, checked against package.json `version`
//
// The Release is published, never a draft. A plain `vX.Y.Z` tag is marked Latest; a tag with a pre-release suffix
// (`vX.Y.Z-rc.1` and so on) is a pre-release and never Latest. The tag must name exactly package.json's version, so
// the installers, which carry that version in their names, belong to the Release they are attached to. Anything
// else is refused with the reason, before anything is published.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TAG = /^v(\d+\.\d+\.\d+)(-[0-9A-Za-z][0-9A-Za-z.-]*)?$/

/** The flags of `tag`, or an error when it is not `vX.Y.Z[-suffix]` or not `v<version>`. */
export function releaseFlags(tag, version) {
  const match = TAG.exec(tag)
  if (match === null) throw new Error(`the tag ${tag} is not vX.Y.Z or vX.Y.Z-<pre-release>`)
  if (tag !== `v${version}`) {
    throw new Error(`the tag ${tag} does not match package.json version ${version}`)
  }
  return match[2] === undefined ? ['--latest'] : ['--prerelease', '--latest=false']
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tag] = process.argv.slice(2)
  if (!tag) {
    console.error('usage: node scripts/release/release-tag.mjs <tag>')
    process.exit(2)
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  try {
    console.log(releaseFlags(tag, version).join(' '))
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
