// Test support for the Windows OS lane (L8): the owner and the DACL of files and directories, every
// principal as its full SID (never an SDDL alias or a localized name, SP-05 finding 7).
//
// The reader is a small C# program compiled at test time by the .NET Framework compiler that ships
// with Windows (nothing is installed), like pipeAccessProbe.ts beside it, which the Windows x64 and
// arm64 runners already run. It reads each path through .NET's FileSystemSecurity, so no PowerShell
// starts and no module has to load: on the windows-11-arm runner Windows PowerShell's Get-Acl
// exceeded 30 s per call (PR #1114), while on a local x64 machine it took about 0.5 s with or
// without PSModulePath (Windows PowerShell rebuilds the default module path itself), so the module
// path was not the cause and the reader no longer depends on PowerShell at all.
//
// Every program runs through the Host's own query runner (execFile with an argv array, R17). Never
// imported by production (R14).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createQueryRunner } from '../../../process/NodeProcessControl'
import { windowsSystemTool } from '../../../process/probe/types'

/** NT AUTHORITY\SYSTEM. */
export const SYSTEM_SID = 'S-1-5-18'
/** BUILTIN\Administrators. */
export const ADMINISTRATORS_SID = 'S-1-5-32-544'

const TIMEOUT_MS = 30_000
const COMPILE_TIMEOUT_MS = 120_000

const READER_SOURCE = String.raw`
using System;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

static class AclReader {
  static int Main(string[] args) {
    var output = new StringBuilder();
    if (args[0] == "token") {
      var identity = WindowsIdentity.GetCurrent();
      bool elevated = new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
      output.Append("user " + identity.User.Value + "\n");
      output.Append("elevated " + (elevated ? "true" : "false") + "\n");
    } else {
      var sections = AccessControlSections.Access | AccessControlSections.Owner;
      for (int index = 1; index < args.Length; index++) {
        string path = args[index];
        FileSystemSecurity security = Directory.Exists(path)
          ? (FileSystemSecurity)new DirectorySecurity(path, sections)
          : new FileSecurity(path, sections);
        output.Append("path " + (index - 1) + "\n");
        output.Append("owner " + security.GetOwner(typeof(SecurityIdentifier)).Value + "\n");
        output.Append("protected " + (security.AreAccessRulesProtected ? "true" : "false") + "\n");
        foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
          output.Append("ace " + rule.AccessControlType + " " + (rule.IsInherited ? "inherited" : "own") +
                        " " + rule.IdentityReference.Value + "\n");
        }
      }
    }
    Console.Out.Write(output.ToString());
    return 0;
  }
}
`

export interface AclRule {
  sid: string
  type: 'Allow' | 'Deny'
  inherited: boolean
}

export interface AclView {
  owner: string
  /** The DACL is protected: it inherits nothing from the parent (SE_DACL_PROTECTED). */
  protected: boolean
  rules: AclRule[]
}

export interface WindowsAclReader {
  /** This process's user SID. */
  readonly user: string
  /** This process runs elevated (its token holds Administrators enabled). */
  readonly elevated: boolean
  /** The owner, protection and DACL entries of each of `paths`, in the same order. */
  read(paths: readonly string[]): Promise<AclView[]>
  dispose(): void
}

/** Compiles the reader and reads this process's token. Windows only. */
export async function createWindowsAclReader(): Promise<WindowsAclReader> {
  const run = createQueryRunner()
  const dir = mkdtempSync(join(tmpdir(), 'dwarfai-acl-reader-'))
  const source = join(dir, 'reader.cs')
  const exe = join(dir, 'reader.exe')
  writeFileSync(source, READER_SOURCE)
  const windir = process.env['WINDIR'] ?? 'C:\\Windows'
  const csc = join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  const compiled = await run(csc, ['/nologo', `/out:${exe}`, source], {
    timeoutMs: COMPILE_TIMEOUT_MS
  })
  if (!compiled.ok) {
    rmSync(dir, { recursive: true, force: true })
    throw new Error(`the ACL reader did not compile: ${compiled.cause}`)
  }
  const ask = async (args: string[]): Promise<string[]> => {
    const out = await run(exe, args, { timeoutMs: TIMEOUT_MS })
    if (!out.ok) throw new Error(`the ACL reader failed: ${out.cause}`)
    return out.stdout.split(/\r?\n/).filter((line) => line !== '')
  }
  const token = await ask(['token'])
  const user = /^user (S-1-[\d-]+)$/.exec(token[0] ?? '')?.[1]
  if (user === undefined)
    throw new Error(`the ACL reader printed no user SID: ${token.join(' | ')}`)
  return {
    user,
    elevated: token[1] === 'elevated true',
    async read(paths) {
      const views: AclView[] = []
      for (const line of await ask(['acl', ...paths])) {
        const current = views.at(-1)
        if (line.startsWith('path ')) views.push({ owner: '', protected: false, rules: [] })
        else if (current !== undefined && line.startsWith('owner ')) current.owner = line.slice(6)
        else if (current !== undefined && line.startsWith('protected '))
          current.protected = line === 'protected true'
        else {
          const ace = /^ace (Allow|Deny) (inherited|own) (S-1-[\d-]+)$/.exec(line)
          if (current === undefined || ace?.[1] === undefined || ace[3] === undefined) {
            throw new Error(`the ACL reader printed an unknown line: ${line}`)
          }
          current.rules.push({
            type: ace[1] as AclRule['type'],
            inherited: ace[2] === 'inherited',
            sid: ace[3]
          })
        }
      }
      if (views.length !== paths.length) {
        throw new Error(`the ACL reader read ${views.length} of ${paths.length} paths`)
      }
      return views
    },
    dispose: () => rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Grants `sid` an explicit read entry on `path` (inherited by children of a directory when
 * `inherit`): a third party the protection must remove. Through icacls of System32 by its full
 * path (no module, no shell), by SID, never a localized name.
 */
export async function grantRead(
  path: string,
  sid: string,
  options: { inherit: boolean }
): Promise<void> {
  const grant = options.inherit ? `*${sid}:(OI)(CI)R` : `*${sid}:R`
  const out = await createQueryRunner()(windowsSystemTool('icacls.exe'), [path, '/grant', grant], {
    timeoutMs: TIMEOUT_MS
  })
  if (!out.ok) throw new Error(`icacls /grant ${out.cause}`)
}
