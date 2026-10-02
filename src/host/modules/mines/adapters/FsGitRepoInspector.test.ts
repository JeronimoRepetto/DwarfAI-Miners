// FsGitRepoInspector over the real file system (L3, 17 §1.3): the conformance suite on a fresh
// temporary copy of the ADR-030 fixture trees per test, planted with plain file writes (never
// `git`), read through NodeFs and the OS realpath, with the host OS's path rules.
import { mkdir, mkdtemp, realpath, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../../kernel/domain/errors'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { NodeFs } from '../../../platform/fs/NodeFs'
import { caseFoldFor } from '../domain/minePath'
import { runGitRepoInspectorContract } from '../testing/gitRepoInspector.contract'
import { gitFixtureTrees } from './__fixtures__/git/trees'
import { FsGitRepoInspector } from './FsGitRepoInspector'
import { hostVolumeRules } from './volumeCase'

describe('FsGitRepoInspector', () => {
  const roots: string[] = []
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  const rules = hostVolumeRules()
  runGitRepoInspectorContract(
    'FsGitRepoInspector over a temporary directory',
    rules.style,
    async () => {
      // The real path: on Windows the temp folder can be an 8.3 short name, on macOS /var is a link.
      const root = await realpath(await mkdtemp(join(tmpdir(), 'dwarfai-git-')))
      roots.push(root)
      for (const entry of gitFixtureTrees(root, rules.style)) {
        const path = join(root, ...entry.path.split('/'))
        if (entry.text === undefined) {
          await mkdir(path, { recursive: true })
          continue
        }
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, entry.text)
      }
      const clock = new FakeClock(0)
      const inspector = new FsGitRepoInspector({
        fs: new NodeFs(),
        clock,
        style: rules.style,
        realpath: (path) => realpath(path).then(String, () => null),
        volumeCase: rules.volumeCase
      })
      const at = (relative: string): string => join(root, ...relative.split('/'))
      return {
        inspector,
        style: rules.style,
        caseFold: caseFoldFor(await rules.volumeCase(root)),
        root,
        write: async (relative, text, mtimeMs) => {
          await mkdir(dirname(at(relative)), { recursive: true })
          await writeFile(at(relative), text)
          await utimes(at(relative), mtimeMs / 1000, mtimeMs / 1000)
        },
        // A folder in the file's place: reading it as a file rejects on POSIX (EISDIR) and reads as
        // empty on Windows. A rejecting read on every host is the case below.
        makeUnreadable: async (relative) => {
          await unlink(at(relative))
          await mkdir(at(relative))
        },
        remove: (relative) => unlink(at(relative)),
        // A junction needs no privilege on Windows; elsewhere the type is ignored (a symlink).
        link: (link, target) => symlink(at(target), at(link), 'junction'),
        advance: (ms) => clock.advance(ms)
      }
    }
  )

  it('[ADR-030] a file system whose every read rejects answers own project and no head, never a throw', async () => {
    const refused = (): Promise<never> => Promise.reject(new Error('EACCES'))
    const inspector = new FsGitRepoInspector({
      fs: { stat: refused, readTextHead: refused },
      clock: new FakeClock(0),
      style: 'posix',
      realpath: refused,
      volumeCase: refused
    })

    await expect(inspector.resolve('/work/repo-wt')).resolves.toEqual({ mineKey: '/work/repo-wt' })
    await expect(inspector.head('/work/repo-wt')).resolves.toEqual({ kind: 'none' })
  })

  it('[ADR-030] a cwd that is not absolute is refused as a programming error', async () => {
    const inspector = new FsGitRepoInspector({
      fs: new NodeFs(),
      clock: new FakeClock(0),
      style: rules.style,
      realpath: (path) => realpath(path).then(String, () => null),
      volumeCase: rules.volumeCase
    })

    await expect(inspector.resolve('repo-wt')).rejects.toBeInstanceOf(HostInvariantError)
  })
})
