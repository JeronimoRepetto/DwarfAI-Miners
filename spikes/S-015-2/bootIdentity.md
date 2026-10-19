# S-015-2 — boot and logon identity per OS: procedure and observed sources

Spike register S-015-2; ADR-015 item 4 "Reboot detection" (OQ-55, AMENDMENT-3); testing strategy `17` §4. The record
is `spike-results/S-015-2.md`. This file holds the procedure and the observed sources; the record holds the verdict,
the decision and the proposed table.

## What is measured

ADR-015 item 4 compares the boot identity `{ bootId, bootTimeMs, logonSessionId }` that a Host epoch stored with the
one read at the next Host start (`ProcessControl.currentBootIdentity()`, `16` §3; each field `'unknown'` when
unreadable, and `'unknown'` never compares equal). For each OS the spike answers:

1. Which candidate sources can a Host read under `ELECTRON_RUN_AS_NODE`, without elevation?
2. How long does one read take, against the 2 000 ms bound of `16` §2.6?
3. Is each value stable within one boot (repeated reads, sleep and resume, a day of uptime)?
4. Does each value change across a restart, a logout, an update reboot and, on Windows, a Fast Startup shutdown?

Questions 1–3 are scripted where the OS allows it. Question 4 ends the session that runs the script, so it is manual:
take a snapshot, perform the transition, take another snapshot, compare.

## Tools

- `spikes/S-015-2/bootIdentity.ts`: the reader. It needs Node 24 (type stripping) or Electron 44 under
  `ELECTRON_RUN_AS_NODE=1`. Commands:

  ```sh
  node spikes/S-015-2/bootIdentity.ts snapshot --label <step> --out <file>
  node spikes/S-015-2/bootIdentity.ts compare <before.json> <after.json>
  ```

  `compare` prints one line per source: `same`, `CHANGED`, or `UNKNOWN` (unreadable on one side).

- `spikes/S-015-2/bootIdentity.os.test.ts`: the scripted half in the OS lane (`pnpm test:os`, one leg per OS). It
  reads every source five times, asserts that the sources ADR-015 item 4 names are readable and stable, records the
  latencies, and checks rules 1–4 on the transition kinds. With `S0152_REPORT=<file>` it writes the snapshots as
  JSON.

Identity values that could single out a machine or a session (UUIDs, LUIDs, logon SIDs, session ids) are stored only as
a 12-hex-digit SHA-256 prefix. That is enough to tell "same" from "changed". Boot instants and the Windows `BootId`
counter are stored as they are.

Nothing in the procedure needs elevation, changes a system setting or installs anything. On Windows, the reference
readings (kernel boot time, logon LUID, tick counters) come from a small C# program compiled at run time with the .NET
Framework `csc.exe` that ships with Windows, as in SP-02. It stands in for a native call and is **not** a candidate
production source: the Host has no native module.

## Candidate sources per OS

| OS      | Field            | Source                                                                         | How the Host would read it                 |
| ------- | ---------------- | ------------------------------------------------------------------------------ | ------------------------------------------ |
| Windows | `bootId`         | registry `HKLM\…\Memory Management\PrefetchParameters` value `BootId` (DWORD)  | spawn `reg.exe query` (ships with Windows) |
| Windows | `bootTimeMs`     | `Win32_OperatingSystem.LastBootUpTime` (ADR-015 as written)                    | spawn PowerShell `Get-CimInstance`         |
| Windows | `bootTimeMs`     | `now − GetTickCount64()` (ADR-015 as written), which is `now − os.uptime()`    | in process                                 |
| Windows | `logonSessionId` | token `TokenStatistics.AuthenticationId` (ADR-015 as written)                  | native call only (reference helper)        |
| Windows | `logonSessionId` | the token's logon SID (`S-1-5-5-x-y`)                                          | spawn `whoami.exe /logonid`                |
| Windows | reference        | `NtQuerySystemInformation(SystemTimeOfDayInformation).BootTime`, sleep bias    | native call only (reference helper)        |
| Windows | reference        | `now − QueryUnbiasedInterruptTime()` (excludes sleep)                          | native call only (reference helper)        |
| Linux   | `bootId`         | `/proc/sys/kernel/random/boot_id` (ADR-015 as written)                         | in process (file read)                     |
| Linux   | `bootTimeMs`     | `now − os.uptime()` (ADR-015 as written)                                       | in process                                 |
| Linux   | `bootTimeMs`     | `/proc/stat` `btime` (kernel boot instant, whole seconds)                      | in process (file read)                     |
| Linux   | `logonSessionId` | `/proc/self/sessionid` (audit), `XDG_SESSION_ID`, the cgroup `session-N.scope` | in process                                 |
| macOS   | `bootId`         | `sysctl kern.bootsessionuuid` (ADR-015 as written)                             | spawn `/usr/sbin/sysctl`                   |
| macOS   | `bootTimeMs`     | `sysctl kern.boottime` (ADR-015 as written)                                    | spawn `/usr/sbin/sysctl`                   |
| macOS   | `logonSessionId` | `SECURITYSESSIONID` (environment), `ps -o sess=`                               | in process / spawn `/bin/ps`               |
| macOS   | `logonSessionId` | the user's `console` line in `who` (utmpx login minute)                        | spawn `/usr/bin/who`                       |
| macOS   | `logonSessionId` | start time of the user's `loginwindow` process (`ps -axo uid=,lstart=,comm=`)  | spawn `/bin/ps`                            |

ADR-015 names the audit session id (`getaudit_addr`) for macOS. Node has no binding for it, so the spike measures the
values a Node process can read instead. The last two were added after P2 (below). Both readers run with `LC_ALL=C` and
`TZ=UTC0`: `who` and `ps` print their times with `strftime`, whose names follow the locale and whose clock follows
the time zone. The `loginwindow` row is matched by uid, so no user name is parsed.

## Observed on Windows 11 Pro 10.0.26200 (2026-09-30, this machine, Fast Startup on)

From `spike-results/S-015-2/windows-11-os-lane.json` (Node 24.11.1, five rounds) and
`windows-11-electron-run-as-node.json` (Electron 44.0.0, Node 24.18.1, `ELECTRON_RUN_AS_NODE=1`):

| Source                                 | Readable (Node and Electron RunAsNode) | Stable in the run | Latency (first / range over 5 reads)   | Value                                     |
| -------------------------------------- | -------------------------------------- | ----------------- | -------------------------------------- | ----------------------------------------- |
| registry `BootId` via `reg.exe`        | yes / yes                              | yes               | 110 ms / 53–110 ms (Electron: 23 ms)   | counter 213                               |
| CIM `LastBootUpTime` via PowerShell    | yes / yes                              | yes               | 441 ms / 441–704 ms (Electron: 413 ms) | T+16 s                                    |
| `now − os.uptime()`                    | yes / yes                              | yes               | 0.1 ms                                 | T (reference instant)                     |
| `whoami /logonid` logon SID            | yes / yes                              | yes               | 97 ms / 50–122 ms (Electron: 41 ms)    | fingerprint                               |
| helper: `SystemTimeOfDayInformation`   | yes (native)                           | yes               | one helper run, 51–120 ms              | T+18 s                                    |
| helper: `now − GetTickCount64()`       | yes (native)                           | yes               | same run                               | T, equal to `now − os.uptime()`           |
| helper: `now − QueryUnbiasedInterrupt` | yes (native)                           | yes               | same run                               | T+31.8 h: the machine's accumulated sleep |
| helper: token `AuthenticationId` LUID  | yes (native)                           | yes               | same run                               | fingerprint, not equal to the logon SID   |

Other facts from the same run:

- `os.uptime()` on Windows is `GetTickCount64`: both boot instants agree to the second (asserted in the OS lane).
- The three boot instants differ: the tick-based one is 16 s earlier than CIM `LastBootUpTime` and 18 s earlier than
  the kernel's `BootTime`. ISSUE-018 had seen about 15 s on the same machine. Each one was stable within the run, but
  a boot instant derived from `now − ticks` follows the wall clock, so a clock step or a slow drift can move it by a
  second. Whether that happens within one boot is question 3, and it is part of the manual procedure (step W7).
- `now − QueryUnbiasedInterruptTime()` moves forward by every sleep (31.8 h here). It is never a boot identity.
- The logon SID that `whoami /logonid` prints is not the token's `AuthenticationId` LUID (compared raw on this machine,
  not recorded). Both belong to the logon session. Whether both change at sign-out and after a Fast Startup shutdown
  is step W4 and W2.
- CIM `LastBootUpTime` costs 0.4–0.8 s warm here, and ISSUE-018 saw a cold read above the 2 000 ms bound. `reg.exe`
  and `whoami.exe` cost 23–122 ms.

## Observed on macOS 26.6.2 (2026-10-02, the owner's Mac, arm64)

From `spike-results/S-015-2/macos-26.6.2-*.json` (Node 24.21.0 for the OS lane and P1-before, Node 22.22.3 after the
restart). Steps P0, P1, P2 and a second logout P2b with the two GUI-login sources.

| Source                            | Readable  | Stable in one boot | Restart (P1) | Logout (P2, P2b)                               | Latency  |
| --------------------------------- | --------- | ------------------ | ------------ | ---------------------------------------------- | -------- |
| `sysctl kern.bootsessionuuid`     | yes       | yes                | changed      | same                                           | 3–9 ms   |
| `sysctl kern.boottime`            | yes       | yes, exact to ms   | changed      | same                                           | 2–7 ms   |
| `now − os.uptime()`               | yes       | ±1 s between reads | changed      | same (±1 s)                                    | 0–0.1 ms |
| `SECURITYSESSIONID`               | mostly no | —                  | null → set   | set → null, also in a fresh Terminal.app shell | 0 ms     |
| `ps -o sess=`                     | yes       | yes, always `0`    | same         | same                                           | 2–9 ms   |
| `who` console login               | yes       | yes                | not measured | changed (P2b), to the minute                   | 3–4 ms   |
| `loginwindow` start (`ps lstart`) | yes       | yes                | not measured | changed (P2b), to the second                   | 37–40 ms |

- `SECURITYSESSIONID` depends on how the process was started, not on the login, and `ps -o sess=` is `0` for every
  process. Neither is a logon identity.
- The `who` and `loginwindow` values of P2b were recorded with the first version of the readers, in the Mac's local
  time zone (the `loginwindow` value was parsed with `Date.parse`, which gives the same instant). The readers now
  force `LC_ALL=C` and `TZ=UTC0`, so a `who` value read today is printed in UTC and does not compare with the P2b
  strings; the `loginwindow` instants do.
- Not measured: fast user switching (two GUI users at once), sleep and resume, a day of uptime (P3), and the readers
  under `ELECTRON_RUN_AS_NODE`.

## Manual procedure — Windows 11

Run in a normal (not elevated) terminal at the repository root. `<v>` is the Windows build (`winver`, e.g.
`26200.9457`). Before each transition, close anything you do not want to lose.

- **W0.** Read the Fast Startup state (no change):
  `reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Power" /v HiberbootEnabled` (`0x1` = on).
- **W1. Restart.**
  `node spikes/S-015-2/bootIdentity.ts snapshot --label before-restart --out spike-results/S-015-2/windows-<v>-W1-before.json`,
  then Start → Power → **Restart**, sign in, and run the same command with `--label after-restart` and `-W1-after.json`.
  Expected: `BootId`, CIM `LastBootUpTime`, `now − os.uptime()`, the logon SID and the LUID all `CHANGED`.
- **W2. Shut down with Fast Startup (hybrid shutdown).** Snapshot `W2-before`, run `shutdown /s /hybrid /t 0` (the
  same as Start → Power → Shut down while Fast Startup is on), power on, sign in, snapshot `W2-after`. Record which
  sources changed. The open question: the logon SID and the LUID are expected `CHANGED`, because the user session was
  logged off. Does `BootId` change? Do the boot instants change? ADR-015 rule 2 must catch this case if `BootId` stays.
- **W3. Shut down without Fast Startup (full shutdown).** Snapshot `W3-before`, run `shutdown /s /t 0` (a full shutdown
  whatever the Fast Startup setting), power on, sign in, snapshot `W3-after`. Expected: every source `CHANGED`.
- **W4. Sign out.** Snapshot `W4-before`, Start → account → **Sign out**, sign in, snapshot `W4-after`. Expected:
  logon SID and LUID `CHANGED`; `BootId` and the boot instants `same`.
- **W5. Update reboot.** At the next Windows Update restart: snapshot `W5-before` just before choosing "Restart now",
  snapshot `W5-after` once signed in. Expected as W1.
- **W6. Sleep and resume.** Snapshot `W6-before`, Start → Power → **Sleep**, wake, sign in, snapshot `W6-after`.
  Expected: everything `same` except `now − QueryUnbiasedInterruptTime()`.
- **W7. A day of uptime.** Snapshot `W7-before`, then again after at least 24 h without a restart (sleep allowed),
  `W7-after`. Expected: everything `same`. A change of `now − os.uptime()` or of CIM `LastBootUpTime` is the drift
  that decides whether a boot instant can serve as `bootId`.
- For each step run `node spikes/S-015-2/bootIdentity.ts compare <before> <after>` and paste the output into the
  record's "Owner results" section.

## Manual procedure — macOS and Linux

Run at the repository root in a normal terminal, and also once from a Host-like process: the same command under
`ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron` (Linux) or
`ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron` (macOS). Use
`<os>` = `macos-<version>` or `linux-<distro>-<version>`.

- **P0.** `pnpm test:os` with `S0152_REPORT=spike-results/S-015-2/<os>-os-lane.json` (questions 1–3 within one run).
- **P1. Restart.** Snapshot `P1-before`, restart, sign in, snapshot `P1-after`. Expected: `bootId` and the boot
  instants `CHANGED`.
- **P2. Log out.** Snapshot `P2-before`, log out of the desktop session and back in, snapshot `P2-after`. Expected:
  a logon source `CHANGED` and `bootId` `same`. Record which logon source (if any) changed. That is the open question for
  both OSes.
- **P3. Sleep and resume, and a day of uptime.** As W6 and W7.
- **Linux variants.** Repeat P0–P2 on one systemd distribution with logind (the default desktop) and, where
  available, one without systemd or without logind (for example Alpine, Void or a container). Record `init system` from
  the snapshot.
- Compare each pair with `compare`, and paste the output into the record.
