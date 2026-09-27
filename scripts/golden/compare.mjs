/*
 * The golden verdict: the design repository's own `tools/compare-ref.js`, loaded at run time,
 * judged by the PO's acceptance rule for a rebuilt piece (the same size, under 1% of pixels
 * differing, no 3x3 cluster of differing pixels). `judge` mirrors compare-ref's own verdict so a
 * golden and the maintainer's command line never disagree; `loadCompareRef` supplies the
 * decoder, the pixel comparison and the cluster search themselves, never a copy of them.
 *
 * Every screenshot and diff goes to the system temp directory, never into the checkout: they are
 * pictures of the private references.
 */
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { cropImage } from './screens.mjs'

export const CLUSTER = 3
export const MAX_DIFF = 1

export function outputDir(tmpdir = os.tmpdir()) {
  return path.join(tmpdir, 'dwarfai-golden')
}

export function judge(stats, { maxDiff = MAX_DIFF, cluster = CLUSTER } = {}) {
  const percent = ((stats.differing + stats.uncovered) / stats.total) * 100
  const reasons = []
  if (stats.refWidth !== stats.candWidth || stats.refHeight !== stats.candHeight) {
    reasons.push(
      'the sizes differ (' +
        stats.candWidth +
        'x' +
        stats.candHeight +
        ' against ' +
        stats.refWidth +
        'x' +
        stats.refHeight +
        ')'
    )
  }
  if (!(percent < maxDiff)) reasons.push('differing pixels are not under ' + maxDiff + '%')
  if (stats.clusters) {
    reasons.push(
      stats.clusters +
        ' cluster' +
        (stats.clusters === 1 ? '' : 's') +
        ' of ' +
        cluster +
        'x' +
        cluster +
        ' or more'
    )
  }
  return { pass: reasons.length === 0, percent, reasons }
}

export function loadCompareRef(designRoot) {
  return createRequire(import.meta.url)(path.join(designRoot, 'tools', 'compare-ref.js'))
}

// Compares a captured PNG with a reference; writes the capture and the diff under outputDir().
export function compareToReference(designRoot, referenceFile, capturePng, name) {
  const tool = loadCompareRef(designRoot)
  const dir = outputDir()
  fs.mkdirSync(dir, { recursive: true })
  const safe = name.replace(/[^\w.-]+/g, '__')
  const candidateFile = path.join(dir, safe + '.png')
  const diffFile = path.join(dir, safe + '.diff.png')
  fs.writeFileSync(candidateFile, capturePng)
  const ref = tool.decode(referenceFile)
  const cand = tool.decode(candidateFile)
  const result = tool.compare(ref, cand, 0)
  const clusters = tool.clusters(result, CLUSTER)
  fs.writeFileSync(diffFile, tool.encode(result.diff))
  const stats = {
    refWidth: ref.width,
    refHeight: ref.height,
    candWidth: cand.width,
    candHeight: cand.height,
    differing: result.differing,
    uncovered: result.uncovered,
    total: result.total,
    clusters: clusters.length
  }
  return { stats, verdict: judge(stats), candidateFile, diffFile }
}

/*
 * One window of a full-screen reference (#635): the reference and a capture of the whole work area
 * both cut to the window's box, as compare-ref's --region cuts a screenshot of the whole screen.
 * The work area is the screen less its taskbar, so the capture is the reference's width and
 * shorter, and the box must fit inside both. The clusters come back whole, largest first, in the
 * window's coordinates, so a failing window can say where it differs.
 */
export function compareRegion(designRoot, referenceFile, screenPng, region, name) {
  const tool = loadCompareRef(designRoot)
  const dir = outputDir()
  fs.mkdirSync(dir, { recursive: true })
  const safe = name.replace(/[^\w.-]+/g, '__')
  const screenFile = path.join(dir, safe + '.screen.png')
  const candidateFile = path.join(dir, safe + '.png')
  const diffFile = path.join(dir, safe + '.diff.png')
  fs.writeFileSync(screenFile, screenPng)
  const ref = cropImage(tool.decode(referenceFile), region, referenceFile)
  const cand = cropImage(tool.decode(screenFile), region, screenFile)
  fs.writeFileSync(candidateFile, tool.encode(cand))
  const result = tool.compare(ref, cand, 0)
  const found = tool.clusters(result, CLUSTER)
  fs.writeFileSync(diffFile, tool.encode(result.diff))
  const stats = {
    refWidth: ref.width,
    refHeight: ref.height,
    candWidth: cand.width,
    candHeight: cand.height,
    differing: result.differing,
    uncovered: result.uncovered,
    total: result.total,
    clusters: found.length
  }
  return { stats, verdict: judge(stats), clusters: found, candidateFile, diffFile }
}
