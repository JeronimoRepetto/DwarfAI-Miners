// The double runs the same conformance suite as FsGitRepoInspector (16 §2.8, 17 §1.3), over the
// ADR-030 fixture trees planted in a FakeFs, once in Windows path rules and once in POSIX rules,
// on every host.
import { describe } from 'vitest'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { FakeFs } from '../../../kernel/fakes/FakeFs'
import { gitFixtureTrees } from '../adapters/__fixtures__/git/trees'
import { caseFoldFor, type PathStyle } from '../domain/minePath'
import { runGitRepoInspectorContract } from './gitRepoInspector.contract'
import { FakeGitRepoInspector } from '../ports/fakes/FakeGitRepoInspector'

/** Synthetic roots (privacy-guard): no real user, home or host name. */
const ROOTS: Readonly<Record<PathStyle, string>> = { win32: 'C:\\work', posix: '/work' }

describe('FakeGitRepoInspector', () => {
  for (const style of ['win32', 'posix'] as const) {
    runGitRepoInspectorContract('FakeGitRepoInspector over FakeFs', style, async () => {
      const root = ROOTS[style]
      const sep = style === 'win32' ? '\\' : '/'
      const at = (relative: string): string => [root, ...relative.split('/')].join(sep)
      const fs = new FakeFs()
      for (const entry of gitFixtureTrees(root, style)) {
        if (entry.text === undefined) await fs.makeDir(at(entry.path))
        else fs.addFile(at(entry.path), entry.text)
      }
      const clock = new FakeClock(0)
      // The Windows run stands for a default NTFS folder, which folds case; the POSIX run for a
      // folder the S-030-1 detection cannot answer, which never folds.
      const caseFold = caseFoldFor(style === 'win32' ? 'case-insensitive' : 'unknown')
      const inspector = new FakeGitRepoInspector({ fs, clock, style, caseFold })
      return {
        inspector,
        style,
        caseFold,
        root,
        write: async (relative, text, mtimeMs) => fs.addFile(at(relative), text, mtimeMs),
        makeUnreadable: async (relative) => fs.scriptFault(at(relative), 'EACCES'),
        remove: async (relative) => fs.removeFile(at(relative)),
        link: async (link, target) => inspector.link(at(link), at(target)),
        advance: (ms) => clock.advance(ms)
      }
    })
  }
})
