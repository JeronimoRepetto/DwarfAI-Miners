// Test support for the Windows OS lane (L8): who may open a named pipe, asked of Windows itself.
//
// The method is spike SP-05's (spike-results/SP-05.md; spikes/SP-05/pipeAcl.os.test.ts): read the
// pipe's real security descriptor and ask `AuthzAccessCheck` (MAXIMUM_ALLOWED) what each principal
// would be granted. The principals are synthesized for the check (AUTHZ_SKIP_TOKEN_GROUPS), so no
// second account and no second machine are needed:
// - owner: this user as a local interactive logon (must keep access, or the check proves nothing);
// - otherUser: a user SID that is not the owner, with the groups every local logon has;
// - anonymous: Anonymous Logon, with Everyone and NETWORK;
// - remoteOwner, remoteOtherUser: the same users as network logons.
// A remote client is also tried for real through the SMB loopback (`\\127.0.0.1\pipe\<name>`),
// which PIPE_REJECT_REMOTE_CLIENTS refuses with ERROR_ACCESS_DENIED.
//
// The probe is a small C# program compiled at test time by the .NET Framework compiler that ships
// with Windows (nothing is installed), like SP-05's harness. Never imported by production (R14).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createQueryRunner } from '../../../process/NodeProcessControl'

const PROBE_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;

static class PipeAccessProbe {
  [StructLayout(LayoutKind.Sequential)] struct LUID { public uint Low; public int High; }
  [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct AUTHZ_ACCESS_REQUEST {
    public uint DesiredAccess; public IntPtr PrincipalSelfSid; public IntPtr ObjectTypeList;
    public uint ObjectTypeListLength; public IntPtr OptionalArguments;
  }
  [StructLayout(LayoutKind.Sequential)] struct AUTHZ_ACCESS_REPLY {
    public uint ResultListLength; public IntPtr GrantedAccessMask; public IntPtr SaclEvaluationResults; public IntPtr Error;
  }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("advapi32.dll")]
  static extern uint GetSecurityInfo(IntPtr handle, int type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl, out IntPtr sd);
  [DllImport("advapi32.dll")] static extern int GetSecurityDescriptorLength(IntPtr sd);
  [DllImport("authz.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool AuthzInitializeResourceManager(uint flags, IntPtr access, IntPtr compute, IntPtr free, string name, out IntPtr manager);
  [DllImport("authz.dll", SetLastError = true)]
  static extern bool AuthzInitializeContextFromSid(uint flags, byte[] sid, IntPtr manager, IntPtr expiration, LUID identifier, IntPtr args, out IntPtr context);
  [DllImport("authz.dll", SetLastError = true)]
  static extern bool AuthzAddSidsToContext(IntPtr context, SID_AND_ATTRIBUTES[] sids, uint count, IntPtr restricted, uint restrictedCount, out IntPtr newContext);
  [DllImport("authz.dll", SetLastError = true)]
  static extern bool AuthzAccessCheck(uint flags, IntPtr context, ref AUTHZ_ACCESS_REQUEST request, IntPtr audit, IntPtr sd, IntPtr optional, uint optionalCount, ref AUTHZ_ACCESS_REPLY reply, IntPtr handle);
  [DllImport("authz.dll")] static extern bool AuthzFreeContext(IntPtr context);
  [DllImport("authz.dll")] static extern bool AuthzFreeResourceManager(IntPtr manager);

  const uint READ_CONTROL = 0x20000, OWNER_GROUP_DACL = 0x7, MAXIMUM_ALLOWED = 0x02000000;

  static int Main(string[] args) {
    switch (args[0]) {
      case "sid": Console.WriteLine(WindowsIdentity.GetCurrent().User.Value); return 0;
      case "handles": Console.WriteLine(Process.GetProcessById(int.Parse(args[1])).HandleCount); return 0;
      case "open": return Open(args[1], Convert.ToUInt32(args[2], 16));
      case "check": return Check(args);
    }
    return 2;
  }

  // open <path> <access hex>: "ok", or "error <Win32 error>".
  static int Open(string path, uint access) {
    IntPtr handle = CreateFileW(path, access, 0, IntPtr.Zero, 3, 0, IntPtr.Zero);
    if (handle == new IntPtr(-1)) { Console.WriteLine("error " + Marshal.GetLastWin32Error()); return 0; }
    CloseHandle(handle);
    Console.WriteLine("ok");
    return 0;
  }

  // check <pipe> <name>=<userSid>,<groupSid>,... : protected, the entries with resolved SIDs, and
  // what each principal is granted. The pipe is opened as a client with READ_CONTROL only.
  static int Check(string[] args) {
    IntPtr handle = CreateFileW(args[1], READ_CONTROL, 0, IntPtr.Zero, 3, 0, IntPtr.Zero);
    if (handle == new IntPtr(-1)) { Console.WriteLine("error CreateFile " + Marshal.GetLastWin32Error()); return 1; }
    IntPtr sd;
    uint status = GetSecurityInfo(handle, 6, OWNER_GROUP_DACL, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out sd);
    CloseHandle(handle);
    if (status != 0) { Console.WriteLine("error GetSecurityInfo " + status); return 1; }
    byte[] raw = new byte[GetSecurityDescriptorLength(sd)];
    Marshal.Copy(sd, raw, 0, raw.Length);
    RawSecurityDescriptor descriptor = new RawSecurityDescriptor(raw, 0);
    Console.WriteLine("protected " + (((descriptor.ControlFlags & ControlFlags.DiscretionaryAclProtected) != 0) ? "true" : "false"));
    if (descriptor.DiscretionaryAcl != null) {
      foreach (GenericAce generic in descriptor.DiscretionaryAcl) {
        KnownAce ace = generic as KnownAce;
        if (ace == null) { Console.WriteLine("ace other 0x00000000 S-1-0-0"); continue; }
        string type = ace.AceType == AceType.AccessAllowed ? "A" : ace.AceType == AceType.AccessDenied ? "D" : "other";
        Console.WriteLine("ace " + type + " 0x" + ((uint)ace.AccessMask).ToString("x8") + " " + ace.SecurityIdentifier.Value);
      }
    }
    IntPtr manager;
    if (!AuthzInitializeResourceManager(1, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, "dwarfai-probe", out manager)) {
      Console.WriteLine("error AuthzInitializeResourceManager " + Marshal.GetLastWin32Error()); return 1;
    }
    for (int i = 2; i < args.Length; i++) {
      string[] parts = args[i].Split('=');
      string[] sids = parts[1].Split(',');
      IntPtr context;
      if (!AuthzInitializeContextFromSid(2, Bytes(sids[0]), manager, IntPtr.Zero, new LUID(), IntPtr.Zero, out context)) {
        Console.WriteLine("error AuthzInitializeContextFromSid " + Marshal.GetLastWin32Error()); return 1;
      }
      SID_AND_ATTRIBUTES[] groups = new SID_AND_ATTRIBUTES[sids.Length - 1];
      List<IntPtr> buffers = new List<IntPtr>();
      for (int g = 1; g < sids.Length; g++) {
        byte[] bytes = Bytes(sids[g]);
        IntPtr buffer = Marshal.AllocHGlobal(bytes.Length);
        Marshal.Copy(bytes, 0, buffer, bytes.Length);
        buffers.Add(buffer);
        groups[g - 1].Sid = buffer; groups[g - 1].Attributes = 0x4;
      }
      IntPtr full;
      if (!AuthzAddSidsToContext(context, groups, (uint)groups.Length, IntPtr.Zero, 0, out full)) {
        Console.WriteLine("error AuthzAddSidsToContext " + Marshal.GetLastWin32Error()); return 1;
      }
      AUTHZ_ACCESS_REQUEST request = new AUTHZ_ACCESS_REQUEST(); request.DesiredAccess = MAXIMUM_ALLOWED;
      AUTHZ_ACCESS_REPLY reply = new AUTHZ_ACCESS_REPLY(); reply.ResultListLength = 1;
      reply.GrantedAccessMask = Marshal.AllocHGlobal(4); reply.Error = Marshal.AllocHGlobal(4);
      if (!AuthzAccessCheck(0, full, ref request, IntPtr.Zero, sd, IntPtr.Zero, 0, ref reply, IntPtr.Zero)) {
        Console.WriteLine("error AuthzAccessCheck " + Marshal.GetLastWin32Error()); return 1;
      }
      Console.WriteLine("granted " + parts[0] + " 0x" + ((uint)Marshal.ReadInt32(reply.GrantedAccessMask)).ToString("x8"));
      Marshal.FreeHGlobal(reply.GrantedAccessMask); Marshal.FreeHGlobal(reply.Error);
      foreach (IntPtr buffer in buffers) Marshal.FreeHGlobal(buffer);
      AuthzFreeContext(full); AuthzFreeContext(context);
    }
    AuthzFreeResourceManager(manager);
    LocalFree(sd);
    return 0;
  }

  static byte[] Bytes(string sid) {
    SecurityIdentifier id = new SecurityIdentifier(sid);
    byte[] bytes = new byte[id.BinaryLength];
    id.GetBinaryForm(bytes, 0);
    return bytes;
  }
}
`

/** Well-known SIDs of the groups a logon carries (Microsoft "Well-known SIDs"). */
export const WELL_KNOWN_SID = {
  everyone: 'S-1-1-0',
  local: 'S-1-2-0',
  consoleLogon: 'S-1-2-1',
  network: 'S-1-5-2',
  interactive: 'S-1-5-4',
  anonymous: 'S-1-5-7',
  authenticatedUsers: 'S-1-5-11',
  thisOrganization: 'S-1-5-15',
  system: 'S-1-5-18',
  users: 'S-1-5-32-545'
} as const

/** A user SID that is not the owner: the stand-in for a second local account (synthetic). */
export const OTHER_USER_SID = 'S-1-5-21-1000000001-1000000002-1000000003-1001'

const S = WELL_KNOWN_SID
const LOCAL_GROUPS = [
  S.everyone,
  S.local,
  S.consoleLogon,
  S.interactive,
  S.authenticatedUsers,
  S.thisOrganization,
  S.users
]
const NETWORK_GROUPS = [S.everyone, S.network, S.authenticatedUsers, S.thisOrganization, S.users]

export type Principal = 'owner' | 'otherUser' | 'anonymous' | 'remoteOwner' | 'remoteOtherUser'

export interface PipeAccessReport {
  protectedDacl: boolean
  /** Every entry of the DACL, with resolved SIDs (SDDL text abbreviates them, so it is never compared). */
  aces: Array<{ type: string; mask: number; sid: string }>
  granted: Record<Principal, number>
}

export interface PipeAccessProbe {
  readonly ownerSid: string
  check(pipe: string): Promise<PipeAccessReport>
  /** Opens `path` with `access`; `ok` or `error <Win32 error>`. */
  open(path: string, access: number): Promise<string>
  /** The handle count of process `pid`. */
  handleCount(pid: number): Promise<number>
  dispose(): void
}

const TIMEOUT_MS = 30_000

/** Compiles the probe and reads this user's SID. Windows only. */
export async function createPipeAccessProbe(): Promise<PipeAccessProbe> {
  const run = createQueryRunner()
  const dir = mkdtempSync(join(tmpdir(), 'dwarfai-probe-'))
  const source = join(dir, 'probe.cs')
  const exe = join(dir, 'probe.exe')
  writeFileSync(source, PROBE_SOURCE)
  const windir = process.env['WINDIR'] ?? 'C:\\Windows'
  const csc = join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  const compiled = await run(csc, ['/nologo', `/out:${exe}`, source], { timeoutMs: 120_000 })
  if (!compiled.ok) throw new Error(`the pipe access probe did not compile: ${compiled.cause}`)
  const ask = async (args: string[]): Promise<string> => {
    const out = await run(exe, args, { timeoutMs: TIMEOUT_MS })
    if (!out.ok) throw new Error(`the pipe access probe failed: ${out.cause}`)
    return out.stdout.trim()
  }
  const ownerSid = await ask(['sid'])
  const principals = [
    `owner=${[ownerSid, ...LOCAL_GROUPS].join(',')}`,
    `otherUser=${[OTHER_USER_SID, ...LOCAL_GROUPS].join(',')}`,
    `anonymous=${[S.anonymous, S.everyone, S.network].join(',')}`,
    `remoteOwner=${[ownerSid, ...NETWORK_GROUPS].join(',')}`,
    `remoteOtherUser=${[OTHER_USER_SID, ...NETWORK_GROUPS].join(',')}`
  ]
  return {
    ownerSid,
    async check(pipe) {
      const lines = (await ask(['check', pipe, ...principals])).split(/\r?\n/)
      const granted = {} as Record<Principal, number>
      const aces: PipeAccessReport['aces'] = []
      for (const line of lines) {
        const grant = /^granted (\w+) 0x([0-9a-f]{8})$/.exec(line)
        if (grant?.[1] && grant[2]) granted[grant[1] as Principal] = Number.parseInt(grant[2], 16)
        const ace = /^ace (\S+) 0x([0-9a-f]{8}) (S-1-[\d-]+)$/.exec(line)
        if (ace?.[1] && ace[2] && ace[3])
          aces.push({ type: ace[1], mask: Number.parseInt(ace[2], 16), sid: ace[3] })
      }
      if (aces.length === 0 || Object.keys(granted).length !== principals.length) {
        throw new Error(`the pipe access probe read no DACL: ${lines.join(' | ')}`)
      }
      return { protectedDacl: lines.includes('protected true'), aces, granted }
    },
    open: (path, access) => ask(['open', path, access.toString(16)]),
    handleCount: async (pid) => Number(await ask(['handles', String(pid)])),
    dispose: () => rmSync(dir, { recursive: true, force: true })
  }
}
