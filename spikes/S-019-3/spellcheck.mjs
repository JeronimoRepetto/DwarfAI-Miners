#!/usr/bin/env node
// Spike S-019-3 (ADR-019 D1; NFR-SEC-11; spike register S-019-3): does Electron 44 fetch spellcheck dictionaries, and
// does the composer spellcheck keep working when the download URL cannot be reached? Two parts:
//
//   node spikes/S-019-3/spellcheck.mjs probe --out <dir>
//   node spikes/S-019-3/spellcheck.mjs packaged (--app <executable|AppImage> | --find <dir>) --out <dir> [--seconds 30] [--allow-local]
//
// `probe` runs spellcheckProbe.cjs with the repository's Electron (the version the product ships) in the modes `off`,
// `on`, `on-unreachable` and `cached-unreachable`, each with a Chromium net log (`--log-net-log`), and records the
// session's requests, the dictionary events, and whether a misspelled word is still reported. It runs no product code.
//
// `packaged` starts the packaged product (spellcheck off today, the interim value of ADR-019 item 1) with a net log for
// `--seconds`, then ends it and its Host, and lists every URL and host it requested, flagging dictionary requests. It
// clears the DwarfAI state of the current user first and after (CI only unless --allow-local).
//
// The manual procedure with a traffic capture (17 §4: "manual with traffic capture") is spellcheck-traffic.md; this
// harness is its automated half. Writes `<out>/S-019-3-probe.json` or `<out>/S-019-3-packaged.json`.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dictionaryRequests, hostsOf, netLogUrls } from '../../scripts/ci/packagingSpikes.mjs'
import {
  assertDisposable,
  clearState,
  environmentFacts,
  killTree,
  launch,
  options,
  PLATFORM,
  readHostIdentity,
  resolveApp,
  writeEvidence
} from '../_packaged/kit.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function netLogSummary(file) {
  if (!existsSync(file)) return { written: false }
  const urls = netLogUrls(readFileSync(file, 'utf8'))
  return {
    written: true,
    urls: urls.length,
    hosts: hostsOf(urls),
    dictionaryRequests: dictionaryRequests(urls)
  }
}

function probe(out) {
  const electron = createRequire(import.meta.url)('electron')
  const work = mkdtempSync(path.join(tmpdir(), 'dwarfai-s0193-'))
  const cachedProfile = path.join(work, 'profile-on')
  const runs = []
  try {
    for (const mode of ['off', 'on', 'on-unreachable', 'cached-unreachable']) {
      const profile =
        mode === 'cached-unreachable' ? cachedProfile : path.join(work, `profile-${mode}`)
      mkdirSync(profile, { recursive: true })
      const reportFile = path.join(work, `${mode}.json`)
      const netLog = path.join(work, `${mode}.netlog.json`)
      // The Linux runner has no user namespaces for Chromium's sandbox; the probe is not the product.
      const sandbox = PLATFORM === 'linux' ? ['--no-sandbox'] : []
      const result = spawnSync(
        electron,
        [
          ...sandbox,
          `--log-net-log=${netLog}`,
          path.join(HERE, 'spellcheckProbe.cjs'),
          reportFile,
          mode,
          profile
        ],
        { encoding: 'utf8', timeout: 90000 }
      )
      const report = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf8')) : null
      runs.push({
        mode,
        exitCode: result.status,
        stderrTail: (result.stderr ?? '').split('\n').slice(-15).join('\n'),
        report: report && {
          ...report,
          requests: report.requests.length,
          requestHosts: hostsOf(report.requests),
          dictionaryRequests: dictionaryRequests(report.requests)
        },
        netLog: netLogSummary(netLog)
      })
      const seen = report?.contextMenu?.misspelledWord
      console.log(
        `S-019-3 probe ${mode}: misspelled word reported: ${seen ? JSON.stringify(seen) : 'none'}; ` +
          `dictionary events: ${report?.dictionaryEvents.map((e) => e.event).join(',') || 'none'}; ` +
          `dictionary requests: ${runs.at(-1).netLog.dictionaryRequests?.length ?? 0}`
      )
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  writeEvidence(out, 'S-019-3-probe', {
    spike: 'S-019-3',
    part: 'probe',
    environment: environmentFacts(),
    runs
  })
  return runs.every((run) => run.report !== null) ? 0 : 1
}

async function packaged(args, app) {
  const seconds = Number(args.seconds ?? 30)
  const appDirs = [path.dirname(app)]
  const work = mkdtempSync(path.join(tmpdir(), 'dwarfai-s0193-app-'))
  const netLog = path.join(work, 'packaged.netlog.json')
  const cleared = await clearState({ appDirs })
  const run = launch(app, [`--log-net-log=${netLog}`], {
    logFile: path.join(args.out, 'logs', 'S-019-3-packaged.log')
  })
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
  const identity = readHostIdentity()
  killTree(run.child.pid)
  if (identity) killTree(identity.pid)
  run.flushLog()
  const summary = netLogSummary(netLog)
  writeEvidence(args.out, 'S-019-3-packaged', {
    spike: 'S-019-3',
    part: 'packaged',
    environment: environmentFacts(),
    app: path.basename(app),
    seconds,
    hostStarted: Boolean(identity),
    cleared,
    netLog: summary,
    clearedAfter: await clearState({ appDirs })
  })
  rmSync(work, { recursive: true, force: true })
  console.log(
    `S-019-3 packaged: net log ${summary.written ? 'written' : 'NOT written'}; hosts: ` +
      `${summary.hosts?.join(', ') || 'none'}; dictionary requests: ${summary.dictionaryRequests?.length ?? 0}`
  )
  return summary.written ? 0 : 1
}

async function main() {
  const argv = process.argv.slice(2)
  const args = options(argv)
  const [part] = args._
  if (!args.out || (part !== 'probe' && part !== 'packaged')) {
    console.error('usage: spellcheck.mjs probe|packaged --out <dir> [--app <path>]')
    return 2
  }
  if (part === 'probe') return probe(args.out)
  assertDisposable(argv)
  const app = resolveApp(args)
  if (!app) {
    console.error('packaged needs --app <path> or --find <dir> holding a packed app')
    return 2
  }
  return packaged(args, app)
}

process.exitCode = await main()
