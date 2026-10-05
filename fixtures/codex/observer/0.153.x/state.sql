-- Synthetic Codex state database (`state_5.sqlite`), hand-written from 15 §5 for the
-- CodexObservationAdapter conformance suite (ISSUE-073). The `threads` and `thread_spawn_edges`
-- tables use the columns of the Codex 0.150.1 schema captured in
-- src/main/providers/__fixtures__/codex/state-schema.sql; the rows are invented and scrubbed.
-- Replace with a scrubbed recording of a real CODEX_HOME (ISSUE-319) when one exists.

CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    rollout_path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    source TEXT NOT NULL,
    model_provider TEXT NOT NULL,
    cwd TEXT NOT NULL,
    title TEXT NOT NULL,
    sandbox_policy TEXT NOT NULL,
    approval_mode TEXT NOT NULL,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    has_user_event INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    archived_at INTEGER,
    git_sha TEXT,
    git_branch TEXT,
    git_origin_url TEXT,
    cli_version TEXT NOT NULL DEFAULT '',
    first_user_message TEXT NOT NULL DEFAULT '',
    agent_nickname TEXT,
    agent_role TEXT,
    memory_mode TEXT NOT NULL DEFAULT 'enabled',
    model TEXT,
    reasoning_effort TEXT,
    agent_path TEXT,
    created_at_ms INTEGER,
    updated_at_ms INTEGER,
    thread_source TEXT,
    preview TEXT NOT NULL DEFAULT '',
    recency_at INTEGER NOT NULL DEFAULT 0,
    recency_at_ms INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE thread_spawn_edges (
    parent_thread_id TEXT NOT NULL,
    child_thread_id TEXT NOT NULL PRIMARY KEY,
    status TEXT NOT NULL
);

INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, cli_version, created_at_ms, updated_at_ms)
VALUES ('01a0b000-0000-7000-8000-000000000731', 'C:\Users\j\.codex\sessions\2026\09\30\rollout-placeholder-731.jsonl', 1790762399, 1790762462, 'cli', 'openai', '\\?\C:\Users\j\Desktop\Sample-Project', 'Placeholder title', 'workspace-write', 'on-request', '0.153.4', 1790762399000, 1790762462200);

INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, cli_version, agent_nickname, agent_path, created_at_ms, updated_at_ms)
VALUES ('01a0b000-0000-7000-8000-000000000732', '/home/j/.codex/sessions/2026/09/30/rollout-placeholder-732.jsonl', 1790765999, 1790766061, '{"subagent":{"thread_spawn":{"parent_thread_id":"01a0b000-0000-7000-8000-000000000731","depth":1,"agent_nickname":"Placeholder","agent_path":"/root/placeholder_agent"}}}', 'openai', '/home/j/work/sample-project', 'Placeholder title', 'workspace-write', 'on-request', '0.153.4', 'Placeholder', '/root/placeholder_agent', 1790765999000, NULL);

INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, archived, archived_at, cli_version)
VALUES ('01a0b000-0000-7000-8000-000000000735', 'C:\Users\j\.codex\sessions\2026\08\01\rollout-placeholder-735.jsonl', 1785571200, 1785571300, 'vscode', 'openai', 'C:\Users\j\Desktop\Old-Project', 'Placeholder title', 'read-only', 'never', 1, 1785571400, '0.150.1');

INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, cli_version)
VALUES ('01a0b000-0000-7000-8000-000000000736', 'C:\Users\j\.codex\sessions\2026\09\30\rollout-placeholder-736.jsonl', 1790776800, 1790776800, 'exec', 'openai', '\\?\UNC\placeholder-host\share\sample-project', 'Placeholder title', 'workspace-write', 'never', '0.149.0');

INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id, status)
VALUES ('01a0b000-0000-7000-8000-000000000731', '01a0b000-0000-7000-8000-000000000732', 'completed');
