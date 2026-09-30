import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Spike SP-05, L8 Windows (testing strategy `17` §4; ADR-003 items 2, 3 and 12; spike register SP-05).
 *
 * Question: who can open the Host's named pipe and its run files (`run\ui.token`, `run\viewers\<viewId>.token`,
 * `run\mcp\<launchId>.cred`)? The harness reads each object's real security descriptor and asks Windows' own access
 * check (`AuthzAccessCheck`, `MAXIMUM_ALLOWED`) what a principal would be granted:
 * - the owner, as a local interactive logon (must keep access, or the check proves nothing);
 * - another local user (a user SID that is not the owner, with the groups every local user has);
 * - anonymous;
 * - a remote client: the same principals with the NETWORK group every network logon carries.
 * No second account is created and no remote machine is used: the principals are synthesized for the access check
 * (`AUTHZ_SKIP_TOKEN_GROUPS`). A real second user and a real remote client are the owner's manual steps in
 * `spike-results/SP-05.md`.
 *
 * Node's `net` cannot set a pipe DACL (ADR-003 context), so the protected pipe of ADR-003 item 2 is created by a
 * small helper: one C# program compiled at test time by the .NET Framework compiler that ships with Windows (nothing
 * is installed). Kept afterwards as the ADR-003 security test. Set `SP05_REPORT=<file>` to write the measurements as
 * JSON (the spike record's raw output; the owner SID is replaced by `<owner-sid>`).
 */

const CSHARP = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Principal;

static class Sp05 {
  [StructLayout(LayoutKind.Sequential)]
  struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }
  [StructLayout(LayoutKind.Sequential)]
  struct LUID { public uint Low; public int High; }
  [StructLayout(LayoutKind.Sequential)]
  struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)]
  struct AUTHZ_ACCESS_REQUEST {
    public uint DesiredAccess; public IntPtr PrincipalSelfSid; public IntPtr ObjectTypeList;
    public uint ObjectTypeListLength; public IntPtr OptionalArguments;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct AUTHZ_ACCESS_REPLY {
    public uint ResultListLength; public IntPtr GrantedAccessMask; public IntPtr SaclEvaluationResults; public IntPtr Error;
  }

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateNamedPipeW(string name, uint openMode, uint pipeMode, uint maxInstances, uint outSize,
    uint inSize, uint timeout, ref SECURITY_ATTRIBUTES sa);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "CreateNamedPipeW")]
  static extern IntPtr CreateNamedPipeDefault(string name, uint openMode, uint pipeMode, uint maxInstances,
    uint outSize, uint inSize, uint timeout, IntPtr sa);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateDirectoryW(string path, ref SECURITY_ATTRIBUTES sa);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint revision, out IntPtr sd,
    out uint size);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr sd, uint revision, uint info,
    out IntPtr sddl, out uint length);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
  static extern uint GetNamedSecurityInfoW(string name, int type, uint info, IntPtr owner, IntPtr group, IntPtr dacl,
    IntPtr sacl, out IntPtr sd);
  [DllImport("kernel32.dll")]
  static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags,
    IntPtr template);
  [DllImport("advapi32.dll")]
  static extern uint GetSecurityInfo(IntPtr handle, int type, uint info, IntPtr owner, IntPtr group, IntPtr dacl,
    IntPtr sacl, out IntPtr sd);
  [DllImport("authz.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool AuthzInitializeResourceManager(uint flags, IntPtr access, IntPtr compute, IntPtr free,
    string name, out IntPtr manager);
  [DllImport("authz.dll", SetLastError = true)]
  static extern bool AuthzInitializeContextFromSid(uint flags, byte[] sid, IntPtr manager, IntPtr expiration,
    LUID identifier, IntPtr args, out IntPtr context);
  [DllImport("authz.dll", SetLastError = true)]
  static extern bool AuthzAddSidsToContext(IntPtr context, SID_AND_ATTRIBUTES[] sids, uint count, IntPtr restricted,
    uint restrictedCount, out IntPtr newContext);
  [DllImport("authz.dll", SetLastError = true)]
  static extern bool AuthzAccessCheck(uint flags, IntPtr context, ref AUTHZ_ACCESS_REQUEST request, IntPtr audit,
    IntPtr sd, IntPtr optional, uint optionalCount, ref AUTHZ_ACCESS_REPLY reply, IntPtr handle);
  [DllImport("authz.dll")]
  static extern bool AuthzFreeContext(IntPtr context);
  [DllImport("authz.dll")]
  static extern bool AuthzFreeResourceManager(IntPtr manager);

  const uint PIPE_ACCESS_DUPLEX = 0x3, PIPE_REJECT_REMOTE_CLIENTS = 0x8;
  const uint OWNER_GROUP_DACL = 0x7, DACL_ONLY = 0x4, MAXIMUM_ALLOWED = 0x02000000;

  static int Main(string[] args) {
    switch (args[0]) {
      case "sid": Console.WriteLine(WindowsIdentity.GetCurrent().User.Value); return 0;
      case "serve": return Serve(args[1], args[2]);
      case "check": return Check(args);
      case "mkdir": return MakeDirectory(args[1], args[2]);
    }
    return 2;
  }

  // Creates a directory with the given SDDL, the way the native helper creates the Host's run directory.
  static int MakeDirectory(string path, string sddl) {
    IntPtr sd; uint size;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out sd, out size)) {
      Console.WriteLine("error sddl " + Marshal.GetLastWin32Error()); return 1;
    }
    SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES();
    sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)); sa.lpSecurityDescriptor = sd;
    bool ok = CreateDirectoryW(path, ref sa);
    int error = Marshal.GetLastWin32Error();
    LocalFree(sd);
    if (!ok) { Console.WriteLine("error CreateDirectory " + error); return 1; }
    Console.WriteLine("created");
    return 0;
  }

  // Creates four instances of a pipe, with the given SDDL or ("default") with the default security descriptor.
  static int Serve(string name, string sddl) {
    List<IntPtr> handles = new List<IntPtr>();
    for (int i = 0; i < 4; i++) {
      IntPtr handle;
      if (sddl == "default") {
        handle = CreateNamedPipeDefault(name, PIPE_ACCESS_DUPLEX, PIPE_REJECT_REMOTE_CLIENTS, 255, 4096, 4096, 0,
          IntPtr.Zero);
      } else {
        IntPtr sd; uint size;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out sd, out size)) {
          Console.WriteLine("error sddl " + Marshal.GetLastWin32Error()); return 1;
        }
        SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES();
        sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)); sa.lpSecurityDescriptor = sd;
        handle = CreateNamedPipeW(name, PIPE_ACCESS_DUPLEX, PIPE_REJECT_REMOTE_CLIENTS, 255, 4096, 4096, 0, ref sa);
        LocalFree(sd);
      }
      if (handle == new IntPtr(-1)) { Console.WriteLine("error pipe " + Marshal.GetLastWin32Error()); return 1; }
      handles.Add(handle);
    }
    Console.WriteLine("ready");
    Console.Out.Flush();
    Console.ReadLine();
    foreach (IntPtr handle in handles) CloseHandle(handle);
    return 0;
  }

  // check <path> <name>=<userSid>,<groupSid>,... : prints the DACL and the access each principal is granted.
  static int Check(string[] args) {
    IntPtr sd;
    // A pipe is opened as a client with READ_CONTROL only and its descriptor read from the handle: GetNamedSecurityInfo
    // returns ERROR_INVALID_PARAMETER for a pipe created by Node (libuv), measured by SP-05.
    uint status;
    if (args[1].StartsWith(@"\\.\pipe\")) {
      IntPtr handle = CreateFileW(args[1], 0x20000, 0, IntPtr.Zero, 3, 0, IntPtr.Zero);
      if (handle == new IntPtr(-1)) { Console.WriteLine("error CreateFile " + Marshal.GetLastWin32Error()); return 1; }
      status = GetSecurityInfo(handle, 6, OWNER_GROUP_DACL, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out sd);
      CloseHandle(handle);
    } else {
      status = GetNamedSecurityInfoW(args[1], 1, OWNER_GROUP_DACL, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero,
        out sd);
    }
    if (status != 0) { Console.WriteLine("error GetSecurityInfo " + status); return 1; }
    IntPtr text; uint length;
    ConvertSecurityDescriptorToStringSecurityDescriptorW(sd, 1, DACL_ONLY, out text, out length);
    Console.WriteLine("dacl " + Marshal.PtrToStringUni(text));
    LocalFree(text);
    IntPtr manager;
    if (!AuthzInitializeResourceManager(1, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, "sp05", out manager)) {
      Console.WriteLine("error AuthzInitializeResourceManager " + Marshal.GetLastWin32Error()); return 1;
    }
    for (int i = 2; i < args.Length; i++) {
      string[] parts = args[i].Split('=');
      string[] sids = parts[1].Split(',');
      byte[] user = Bytes(sids[0]);
      IntPtr context;
      if (!AuthzInitializeContextFromSid(2, user, manager, IntPtr.Zero, new LUID(), IntPtr.Zero, out context)) {
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
      uint granted = (uint)Marshal.ReadInt32(reply.GrantedAccessMask);
      Console.WriteLine("granted " + parts[0] + " 0x" + granted.ToString("x8"));
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
const SID = {
  everyone: 'S-1-1-0',
  local: 'S-1-2-0',
  consoleLogon: 'S-1-2-1',
  network: 'S-1-5-2',
  interactive: 'S-1-5-4',
  anonymous: 'S-1-5-7',
  authenticatedUsers: 'S-1-5-11',
  thisOrganization: 'S-1-5-15',
  users: 'S-1-5-32-545'
}
/** A user SID that is not the owner: the harness's stand-in for a second local account. */
const OTHER_USER = 'S-1-5-21-1000000001-1000000002-1000000003-1001'
const LOCAL_GROUPS = [
  SID.everyone,
  SID.local,
  SID.consoleLogon,
  SID.interactive,
  SID.authenticatedUsers,
  SID.thisOrganization,
  SID.users
]
const NETWORK_GROUPS = [
  SID.everyone,
  SID.network,
  SID.authenticatedUsers,
  SID.thisOrganization,
  SID.users
]

/** FILE_READ_DATA (a pipe read), the right that would let a principal read a token or the pipe. */
const FILE_READ_DATA = 0x1
/** FILE_READ_DATA | FILE_WRITE_DATA | FILE_APPEND_DATA (FILE_CREATE_PIPE_INSTANCE on a pipe). */
const DATA_RIGHTS = 0x7
/** READ_CONTROL | WRITE_DAC, which Windows grants an object's owner without reading the DACL. */
const OWNER_IMPLICIT = 0x00060000

type Principal = 'owner' | 'otherUser' | 'anonymous' | 'remoteOwner' | 'remoteOtherUser'

interface Ace {
  type: string
  flags: string
  rights: string
  sid: string
}

interface AclReport {
  object: string
  dacl: string
  protectedDacl: boolean
  /** SIDs other than the owner and SYSTEM that an allow ACE grants anything to. */
  foreignGrants: string[]
  granted: Record<Principal, number>
}

/** `SP05_HOLD_SECONDS`: keep the protected pipe and run files alive for the owner's manual checks. */
const HOLD_SECONDS = Number(process.env['SP05_HOLD_SECONDS'] ?? '0') || 0

let workDir = ''
let helperExe = ''
let ownerSid = ''
const reports: AclReport[] = []

function principals(): string[] {
  return [
    `owner=${[ownerSid, ...LOCAL_GROUPS].join(',')}`,
    `otherUser=${[OTHER_USER, ...LOCAL_GROUPS].join(',')}`,
    `anonymous=${[SID.anonymous, SID.everyone, SID.network].join(',')}`,
    `remoteOwner=${[ownerSid, ...NETWORK_GROUPS].join(',')}`,
    `remoteOtherUser=${[OTHER_USER, ...NETWORK_GROUPS].join(',')}`
  ]
}

/** The ACEs of an SDDL DACL string, `D:<flags>(type;flags;rights;object;inherited object;sid)…`. */
function parseAces(dacl: string): Ace[] {
  return [...dacl.matchAll(/\(([^)]*)\)/g)].map((match) => {
    const [type = '', flags = '', rights = '', , , sid = ''] = (match[1] ?? '').split(';')
    return { type, flags, rights, sid }
  })
}

/** Reads the object's DACL and the access Windows grants each principal. */
function checkAcl(object: string, label: string): AclReport {
  const out = execFileSync(helperExe, ['check', object, ...principals()], { encoding: 'utf8' })
  const lines = out.trim().split(/\r?\n/)
  const daclLine = lines.find((line) => line.startsWith('dacl '))
  if (!daclLine) throw new Error(`no DACL read for ${label}: ${out}`)
  const dacl = daclLine.slice('dacl '.length)
  const granted = {} as Record<Principal, number>
  for (const line of lines) {
    const match = /^granted (\w+) 0x([0-9a-f]{8})$/.exec(line)
    if (match?.[1] && match[2]) granted[match[1] as Principal] = Number.parseInt(match[2], 16)
  }
  const report: AclReport = {
    object: label,
    dacl,
    protectedDacl: /^D:[A-Z]*P/.test(dacl),
    foreignGrants: parseAces(dacl)
      .filter((ace) => ace.type === 'A' && ace.sid !== ownerSid && ace.sid !== 'SY')
      .map((ace) => ace.sid),
    granted
  }
  reports.push(report)
  return report
}

function hex(mask: number): string {
  return `0x${mask.toString(16).padStart(8, '0')}`
}

/**
 * Owner-only (ADR-003): allow entries name only the owner and SYSTEM, the owner keeps read, and Windows' access check
 * grants another local user and anonymous nothing. The pipe and `run\` carry a protected DACL; a run file carries
 * only the entries it inherits from the protected `run\`.
 */
function expectOwnerOnly(report: AclReport, source: 'protected' | 'inherited' = 'protected'): void {
  const { object, granted } = report
  if (source === 'protected') {
    expect(report.protectedDacl, `${object}: the DACL is protected (no inherited entries)`).toBe(
      true
    )
  } else {
    const aces = parseAces(report.dacl)
    expect(
      aces.length > 0 && aces.every((ace) => ace.flags.includes('ID')),
      `${object}: every entry is inherited from run\\`
    ).toBe(true)
  }
  expect(
    report.foreignGrants,
    `${object}: no allow entry for anyone but the owner and SYSTEM`
  ).toEqual([])
  expect(granted.owner & FILE_READ_DATA, `${object}: the owner can read`).toBe(FILE_READ_DATA)
  expect(hex(granted.otherUser), `${object}: another local user is granted nothing`).toBe(hex(0))
  expect(hex(granted.anonymous), `${object}: anonymous is granted nothing`).toBe(hex(0))
}

/** Starts the pipe helper with the given SDDL (or "default") and waits until its instances exist. */
async function servePipe(pipe: string, sddl: string): Promise<ChildProcessWithoutNullStreams> {
  const helper = spawn(helperExe, ['serve', pipe, sddl], { windowsHide: true })
  const first = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the pipe helper did not start')), 10000)
    createInterface({ input: helper.stdout }).once('line', (line) => {
      clearTimeout(timer)
      resolve(line)
    })
  })
  expect(first, 'pipe helper').toBe('ready')
  return helper
}

function stopPipe(helper: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    if (helper.exitCode !== null) return resolve()
    helper.once('exit', () => resolve())
    helper.stdin.end('quit\n')
  })
}

/** Whether a local client of the owner can open the pipe. */
function ownerConnects(pipe: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(pipe)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

/** Creates `hostDataDir` in the per-user %APPDATA% tree (`09` §1), the way Node creates it (inherited ACL). */
function makeHostDataDir(): string {
  return mkdtempSync(path.join(process.env['APPDATA'] ?? tmpdir(), 'dwarfai-sp05-'))
}

/** Writes the three kinds of run file into `run` the way Node writes them: exclusive, mode 0600. */
function writeRunFiles(run: string): Record<string, string> {
  mkdirSync(path.join(run, 'viewers'), { recursive: true, mode: 0o700 })
  mkdirSync(path.join(run, 'mcp'), { recursive: true, mode: 0o700 })
  const files = {
    'run\\ui.token': path.join(run, 'ui.token'),
    'run\\viewers\\<viewId>.token': path.join(run, 'viewers', 'view-1.token'),
    'run\\mcp\\<launchId>.cred': path.join(run, 'mcp', 'launch-1.cred')
  }
  for (const file of Object.values(files)) {
    writeFileSync(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 })
  }
  return files
}

/** Replaces this machine's SIDs in a report: the owner, then any other account of the same machine domain. */
function scrub(text: string): string {
  const machineDomain = ownerSid.slice(0, ownerSid.lastIndexOf('-'))
  return text.split(ownerSid).join('<owner-sid>').split(machineDomain).join('S-1-5-21-<machine>')
}

describe.runIf(process.platform === 'win32')('SP-05: pipe and run-file ACLs (ADR-003)', () => {
  beforeAll(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'dwarfai-sp05-'))
    const source = path.join(workDir, 'sp05.cs')
    helperExe = path.join(workDir, 'sp05.exe')
    writeFileSync(source, CSHARP)
    const windir = process.env['WINDIR'] ?? 'C:\\Windows'
    const csc = path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
    execFileSync(csc, ['/nologo', `/out:${helperExe}`, source])
    ownerSid = execFileSync(helperExe, ['sid'], { encoding: 'utf8' }).trim()
  }, 60000)

  afterAll(async () => {
    const reportFile = process.env['SP05_REPORT']
    if (reportFile) writeFileSync(reportFile, scrub(JSON.stringify(reports, null, 2)))
    for (let attempt = 0; attempt < 10 && workDir; attempt += 1) {
      try {
        rmSync(workDir, { recursive: true, force: true })
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
    }
  })

  it(
    '[SP-05, ADR-003] the test pipe and token files are unreadable by another user and a remote pipe client is refused',
    async () => {
      // ADR-003 items 3 and 12: the run directory is created by the helper with the pipe's principals, protected, and
      // the run files Node writes inside it inherit that DACL.
      const hostDataDir = makeHostDataDir()
      const run = path.join(hostDataDir, 'run')
      // ADR-003 item 2: current user + SYSTEM, NETWORK denied, protected; remote clients rejected.
      const pipe = `\\\\.\\pipe\\dwarfai-sp05-${randomBytes(8).toString('hex')}`
      let helper: ChildProcessWithoutNullStreams | undefined
      try {
        const created = execFileSync(
          helperExe,
          ['mkdir', run, `D:P(A;OICI;FA;;;${ownerSid})(A;OICI;FA;;;SY)`],
          { encoding: 'utf8' }
        )
        expect(created.trim(), 'the helper creates the run directory').toBe('created')
        expectOwnerOnly(checkAcl(run, 'run\\ (helper, protected)'))
        const files = writeRunFiles(run)
        for (const [label, file] of Object.entries(files)) {
          expectOwnerOnly(
            checkAcl(file, `${label} (inherits from the protected run\\)`),
            'inherited'
          )
        }

        helper = await servePipe(pipe, `D:P(D;;GA;;;NU)(A;;GA;;;${ownerSid})(A;;GA;;;SY)`)
        expect(await ownerConnects(pipe), 'the owner opens the pipe').toBe(true)
        const report = checkAcl(pipe, 'pipe (ADR-003 item 2 helper)')
        expectOwnerOnly(report)
        // Windows grants the object's owner READ_CONTROL | WRITE_DAC before any ACE is read, so the deny-NETWORK ACE
        // leaves those two; every data right is denied (measured by SP-05, recorded in spike-results/SP-05.md).
        expect(
          hex(report.granted.remoteOwner & DATA_RIGHTS),
          'a remote client of the owner gets no data right'
        ).toBe(hex(0))
        expect(
          hex(report.granted.remoteOwner & ~OWNER_IMPLICIT),
          'nothing beyond owner rights'
        ).toBe(hex(0))
        expect(hex(report.granted.remoteOtherUser), 'a remote client of another user').toBe(hex(0))

        if (HOLD_SECONDS > 0) {
          // Owner-only manual step (spike-results/SP-05.md): a real second user and a remote client try these now.
          console.log(`SP-05 hold ${HOLD_SECONDS}s: pipe ${pipe}`)
          for (const [label, file] of Object.entries(files))
            console.log(`SP-05 hold: ${label} = ${file}`)
          await new Promise((resolve) => setTimeout(resolve, HOLD_SECONDS * 1000))
        }
      } finally {
        if (helper) await stopPipe(helper)
        rmSync(hostDataDir, { recursive: true, force: true })
      }
    },
    60000 + HOLD_SECONDS * 1000
  )

  it("[SP-05] a pipe created by Node's net.Server keeps the default DACL, which grants read to another user and to anonymous", async () => {
    // Why the native helper is adopted (ADR-003 item 2): Node's `net` cannot set a pipe DACL.
    const pipe = `\\\\.\\pipe\\dwarfai-sp05-node-${randomBytes(8).toString('hex')}`
    const server: Server = createServer((socket) => socket.destroy())
    await new Promise<void>((resolve) => server.listen(pipe, resolve))
    try {
      const report = checkAcl(pipe, 'pipe (Node net.Server default)')
      expect(report.protectedDacl, 'the default pipe DACL').toBe(false)
      expect(report.granted.owner & FILE_READ_DATA, 'the owner can read').toBe(FILE_READ_DATA)
      expect(report.granted.otherUser & FILE_READ_DATA, 'another local user can read').toBe(
        FILE_READ_DATA
      )
      expect(report.granted.anonymous & FILE_READ_DATA, 'anonymous can read').toBe(FILE_READ_DATA)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 60000)

  it("[SP-05] a run directory created by Node's mkdirSync (mode 0o700) is not protected: its files take whatever the %APPDATA% tree passes down", () => {
    // Why the helper also creates run\ (ADR-003 item 3, AMENDMENT-10): on Windows Node ignores the mode, so the
    // files' ACL is the per-user tree's, which other software may have widened (measured on the spike machine).
    const hostDataDir = makeHostDataDir()
    try {
      const run = path.join(hostDataDir, 'run')
      mkdirSync(run, { mode: 0o700 })
      const runReport = checkAcl(run, 'run\\ (Node mkdirSync 0o700)')
      expect(runReport.protectedDacl, 'run\\ created by Node').toBe(false)
      for (const [label, file] of Object.entries(writeRunFiles(run))) {
        const report = checkAcl(file, `${label} (Node, inherited from %APPDATA%)`)
        expect(report.protectedDacl, `${label} created by Node`).toBe(false)
        const aces = parseAces(report.dacl)
        expect(
          aces.every((ace) => ace.flags.includes('ID')),
          `${label}: every entry is inherited`
        ).toBe(true)
      }
    } finally {
      rmSync(hostDataDir, { recursive: true, force: true })
    }
  })
})
