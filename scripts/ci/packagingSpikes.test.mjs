// layer: L7
import { describe, expect, it } from 'vitest'
import {
  dictionaryRequests,
  hostsOf,
  netLogUrls,
  nextPatchVersion,
  scoopManifest,
  scrubText
} from './packagingSpikes.mjs'

describe('packaging spike lane helpers (ISSUE-328)', () => {
  it('[S-027-3] the upgrade build takes the next patch version, dropping any pre-release tag', () => {
    expect(nextPatchVersion('0.13.1')).toBe('0.13.2')
    expect(nextPatchVersion('1.0.0-beta.3')).toBe('1.0.1')
    expect(() => nextPatchVersion('one')).toThrow(/not a semantic version/)
  })

  it('[S-027-1] writes a Scoop manifest for a local zip whose hooks log the variables scoop gives them', () => {
    const manifest = scoopManifest({
      version: '0.13.1',
      url: 'http://127.0.0.1:4567/DwarfAI-Miners-0.13.1-win-x64.zip',
      hash: 'ab'.repeat(32),
      executable: 'DwarfAI-Miners.exe',
      hookLog: 'C:\\evidence\\hooks.log'
    })
    expect(manifest).toMatchObject({
      version: '0.13.1',
      url: 'http://127.0.0.1:4567/DwarfAI-Miners-0.13.1-win-x64.zip',
      hash: 'ab'.repeat(32),
      shortcuts: [['DwarfAI-Miners.exe', 'DwarfAI-Miners']]
    })
    for (const hook of ['pre_install', 'post_install', 'pre_uninstall', 'post_uninstall']) {
      const script = manifest[hook].join('\n')
      expect(script, hook).toContain(`'${hook}'`)
      expect(script, hook).toContain("'C:\\evidence\\hooks.log'")
      expect(script, hook).toContain('$cmd')
    }
    expect(() =>
      scoopManifest({ version: '1', url: 'u', hash: 'h', executable: 'a.exe', hookLog: "it's" })
    ).toThrow(/quote/)
  })

  it('[S-019-3] reads the request URLs of a net log, even one cut off when the app was ended', () => {
    const log =
      '{"constants":{},"events":[{"params":{"url":"https://redirector.gvt1.com/edgedl/chrome/dict/en-us-10-1.bdic"}},' +
      '{"params":{"url":"devtools://devtools/bundled"}},{"params":{"url":"https://redirector.gvt1.com/edgedl/chrome/dict/en-us-10-1.bdic"}},' +
      '{"params":{"url":"https://example.org/a?b=1"'
    const urls = netLogUrls(log)
    expect(urls).toEqual([
      'https://redirector.gvt1.com/edgedl/chrome/dict/en-us-10-1.bdic',
      'devtools://devtools/bundled',
      'https://example.org/a?b=1'
    ])
    expect(dictionaryRequests(urls)).toEqual([
      'https://redirector.gvt1.com/edgedl/chrome/dict/en-us-10-1.bdic'
    ])
    expect(hostsOf(urls)).toEqual(['example.org', 'redirector.gvt1.com'])
  })

  it('[S-019-3] scrubs the runner home folder and user name from evidence text, in both path spellings', () => {
    const text =
      'C:\\Users\\dwarfai-ci\\AppData\\x and "C:\\\\Users\\\\dwarfai-ci\\\\y" by dwarfai-ci'
    expect(
      scrubText(text, [
        ['C:\\Users\\dwarfai-ci', '<home>'],
        ['dwarfai-ci', '<user>']
      ])
    ).toBe('<home>\\AppData\\x and "<home>\\\\y" by <user>')
  })
})
