# Recording scenarios

A scenario is the script of one fixture case: the files of the throwaway repository and the prompts
the recorder sends, in order. Prompts come only from here, never from free text, so no personal
content can enter a fixture (`17-testing-strategy.md` §1.4, recording step 2).

`<case>.json` names the case it records (`simple-turn.json` records `simple-turn`):

```json
{
  "case": "simple-turn",
  "description": "What the case exercises, for the person reading the fixture.",
  "repoFiles": { "README.md": "# Throwaway repository\n" },
  "turns": [{ "text": "Reply with the single word hello and nothing else. Do not use any tool." }]
}
```

| Field         | Meaning                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------- |
| `case`        | the case name; equal to the file name without `.json`                                         |
| `description` | one sentence on what the case exercises                                                       |
| `repoFiles`   | optional; relative path → text, written into the throwaway repository before its first commit |
| `turns`       | the prompts, in order; each is `{ "text": "…" }` and nothing else                             |

The recorder refuses a scenario with any other field, an empty prompt, or a file path that is
absolute or leaves the repository. Write prompts that need nothing personal to answer and that keep
the session short: every turn spends the maintainer's own provider quota.

## Recording a case (maintainer machine only)

Recording runs in the real-CLI lane, never in CI (`17` §5.5). The maintainer installs the CLI
version to record and logs in with their own account; the harness never reads a provider's
config, credential file or keychain entry (ADR-008 item 2).

```sh
RUN_INTEGRATION=1 DWARFAI_REAL_CLI=<provider> \
  node scripts/fixtures/record.mjs --provider <provider> --driver <driver> --case <case>
node scripts/fixtures/scrub.mjs fixtures/<provider>/<driver>/<version>/<case>.raw.*
```

1. `record.mjs` refuses when `CI` is set, when `RUN_INTEGRATION` is not `1` or when the provider is
   not in `DWARFAI_REAL_CLI`. It creates `<tmp>/dwarfai-rec-<n>/` with the scenario's files, runs
   the driver's recording adapter there with a tee transport, and writes the raw capture beside the
   target: `<case>.raw.jsonl` (what the CLI wrote), `<case>.raw.sent.jsonl` (what DwarfAI sent),
   `<case>.raw.timing.jsonl` (the instant of each chunk and of spawn and exit) and
   `<case>.raw.meta.json`. It then deletes the throwaway repository; a failed recording deletes its
   partial capture too.
2. `scrub.mjs` writes `<case>.jsonl` and `<case>-<stream>.jsonl`, each with its `-with-extra`
   variant and, for JSONL, its `-crlf` variant, plus `meta.json` (`scrubbed: true`, `capturedBy`
   `maintainer`) when the folder has none. It replaces the home directory, user and host name,
   paths outside the throwaway repository, e-mail addresses, the ADR-026 secret patterns, bearer
   tokens, Windows SIDs and account ids; maps provider session, message and tool-call ids to fake
   UUIDs, the same id to the same UUID across the case; and shifts every timestamp so the earliest
   lands on 2025-01-01, keeping each gap to the millisecond. When any rule would still change a
   line of its output, it prints the file, line and rule, writes nothing and exits 1. On success it
   deletes the raw capture (`--keep-raw` keeps it).
3. Read every scrubbed file before committing it (skill `privacy-guard`), fill in the capability
   values the session evidences, and write the case's `<case>.expected.json` by hand from the
   contract.

`*.raw.*` files under `fixtures/` are git-ignored and reported by the layout check; they are never
committed.

A driver issue adds its recording adapter to `RECORDING_ADAPTERS` in `record.mjs` under
`<provider>/<driver>`: `{ detect(), run({ repoDir, scenario, tee, env }) }`, where `detect()` returns
the installed `providerVersion` and the session's `capabilities`, and `run` writes what the CLI
wrote to `tee.received`, what DwarfAI sent to `tee.sent`, any other stream to `tee.stream(<name>)`,
and marks `spawned` and `exit` with `tee.mark`. When the scrub rules miss a field of its protocol,
the same issue adds the key to `PROVIDER_ID_KEYS`, `ACCOUNT_ID_KEYS` or `TIMESTAMP_KEYS` in
`lib/scrubRules.mjs`, with a test.
