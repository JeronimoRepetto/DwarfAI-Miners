// layer: L7
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SPIKE_IDS } from './spike-lane.mjs'

// The spike lane (.github/workflows/spikes.yml; docs/spikes-lane.md): hosted runners run the existing spike harnesses
// when the owner dispatches it, so the macOS and Linux rows of spike-results come from CI (17 §4). It must stay a
// manual, read-only, secret-free lane whose evidence expires within a week, like the other manual workflows.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (file) =>
  readFileSync(path.join(repoRoot, '.github', 'workflows', file), 'utf8').replace(/\r\n/g, '\n')
const workflow = read('spikes.yml')
/** The workflow without its comment lines, so prose never satisfies or trips a check. */
const code = workflow
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n')
/** Each step's text, from its `- ` to the next step of any job. */
const steps = code
  .split(/\n {6}- /)
  .slice(1)
  .map((step) => `- ${step}`)

describe('spike lane workflow', () => {
  it('[SP-16, SP-04, SP-03] runs only on a manual dispatch that names its spikes, never on a push or pull request', () => {
    const on = code.slice(code.indexOf('\non:'), code.indexOf('\npermissions:'))
    expect(on).toMatch(/\n {2}workflow_dispatch:\n/)
    expect(on).not.toMatch(/\n {2}(push|pull_request|pull_request_target|schedule|workflow_run):/)
    expect(on).toMatch(/\n {6}spikes:\n/)
  })

  it('[SP-16] the dispatch input reaches scripts through env only, never interpolated into a run script', () => {
    for (const step of steps.filter((s) => s.includes('${{ inputs.'))) {
      const run = step.slice(step.indexOf('run:'))
      expect(step.includes('run:') ? run : '', 'inputs only in env').not.toContain('${{ inputs.')
    }
  })

  it('[SP-16] holds contents: read only, pins every action by commit SHA and reads no secret or environment', () => {
    expect(code).toMatch(/\npermissions:\n {2}contents: read\n/)
    expect(code).not.toMatch(/:\s*write\b/)
    const uses = [...code.matchAll(/uses: (\S+)/g)].map((match) => match[1])
    expect(uses.length).toBeGreaterThan(0)
    for (const action of uses) expect(action, action).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/)
    expect(code).not.toMatch(/secrets\.|\n\s+environment:/)
  })

  it('[SP-16] installs the same exact pnpm as ci.yml, frozen', () => {
    const pnpm = (text) =>
      [...text.matchAll(/uses: pnpm\/setup@\S+[^\n]*\n\s+with:\n\s+version: (\S+)/g)].map(
        (m) => m[1]
      )
    const ours = pnpm(code)
    expect(ours.length).toBeGreaterThan(0)
    expect(new Set([...ours, ...pnpm(read('ci.yml'))]).size).toBe(1)
    for (const step of steps.filter((s) => s.includes('pnpm install'))) {
      expect(step).toContain('pnpm install --frozen-lockfile')
    }
  })

  it('[SP-16, SP-04, SP-03, SP-05, S-019-1, S-030-1, S-027-4] every spike the plan knows has a job that runs it', () => {
    for (const id of SPIKE_IDS) expect(code, id).toContain(`['${id}']`)
  })

  it('[SP-04, SP-03] packages only after the lockfile provider scan, and publishes nothing', () => {
    const at = steps.findIndex((step) => step.includes('run: pnpm package'))
    expect(at, 'a step packages').toBeGreaterThan(0)
    expect(steps[at - 1]).toContain('run: node scripts/release/lockfile-provider-scan.mjs')
    expect(code).not.toMatch(
      /gh release|softprops|--publish always|electron-builder.*--publish onTagOrDraft/
    )
  })

  it('[SP-16] uploads each evidence folder as a spike- artifact kept at most seven days', () => {
    const uploads = steps.filter((step) => step.includes('uses: actions/upload-artifact@'))
    expect(uploads.length).toBeGreaterThan(0)
    for (const upload of uploads) {
      expect(upload).toMatch(/\n\s+name: spike-/)
      expect(upload).toMatch(/\n\s+path: coverage\/spike-reports\//)
      const days = Number(upload.match(/\n\s+retention-days: (\d+)/)?.[1])
      expect(days, 'retention-days').toBeGreaterThan(0)
      expect(days, 'retention-days').toBeLessThanOrEqual(7)
    }
  })
})
