import { describe, expect, it } from 'vitest'
import { FakeInstalledToolsReader } from '../ports/fakes/FakeInstalledToolsReader'

// The InstalledToolsReader double (16 §4.12; 16 §2.8 `Fake*`): a scripted detection cache. A test
// installs and uninstalls a tool between boots; the reader answers what was scripted last, and a
// caller cannot change the script through the answer.
describe('FakeInstalledToolsReader', () => {
  it('[US-SET-012.AC08] installed answers the scripted tools, nothing by default, and a later script replaces it', () => {
    const reader = new FakeInstalledToolsReader()
    expect(reader.installed()).toStrictEqual([])

    reader.script(['claude-hooks'])
    const answer = reader.installed()
    expect(answer).toStrictEqual(['claude-hooks'])
    answer.push('opencode-permissions')
    expect(reader.installed()).toStrictEqual(['claude-hooks'])

    reader.script(['claude-hooks', 'opencode-permissions'])
    expect(reader.installed()).toStrictEqual(['claude-hooks', 'opencode-permissions'])
  })
})
