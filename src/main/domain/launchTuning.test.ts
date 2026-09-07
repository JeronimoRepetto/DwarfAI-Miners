import { describe, expect, it } from 'vitest'
import { PROVIDER_EFFORT_LEVELS, parseLaunchTuning } from './launchTuning'

describe('PROVIDER_EFFORT_LEVELS', () => {
  /*
   * Verified live on 2026-09-07, and the two providers are verified from
   * different kinds of evidence, which is the reason the list is per provider
   * rather than one union.
   *
   * Claude Code 2.1.263 documents the levels in `claude --help` itself:
   * `--effort <level>  Effort level for the current session (low, medium,
   * high, xhigh, max)`. The Agent SDK agrees — `EffortLevel` is exactly those
   * five — so two independent sources say the same thing.
   */
  it("carries Claude's five documented levels, in the CLI's own order", () => {
    expect(PROVIDER_EFFORT_LEVELS.claude).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  /*
   * Codex documents none in help at all — `codex --help` and `codex exec
   * --help` on codex-cli 0.153.4 mention no reasoning-effort levels, only the
   * `-c key=value` override that carries one. What DOES state them is the
   * model catalogue the CLI keeps under its own home, whose per-model
   * `supported_reasoning_levels` union across the eight models it listed on
   * this machine is these six. So Codex has one more level than Claude, and
   * folding the two lists together would refuse a level Codex accepts.
   */
  it("carries Codex's six, which are not Claude's five", () => {
    expect(PROVIDER_EFFORT_LEVELS.codex).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
  })

  /*
   * Antigravity is an observer in this build (#237): it is absent from
   * LAUNCHABLE_PROVIDERS, so no launch reaches it. An empty list is the
   * honest entry rather than a borrowed one — see the refusal test below for
   * what an effort aimed at it does.
   */
  it('gives Antigravity none, because no launch can reach it', () => {
    expect(PROVIDER_EFFORT_LEVELS.antigravity).toEqual([])
  })
})

describe('parseLaunchTuning', () => {
  /*
   * The asymmetry `config-layering` states, applied to a launch request: an
   * ABSENT field is not an instruction, so it degrades to "leave it to the
   * CLI"; a PRESENT one that cannot be carried out is a legible instruction
   * that would be silently disobeyed, so it takes the whole request down.
   *
   * Which matters here more than in the config file, because the disobedience
   * is invisible: a launch that quietly dropped `effort: 'max'` starts a real
   * session at the CLI's own default and reports success, and nothing on
   * screen would ever say otherwise.
   */
  it('answers an empty request with no tuning at all, so the CLI keeps its defaults', () => {
    expect(parseLaunchTuning('claude', {})).toEqual({})
  })

  it('leaves both fields out when they are absent rather than defaulting them', () => {
    const tuning = parseLaunchTuning('claude', { mineId: 'mine-1', prompt: 'dig' })
    expect(tuning).not.toBeNull()
    expect(Object.keys(tuning!)).toEqual([])
  })

  it('carries a level the provider documents', () => {
    expect(parseLaunchTuning('claude', { effort: 'xhigh' })).toEqual({ effort: 'xhigh' })
  })

  it("carries a level of Codex's that Claude does not have", () => {
    expect(parseLaunchTuning('codex', { effort: 'ultra' })).toEqual({ effort: 'ultra' })
  })

  it('refuses the whole request for a level the chosen provider does not have', () => {
    // 'ultra' is real, and real for the OTHER provider. Checking against the
    // provider being launched is the whole point of a per-provider list.
    expect(parseLaunchTuning('claude', { effort: 'ultra' })).toBeNull()
  })

  it('refuses an invented level rather than dropping it', () => {
    expect(parseLaunchTuning('claude', { effort: 'maximum' })).toBeNull()
    expect(parseLaunchTuning('codex', { effort: 'ludicrous' })).toBeNull()
  })

  it('refuses any effort for a provider that has none', () => {
    expect(parseLaunchTuning('antigravity', { effort: 'high' })).toBeNull()
  })

  it('refuses a level that is not a string, whatever it looks like', () => {
    expect(parseLaunchTuning('claude', { effort: 3 })).toBeNull()
    expect(parseLaunchTuning('claude', { effort: ['high'] })).toBeNull()
    expect(parseLaunchTuning('claude', { effort: null })).toBeNull()
  })

  it('is case-sensitive, because the CLIs’ own enums are', () => {
    expect(parseLaunchTuning('claude', { effort: 'High' })).toBeNull()
  })

  it('trims a level, because a text box collects whitespace', () => {
    expect(parseLaunchTuning('claude', { effort: '  high  ' })).toEqual({ effort: 'high' })
  })

  /*
   * The model half is deliberately NOT closed here. No list of model names
   * lives in this repository — the guideline that model names come from the
   * provider live, never from source — so what a bare boundary can check is
   * the shape: a trimmed, non-empty string. Whether the name exists is the
   * question the catalogue answers, and it is asked where the catalogue is.
   *
   * Passed through unchanged, and never echoed back as a claim: nothing in the
   * launch verdict says which model started, because this side cannot know.
   */
  it('passes a model name through, trimmed', () => {
    expect(parseLaunchTuning('claude', { model: '  sonnet ' })).toEqual({ model: 'sonnet' })
  })

  it('passes a full wire id through unchanged, alias or not', () => {
    expect(parseLaunchTuning('claude', { model: 'claude-fable-5-1[1m]' })).toEqual({
      model: 'claude-fable-5-1[1m]'
    })
  })

  it('refuses a model that is present and empty, which is an instruction nobody can carry out', () => {
    expect(parseLaunchTuning('claude', { model: '   ' })).toBeNull()
    expect(parseLaunchTuning('claude', { model: '' })).toBeNull()
  })

  it('refuses a model that is not a string', () => {
    expect(parseLaunchTuning('claude', { model: { value: 'sonnet' } })).toBeNull()
  })

  it('carries both together when both are good', () => {
    expect(parseLaunchTuning('codex', { model: 'gpt-5.6-sol', effort: 'high' })).toEqual({
      model: 'gpt-5.6-sol',
      effort: 'high'
    })
  })

  it('refuses the pair when only one half is wrong, rather than keeping the good half', () => {
    // Half a tuning is a launch nobody asked for: the model would be honoured
    // and the effort silently dropped, at a cost the user cannot see.
    expect(parseLaunchTuning('codex', { model: 'gpt-5.6-sol', effort: 'nope' })).toBeNull()
  })
})
