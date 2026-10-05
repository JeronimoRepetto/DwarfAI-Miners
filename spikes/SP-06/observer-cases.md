# Observer recording cases (SP-06, S-021-1, S-021-2, S-032-1)

The cases the maintainer records for the cut-1 measurement spikes, in the real-CLI lane only (`17` §5.5): on the
maintainer's machine, with the maintainer's own provider login, never in CI and never by an agent of this repository.
Each case runs in a throwaway Git repository and sends only the prompts written here, so no personal content can
enter a fixture (`17` §1.4, recording step 2). A driver's recording adapter (`scripts/fixtures/record.mjs`) does not
exist yet for these providers, so the CLI is run by hand and its file is copied with `captureTranscript.mjs`.

## Tools

| Tool                                    | What it does                                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `spikes/SP-06/captureTranscript.mjs`    | copies one provider file into `fixtures/<provider>/observer/<version>/<case>.raw.*`            |
| `scripts/fixtures/scrub.mjs`            | turns the raw files of one case into the committable fixture set, then deletes the raw files   |
| `spikes/SP-06/idCorrespondence.mjs`     | SP-06: the ids and usage a live stream and a transcript share (counts only)                    |
| `spikes/S-021-1/claudeTurnEnds.mjs`     | S-021-1: one terminal `stop_reason` per Claude turn                                            |
| `spikes/S-021-2/openCodeTurnEvents.mjs` | S-021-2: the OpenCode event kinds that occur once per turn                                     |
| `spikes/S-032-1/turnGaps.mjs`           | S-032-1: the longest silence inside a turn, and a tool call still waiting at the capture's end |

The analyzers print counts, durations, stop reasons, event names and tool names only. Run them on the **scrubbed**
files, so even their input holds no personal value. The scrubber maps every id to the same fake id across one case,
so the correspondence SP-06 measures survives scrubbing (`spikes/SP-06/observerCapture.os.test.mjs` proves it).

## Throwaway repository

A new folder `dwarfai-rec-<n>` under the OS temporary folder, holding one file, `README.md`, with the text
`# Throwaway repository` and one commit made with the placeholder identity of `record.mjs`
(`user.name=DwarfAI recorder`, `user.email=recorder@invalid`, signing off). It is deleted after the case.

## Cases

| Case                | Providers               | Prompts, in order (exact text)                                                                                                                                                                        | Spikes                    |
| ------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `one-turn`          | Claude, Codex, OpenCode | 1. `Reply with the single word hello and nothing else. Do not use any tool.`                                                                                                                          | SP-06, S-021-1, S-032-1   |
| `tool-continuation` | Claude, Codex, OpenCode | 1. `Read the file README.md with your file-reading tool, then reply with the single word done.`                                                                                                       | SP-06, S-021-1, S-032-1   |
| `two-turns`         | Claude, Codex, OpenCode | 1. `Reply with the single word one and nothing else. Do not use any tool.` 2. `Reply with the single word two and nothing else. Do not use any tool.`                                                 | S-021-1, S-021-2, S-032-1 |
| `subagent`          | Claude                  | 1. `Use your task tool to start one subagent whose only job is to reply with the single word hello. Then reply with the single word done.`                                                            | S-021-1                   |
| `compaction`        | Claude (interactive)    | 1. `Reply with the single word one and nothing else. Do not use any tool.` 2. the command `/compact` 3. `Reply with the single word two and nothing else. Do not use any tool.`                       | S-021-1                   |
| `permission-ask`    | Claude, Codex, OpenCode | 1. `Create a file named note.txt that contains the single word hello.` The CLI runs interactively in its default permission mode; the capture is taken while it waits, then the person answers Deny.  | S-032-1                   |
| `question-ask`      | Claude, Codex           | 1. `Before you do anything else, use your question tool to ask me whether I prefer the word red or the word blue. Then reply with the word I chose.` Captured while it waits; the person answers red. | S-032-1                   |

For SP-06 the Claude cases run with `claude -p <prompt> --output-format stream-json --verbose`: stdout is the live
stream, captured as the case's `stream` file (`--stream stream`), and the transcript is the session's JSONL file,
captured as the case itself. A second prompt of the same session uses `--resume <session id>`.

## Fixture names

`fixtures/<provider>/observer/<providerVersion>/<case>.jsonl`, with `-with-extra` and `-crlf` variants and the folder's
`meta.json` (`scrubbed: true`, `capturedBy: maintainer`), as `17` §1.4 and `fixtures/README.md` fix. The OpenCode event
stream is captured with `--sse` into `<case>.jsonl` of `fixtures/opencode/observer/<version>/`.
