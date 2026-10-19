# Privacy and data boundary

DwarfAI-Miners is a local desktop app in two parts: the **DwarfAI Host**, one background process per
OS user that launches and observes AI coding sessions and keeps the app's data, and the **window**,
an Electron client of the Host. Almost everything happens on your machine. The one exception the app
itself makes is Jev, an optional launch advisor that calls TypeSafe's API — off unless you give it a
key and turn it on, and described in full in [What it transmits](#what-it-transmits).

This document states what is read, what is stored and what is transmitted. Each claim names the
source that implements it (under `src/`) or the architecture decision that sets it (ADR numbers),
so it can be checked rather than trusted.

> This document describes the rebuilt app. The previous app (the v0.x releases, v0.13.1 and
> earlier) kept different files; its description is in this file's history.

## What it reads

**The providers' own files, read-only.** The Host reads each provider's local session files to
show a session that started outside the app, and never writes them (ADR-006, ADR-007). Reads are
bounded: a byte-offset cursor per file and bounded tail reads, never a whole transcript at once
(`src/host/modules/observation/adapters/base/`). SQLite stores are opened read-only, without
ever taking the write lock; an idle store is read from a private copy instead, so that opening it
creates no file in the provider's folder (`src/host/platform/sqlite/readOnlySnapshot.ts`).

- **Claude Code**: under its configuration folder (`CLAUDE_CONFIG_DIR`, default `~/.claude`, plus
  any further roots in the `CLAUDE_CONFIG_DIRS` setting), every session transcript
  `projects/<folder>/<session>.jsonl`, every subagent transcript, and the `sessions/` registry
  (`observation/adapters/claude/ClaudeObservationAdapter.ts`).
- **Codex**: under `CODEX_HOME` (default `~/.codex`), the rollouts `sessions/**/rollout-*.jsonl`
  and the thread registry `state_5.sqlite` (`observation/adapters/codex/CodexObservationAdapter.ts`).
- **OpenCode**: its store `opencode.db` under `~/.local/share/opencode/`
  (`observation/adapters/opencode/OpenCodeObservationAdapter.ts`).
- **Antigravity**: under `~/.gemini`, each conversation's step log `transcript.jsonl`, each
  conversation's `conversations/<id>.db` for its usage and model id, `history.jsonl` for which
  workspace a conversation belongs to, and `presence/` for which conversations are running
  (`observation/adapters/antigravity/`).

**Never your provider credentials.** The app does not read, copy, store, refresh, forward or log a
provider's credentials or credential stores — for example Claude Code's credentials file, OpenCode's
`auth.json`, Codex's auth files, or Antigravity's account and token files (ADR-008 item 2). Each
tool logs in with its own flow.

<a id="the-one-time-history-scan"></a>

**Your past usage, once.** To credit the work you did before installing the app as coal, the Host
scans the providers' history from before the install moment once, resumably and within a per-boot
budget, and records which units it has read (`src/host/modules/ledger/application/coalBackfill.ts`).
After a complete scan it does not run again until Reset metrics sets a new install moment.

**Your project folders, by size only.** A mine's tier comes from the size of its source code: the
Host walks the folder in a worker thread, read-only, and never writes in it
(`src/host/modules/mines/adapters/FsSourceWeightScanner.ts`).

**Files you attach to a message, and only those.** The Host checks each path you picked or dropped
and reads its name and size; nothing else in the folder is looked at
(`src/host/modules/conversation/application/describeAttachments.ts`).

**Processes.** To know whether a session is alive, and to end only the process it started, the Host
reads a process's id, start time and the machine's boot identity (`src/host/platform/process/`;
ADR-014).

## What it stores, and where

Everything the app keeps lives in its per-user data folder:

| Platform | Folder                                         |
| -------- | ---------------------------------------------- |
| Windows  | `%APPDATA%\DwarfAI-Miners`                     |
| macOS    | `~/Library/Application Support/DwarfAI-Miners` |
| Linux    | `~/.config/DwarfAI-Miners`                     |

A development build uses a folder of its own, `DwarfAI-dev`, beside it (`src/ui-main/dataDirectory.ts`).

**The database**, `host/dwarfai.db`, written by the Host alone (ADR-005; `09` §1). It holds:

- your mines, each named by its **absolute folder path**, with its tier and its six material
  totals. Removing a mine keeps its row and its ore, which is why adding the folder again brings
  the ore back; only **Reset metrics** clears them;
- the dwarfs that worked in each mine, their custom names and their outcome lines;
- the **conversation**: at most 50 messages per dwarf, each at most 64 KiB, oldest dropped first
  (`src/host/modules/conversation/domain/retention.ts`), with each message's delivery mark, the
  record of its attachments and the "Answers:" records of answered questions;
- open and recently closed questions and permissions, launches and their outcome, delegated
  subtasks (their text is cleared when the subtask settles), and usage counts;
- which integrations you turned on, and SHA-256 hashes of the channel tokens — never the tokens
  themselves.

Before a schema migration the Host keeps a backup of the database (`host/dwarfai.db.bak-*`, the
three newest); Reset metrics deletes them.

**Secrets**, in the OS secret store — Credential Manager on Windows, Keychain on macOS, libsecret on
Linux — under the service name `DwarfAI-Miners`: the Jev key and the OpenCode server password, the
only two secrets the app keeps. Never in the database, a file, a log, a command line or an
environment variable, and with no plain-text fallback: where no secret store is available, the key
cannot be saved (ADR-017;
`src/host/modules/preferences/adapters/secret-store/OsKeyringSecretStore.ts`).

**Preferences** set in the app (dock side, always on top, shortcut, typography, sound, the last page
and mine open), one small JSON file each, written by the window process (ADR-024).

**Run-time files** under `host/run/`: the credentials and locks of the local channel, created
owner-only and replaced at every Host start or launch (ADR-002, ADR-003).

**The diagnostic log** under `logs/`, capped at 100 MB, which never holds what you or a provider
wrote: see the README's [Diagnostic log](../README.md#diagnostic-log) section (ADR-026).

**Outside that folder, only with your consent.** On the first open, a one-step welcome asks whether
to connect with Claude Code and OpenCode, and nothing is written before you choose **Activate**; you
can turn either on or off later in Settings › Integrations (ADR-016):

- **Claude Code · instant updates** adds one hook entry of DwarfAI's own to Claude Code's
  `settings.json`, leaving every other byte of the file as it was
  (`src/host/modules/preferences/adapters/external-config/claudeHooks/`).
- **OpenCode · permission requests** writes one plugin file of DwarfAI's own into OpenCode's plugin
  folder (`src/host/modules/preferences/adapters/external-config/openCodePlugin/`).

Each carries a token in plain text that lets it report to the Host. Before its first change to a
file, the Host saves a backup beside it (`<file>.dwarfai-bak-<timestamp>`). Turning the integration
off, and `DwarfAI-Miners --revert-integrations`, remove exactly DwarfAI's own entry.

Transcripts and rollouts are never copied; a provider's database is copied only as the private
read copy described under [What it reads](#what-it-reads).

## What it transmits

DwarfAI-Miners sends no telemetry and no crash reports, and it does not check for updates (ADR-026;
ADR-027). The only network request the app itself makes is Jev's.

### Jev

Jev runs only when you have entered your own TypeSafe key in Settings › Integrations and turned on
**Let Jev choose** for a launch. It then sends a request to `https://api.typesafe.ai`, with your key
as the bearer (`src/host/modules/jev/adapters/typesafe/TypesafeJevRouter.ts`), carrying:

- the prompt you wrote and your routing profile (Economy, Balanced or Premium);
- the providers this machine can launch, and — when more than one model fits — the candidate
  models' ids in a second request.

No address or setting of that client is read from the environment, so no variable can redirect the
traffic.

<a id="subtask-delegation"></a>

### Subtask delegation

With **Subagent delegation · beta** on in Settings, a dwarf launched with Let Jev choose can hand a
subtask to Jev. That sends the subtask's text (at most 4 000 characters) and its context (at most
16 000 characters) to the same API (`src/host/modules/delegation/domain/subtaskText.ts`; ADR-013).
A dwarf's custom name is never sent to a provider.

### The AI tools you run

Claude Code, Codex, OpenCode, Antigravity and any "Other…" command talk to their own services under
your own login, as they do in a terminal. The app does not proxy, inspect or redirect that traffic
(ADR-008 item 4).

<a id="the-opencode-permission-relay"></a>

### Local connections

The Host listens on nothing beyond your machine: its local channel is a named pipe (Windows) or a
Unix socket (macOS, Linux) reachable only by your OS user, and the Claude Code hook and the OpenCode
plugin report to a listener bound to `127.0.0.1` that requires their token
(`src/host/transport/endpoint/`, `src/host/transport/ingress/httpIngress.ts`). OpenCode permission
requests reach the app through that listener only while "OpenCode · permission requests" is on.

## What is shown on screen

The window shows what the providers wrote: messages, tool steps, questions and permissions. An
ask's text and an activity summary line are redacted for recognisable secrets before they leave the
Host, and so is every log line (`src/contracts/logging/redactSecrets.ts`). Redaction is
deliberately lossy and not a guarantee, and message text is not redacted: the conversation is shown
as the provider wrote it.

## Where DwarfAI-Miners' responsibility ends

What a provider does with your prompts is governed by that provider's terms and your account with
it; see [`docs/provider-terms.md`](provider-terms.md). What the app cannot protect against — another
process running as your own OS user — is listed in the README's [Security](../README.md#security)
section.
