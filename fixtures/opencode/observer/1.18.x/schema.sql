-- The opencode.db tables the observer reads, as OpenCode 1.18.31 declares them (docs/opencode-format.md
-- Row 2). REFERENCES to tables the observer never reads are left out so the fixture stands alone.
CREATE TABLE `session` (
    `id` text PRIMARY KEY,
    `project_id` text NOT NULL,
    `workspace_id` text,
    `parent_id` text,
    `slug` text NOT NULL,
    `directory` text NOT NULL,
    `path` text,
    `title` text NOT NULL,
    `version` text NOT NULL,
    `share_url` text,
    `summary_additions` integer,
    `summary_deletions` integer,
    `summary_files` integer,
    `summary_diffs` text,
    `metadata` text,
    `cost` real DEFAULT 0 NOT NULL,
    `tokens_input` integer DEFAULT 0 NOT NULL,
    `tokens_output` integer DEFAULT 0 NOT NULL,
    `tokens_reasoning` integer DEFAULT 0 NOT NULL,
    `tokens_cache_read` integer DEFAULT 0 NOT NULL,
    `tokens_cache_write` integer DEFAULT 0 NOT NULL,
    `revert` text,
    `permission` text,
    `agent` text,
    `model` text,
    `time_created` integer NOT NULL,
    `time_updated` integer NOT NULL,
    `time_compacting` integer,
    `time_archived` integer
);

CREATE TABLE `message` (
    `id` text PRIMARY KEY,
    `session_id` text NOT NULL,
    `time_created` integer NOT NULL,
    `time_updated` integer NOT NULL,
    `data` text NOT NULL,
    CONSTRAINT `fk_message_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);

CREATE TABLE `part` (
    `id` text PRIMARY KEY,
    `message_id` text NOT NULL,
    `session_id` text NOT NULL,
    `time_created` integer NOT NULL,
    `time_updated` integer NOT NULL,
    `data` text NOT NULL,
    CONSTRAINT `fk_part_message_id_message_id_fk` FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON DELETE CASCADE
);

CREATE TABLE `event` (
    `id` text PRIMARY KEY,
    `aggregate_id` text NOT NULL,
    `seq` integer NOT NULL,
    `type` text NOT NULL,
    `data` text NOT NULL
);

CREATE UNIQUE INDEX `event_aggregate_seq_idx` ON `event` (`aggregate_id`,`seq`)
;
CREATE INDEX `event_aggregate_type_seq_idx` ON `event` (`aggregate_id`,`type`,`seq`)
;
CREATE INDEX `message_session_time_created_id_idx` ON `message` (`session_id`,`time_created`,`id`)
;
CREATE INDEX `part_message_id_id_idx` ON `part` (`message_id`,`id`)
;
CREATE INDEX `part_session_idx` ON `part` (`session_id`)
;
CREATE INDEX `session_parent_idx` ON `session` (`parent_id`)
;
CREATE INDEX `session_project_idx` ON `session` (`project_id`)
;
