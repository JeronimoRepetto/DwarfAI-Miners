-- The degradation fixture opencode-store-evidence requires: a database whose
-- tables do NOT match the measured 1.18.31 schema (opencode-schema.sql),
-- committed regardless of whether row 2 stays positive, so the "unknown
-- schema reads as no rows" contract is proven rather than assumed. Every
-- table below is renamed from its real counterpart; nothing in
-- opencode/state.ts's SQL can match any of them, so every query this
-- provider runs against a database with only this schema returns [] rather
-- than throwing (sqliteLike.ts's own error contract).

CREATE TABLE `sessions_v2` (
    `id` text PRIMARY KEY,
    `parent` text,
    `cwd` text NOT NULL
);

CREATE TABLE `messages_v2` (
    `id` text PRIMARY KEY,
    `session` text NOT NULL,
    `body` text NOT NULL
);

CREATE TABLE `parts_v2` (
    `id` text PRIMARY KEY,
    `message` text NOT NULL,
    `body` text NOT NULL
);

CREATE TABLE `events_v2` (
    `id` text PRIMARY KEY,
    `aggregate` text NOT NULL,
    `n` integer NOT NULL
);
